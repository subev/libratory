"""Word timings for BgTTS-38M-V2 from its own cross-attention — no aligner, no second model.

BgTTS writes audio 25 frames a second, and to choose each frame its decoder attends to the text.
Three of its 48 heads (HEADS) follow the text along a clean diagonal: the letter they look at is the
letter being said. Recording them over the codes the model just produced — one causal pass
reproduces exactly the attention it had while generating — and taking the monotonic path through
them gives every spoken word a span of frames.

The model's attention call fuses the softmax and keeps no weights, so `capture` swaps the
cross-attention forward for an explicit one while the pass runs. Measured on 30 Bulgarian sentences
against Piper's duration-exact timings (tasks/forced-alignment.md): word starts median 49 ms off,
77% within 100 ms. A frame is 40 ms, which is the floor.
"""

import math
import re
from contextlib import contextmanager

import numpy as np

from phoneme_words import written_word_spans, _IS_WORD, MIN_PLACED

# (layer, head), chosen against Piper's timings; the same three ranked best on either half of the set
HEADS = [(2, 4), (3, 2), (5, 5)]
FRAME_MS = 40
# Furthest the path may move along the text in one frame: speech runs about half a letter a frame,
# but spaces and punctuation take no time at all
MAX_JUMP = 4
# A frame quieter than this below the chunk's loudest is silence; a word does not start in silence
SILENCE_DB = -35


@contextmanager
def capture(cross_attention_class):
    """Record every cross-attention weight matrix computed inside the block, in call order."""
    import torch

    original = cross_attention_class.forward
    recorded = []

    def forward(self, x, encoder_output, encoder_mask=None, cached_kv=None, use_cache=False):
        B, T, _ = x.shape
        q = self.q_proj(x).view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        if cached_kv is not None:
            k, v = cached_kv
        else:
            T_enc = encoder_output.shape[1]
            k = self.k_proj(encoder_output).view(B, T_enc, self.n_heads, self.head_dim).transpose(1, 2)
            v = self.v_proj(encoder_output).view(B, T_enc, self.n_heads, self.head_dim).transpose(1, 2)
        scores = q @ k.transpose(-2, -1) / math.sqrt(self.head_dim)
        if encoder_mask is not None:
            scores = scores.masked_fill((encoder_mask == 0).unsqueeze(1).unsqueeze(2), float("-inf"))
        weights = scores.softmax(-1)
        recorded.append(weights[0].detach())
        out = (weights @ v).transpose(1, 2).contiguous().view(B, -1, self.d_model)
        return self.o_proj(out), ((k, v) if use_cache else None)

    cross_attention_class.forward = forward
    try:
        yield recorded
    finally:
        cross_attention_class.forward = original


def piece_attention(model, cross_attention_class, tokenizer, piece, codes, speaker):
    """[layers, heads, frames, text] attention the model gives `piece` while producing `codes`."""
    import torch
    from config import START_OF_SPEECH_TOKEN_ID, AUDIO_OFFSET

    enc_ids = tokenizer.build_encoder_input(piece).unsqueeze(0)
    enc_mask = torch.ones_like(enc_ids)
    dec_ids = torch.cat([torch.tensor([START_OF_SPEECH_TOKEN_ID]), codes + AUDIO_OFFSET]).unsqueeze(0)
    with capture(cross_attention_class) as recorded, torch.no_grad():
        enc_out = model.encode(enc_ids, enc_mask)
        model.decoder(input_ids=dec_ids, encoder_output=enc_out, encoder_mask=enc_mask, speaker_emb=speaker.unsqueeze(0))
    # Row p is the step that chose code p, i.e. audio frame p; the last row chose <eos>
    return torch.stack(recorded)[:, :, : len(codes), :].float().numpy()


def spoken_words(tokenizer, piece):
    """The piece's words as the encoder reads them, each with its first and last encoder position."""
    norm = tokenizer.normalize_text(piece)
    enc_pos, k = {}, 0
    for i, ch in enumerate(norm):
        if ch in tokenizer.char2id:
            k += 1  # position 0 is <sot>
            enc_pos[i] = k
    words, ranges = [], []
    for m in re.finditer(r"\S+", norm):
        positions = [enc_pos[i] for i in range(m.start(), m.end()) if i in enc_pos]
        if positions:
            words.append(m.group())
            ranges.append((positions[0], positions[-1]))
    return words, ranges


def monotonic_path(attn):
    """The text position each frame reads: the path through attn [frames, text] that holds the most
    attention while only ever moving forward, from <sot> to (nearly) <eot>."""
    cost = -np.log(attn + 1e-6)
    frames, text = cost.shape
    total = np.full((frames, text), np.inf)
    back = np.zeros((frames, text), dtype=np.int64)
    total[0, 0] = cost[0, 0]
    for i in range(1, frames):
        options = np.full((MAX_JUMP + 1, text), np.inf)
        for jump in range(MAX_JUMP + 1):
            options[jump, jump:] = total[i - 1, : text - jump]
        back[i] = options.argmin(0)
        total[i] = cost[i] + options.min(0)
    path = np.zeros(frames, dtype=np.int64)
    # <eot> and the closing period are often never attended, so the path may end just short of them
    path[-1] = text - 1 - int(np.argmin(total[-1, ::-1][:3]))
    for i in range(frames - 1, 0, -1):
        path[i - 1] = path[i] - back[i, path[i]]
    return path


def voiced_frames(waveform, sample_rate):
    hop = sample_rate * FRAME_MS // 1000
    frames = len(waveform) // hop
    rms = np.sqrt((np.asarray(waveform[: frames * hop], dtype=np.float32).reshape(frames, hop) ** 2).mean(1)) + 1e-9
    return 20 * np.log10(rms / rms.max()) > SILENCE_DB


def chunk_words(written_text, pieces, voiced, heads=HEADS):
    """ChunkWord dicts (text as written, chunk-relative ms), or [] when unreliable.

    pieces: per piece of the chunk, in order, (attention [layers, heads, frames, text], words, ranges)
    as piece_attention and spoken_words return them. voiced: voiced_frames of the chunk's audio.
    """
    spoken, spoken_spans, offset = [], [], 0
    for attention, words, ranges in pieces:
        path = monotonic_path(np.mean([attention[layer, head] for layer, head in heads], axis=0))
        for word, (first, last) in zip(words, ranges):
            reached, passed = np.nonzero(path >= first)[0], np.nonzero(path > last)[0]
            start = offset + (int(reached[0]) if len(reached) else len(path))
            end = offset + (int(passed[0]) if len(passed) else len(path))
            while start < min(end, len(voiced)) and not voiced[start]:
                start += 1
            spoken.append(word)
            spoken_spans.append((start * FRAME_MS, max(end, start) * FRAME_MS))
        offset += attention.shape[2]

    written = written_text.split()
    spans = written_word_spans(written, spoken, spoken_spans)
    lettered = [i for i, t in enumerate(written) if _IS_WORD.search(t)]
    if not lettered or sum(spans[i] is not None for i in lettered) / len(lettered) < MIN_PLACED:
        return []
    words, previous_end = [], 0
    for index, token in enumerate(written):
        start, end = spans[index] if spans[index] else (previous_end, previous_end)
        start, end = max(start, previous_end), max(end, previous_end)
        words.append({"text": token, "after": " " if index < len(written) - 1 else "", "startMs": start, "endMs": end})
        previous_end = end
    return hold_through_voice(words, voiced)


def hold_through_voice(words, voiced):
    """Attention leaves a word for the space or <eot> after it while the word is still sounding, so
    each end runs on through voiced frames, never past the next word's start."""
    for index, word in enumerate(words):
        limit = words[index + 1]["startMs"] if index + 1 < len(words) else len(voiced) * FRAME_MS
        frame = word["endMs"] // FRAME_MS
        while frame < len(voiced) and voiced[frame] and (frame + 1) * FRAME_MS <= limit:
            frame += 1
        word["endMs"] = max(word["endMs"], frame * FRAME_MS)
    return words
