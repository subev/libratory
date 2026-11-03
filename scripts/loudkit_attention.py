"""Word timings for loudkit (loudr-1, loudr-1-turbo) from its token generator's own self-attention.

loudkit's generator is a Llama decoder over one sequence, [cond | START text STOP | speech…], and a
few of its 256 heads (16 layers × 16) read the text along a clean diagonal while it speaks: the text
token they look at is the one being said. Recording those heads over the framed text span on every
decode step, then taking the monotonic path through their average, gives each spoken word the step
it starts on. loudkit's own word times (Result.chunks[].words) are letter-count estimates and are
not used.

The heads are read alongside the generator's own attention call, which is left as it is, so the
audio is the same with timings as without. `capture` patches the attention forward and the
generate call for the duration of a block, as attention_words.capture does for BgTTS.
"""

import math
import threading
from contextlib import contextmanager

import numpy as np

from phoneme_words import written_word_spans, _IS_WORD, MIN_PLACED

# Pinned to the model revision the heads were chosen on; a new revision means scanning again
# (packages/server/spikes/loudkit-alignment, tasks/forced-alignment.md). Flat head index =
# layer * 16 + head. Heads 9.7, 9.12 (loudr-1) and 10.1 (turbo) also trace the text, but 0.2-0.3 s
# ahead of the voice, so averaging them in pulls every start early. offset_ms is the shift that
# centres the rest on SpeechTranscriber's word onsets.
MODELS = {
    "loudreader/loudr-1": {
        "revision": "7516673ee74ab2228ffc4e99223d296d8904d7ff",
        "heads": [6 * 16 + 9, 10 * 16 + 10],
        "offset_ms": 50,
    },
    "loudreader/loudr-1-turbo": {
        "revision": "366f140a5f7ebe215e5b43cdd73384746c83bae6",
        "heads": [6 * 16 + 9, 6 * 16 + 10, 6 * 16 + 11],
        "offset_ms": 200,
    },
}
# Furthest the path may move along the text in one decode step. A step is 40 ms (80 ms for turbo,
# which decodes two tokens per step); spaces and punctuation take no time at all.
MAX_JUMP = 3


class _Recording(threading.local):
    def __init__(self):
        self.span = None  # (start, stop) of the framed text in the sequence, while a generate runs
        self.heads = None  # flat indices to record; None records all
        self.step = None  # this decode step's rows, one per layer, as the layers run
        self.rows = []


_rec = _Recording()


def _decode_weights(module, q, k, layer):
    """[heads, span] softmax of one decode step's query over the framed text, for this layer's
    recorded heads (the rest left zero)."""
    start, stop = _rec.span
    n_heads = module.n_heads
    wanted = list(range(n_heads)) if _rec.heads is None else [f - layer * n_heads for f in _rec.heads if f // n_heads == layer]
    row = np.zeros((n_heads, stop - start), dtype=np.float16)
    if wanted:
        # [wanted, 1, dim] @ [wanted, dim, seq]: the same scores the attention call softmaxes
        scores = (q[0, wanted].float() @ k[0, wanted].float().transpose(-2, -1))[:, 0] / math.sqrt(module.head_dim)
        row[wanted] = scores.softmax(-1)[:, start:stop].cpu().numpy()
    return row


@contextmanager
def capture(engine, heads=None):
    """Record attention while `engine` generates. Yields a list that gains one entry per generate
    call (retries included): {"text_tokens", "tokens", "attention": [steps, layers*heads, span]}."""
    import torch
    import torch.nn.functional as F
    from loudkit.models import generator as G

    generator = engine.token_generator
    for index, layer in enumerate(generator.tfmr.layers):
        layer.self_attn._probe_layer = index
    n_layers = len(generator.tfmr.layers)
    attempts = []
    original_forward = G._Attention.forward
    original_generate = G.TorchTokenGenerator.generate

    def forward(self, x, cos, sin, cache, *, causal, attention):
        # The original body, unchanged, with the recorded heads read off q and k on decode steps
        b, t, _ = x.shape
        q = self.q_proj(x).view(b, t, self.n_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(b, t, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(b, t, self.n_kv_heads, self.head_dim).transpose(1, 2)
        q = q * cos + G._rotate_half(q) * sin
        k = k * cos + G._rotate_half(k) * sin
        if cache is not None:
            k = torch.cat([cache[0], k], dim=2)
            v = torch.cat([cache[1], v], dim=2)
        new_cache = (k, v)
        rep = self.n_heads // self.n_kv_heads
        k = k.repeat_interleave(rep, dim=1)
        v = v.repeat_interleave(rep, dim=1)
        layer = getattr(self, "_probe_layer", None)
        if _rec.span is not None and t == 1 and layer is not None:
            if layer == 0:
                _rec.step = []
            _rec.step.append(_decode_weights(self, q, k, layer))
            if layer == n_layers - 1:
                _rec.rows.append(np.concatenate(_rec.step))
        if attention == "sdpa":
            out = F.scaled_dot_product_attention(q, k, v, is_causal=causal and t > 1)
        else:
            scores = q @ k.transpose(-2, -1) / math.sqrt(self.head_dim)
            if causal and t > 1:
                mask = torch.full((t, k.shape[2]), float("-inf"), device=x.device, dtype=scores.dtype).triu(k.shape[2] - t + 1)
                scores = scores + mask
            out = torch.softmax(scores, dim=-1, dtype=torch.float32).to(q.dtype) @ v
        out = out.transpose(1, 2).contiguous().view(b, t, -1)
        return self.o_proj(out), new_cache

    def generate(self, text_tokens, voice, **kwargs):
        if self is not generator:
            return original_generate(self, text_tokens, voice, **kwargs)
        framed = len(text_tokens) + 2
        cond = self._prefill_embeds(text_tokens, voice).shape[1] - framed - 1
        _rec.span, _rec.heads, _rec.rows = (cond, cond + framed), heads, []
        try:
            tokens = original_generate(self, text_tokens, voice, **kwargs)
        finally:
            rows, _rec.span, _rec.rows = _rec.rows, None, []
        attempts.append({
            "text_tokens": [int(t) for t in text_tokens],
            "tokens": [int(t) for t in tokens],
            "attention": np.stack(rows) if rows else np.zeros((0, n_layers * self.tfmr.layers[0].self_attn.n_heads, framed), np.float16),
        })
        return tokens

    G._Attention.forward = forward
    G.TorchTokenGenerator.generate = generate
    try:
        yield attempts
    finally:
        G._Attention.forward = original_forward
        G.TorchTokenGenerator.generate = original_generate


def shipped_attempt(attempts, speech, limit):
    """The recorded generate whose tokens became this window's speech, removing it and every attempt
    before it. A retried window ships its best attempt, not its last, and a trimmed one ships a
    prefix; specials (ids ≥ limit) are dropped before shipping."""
    for index in range(len(attempts) - 1, -1, -1):
        kept = [t for t in attempts[index]["tokens"] if t < limit]
        if kept[: len(speech)] == list(speech):
            found = attempts[index]
            del attempts[: index + 1]
            return found
    return None


def word_groups(text_tokens, space_token):
    """Framed position of each spoken word's first token: framed = [START] + tokens + [STOP], and
    tokens[0] is the language tag."""
    groups, in_word = [], False
    for i, token in enumerate(text_tokens[1:], start=1):
        if token == space_token:
            in_word = False
        elif not in_word:
            groups.append(i + 1)
            in_word = True
    return groups


def monotonic_path(attention, max_jump=MAX_JUMP):
    """The text position each step reads: the path through attention [steps, text] holding the most
    attention while moving forward by at most max_jump a step."""
    cost = -np.log(attention + 1e-6)
    steps, text = cost.shape
    total = np.full((steps, text), np.inf)
    back = np.zeros((steps, text), dtype=np.int64)
    total[0, : min(3, text)] = cost[0, : min(3, text)]
    for i in range(1, steps):
        options = np.full((max_jump + 1, text), np.inf)
        for jump in range(min(max_jump, text - 1) + 1):
            options[jump, jump:] = total[i - 1, : text - jump]
        back[i] = options.argmin(0)
        total[i] = cost[i] + options.min(0)
    path = np.zeros(steps, dtype=np.int64)
    path[-1] = int(np.argmin(total[-1]))
    for i in range(steps - 1, 0, -1):
        path[i - 1] = path[i] - back[i, path[i]]
    return path


def word_starts(attempt, heads, n_speech, duration_s, space_token, offset_ms=0):
    """Start (seconds into the window) of each spoken word, or None when the trace cannot carry it."""
    attention = attempt["attention"].astype(np.float32)
    steps = attention.shape[0]
    groups = word_groups(attempt["text_tokens"], space_token)
    if steps < 3 or not groups:
        return None
    mean = attention[:, heads, :].mean(1)
    mean /= mean.sum(1, keepdims=True) + 1e-9
    path = monotonic_path(mean)
    # A step covers one generated token, or two under turbo's paired decode
    per_step = 2.0 if n_speech / steps > 1.5 else 1.0
    seconds_per_token = duration_s / max(n_speech, 1)
    starts = []
    for position in groups:
        reached = np.nonzero(path >= position)[0]
        step = int(reached[0]) if len(reached) else steps - 1
        starts.append(min(duration_s, max(0.0, step * per_step * seconds_per_token + offset_ms / 1000)))
    return starts


def chunk_words(written_text, windows, voiced, frame_ms):
    """ChunkWord dicts (text as written, chunk-relative ms) for one chunk, or [] when unreliable.

    windows: per loudkit window of the chunk, in order, (spoken text, word starts in seconds or None,
    window start in seconds). loudkit reads its own expansion of the text ("3" as "three"), so its
    words are carried back to the written ones as phoneme_words does. voiced: voiced_frames of the
    chunk's audio, frame_ms apart. A window whose trace failed leaves the chunk untimed rather than
    guessed.
    """
    spoken, starts_ms, firsts = [], [], set()
    for text, starts, offset in windows:
        words = text.split()
        if starts is None or len(starts) != len(words):
            return []
        firsts.add(len(spoken))
        spoken += words
        # A window's first word is where its voice begins: attention reaches the first token during
        # the leading silence, and the offset then lands the word after the voice has started
        starts_ms += [round(offset * 1000)] + [round((offset + s) * 1000) for s in starts[1:]]
    if not spoken:
        return []

    def is_voiced(ms):
        frame = ms // frame_ms
        return 0 <= frame < len(voiced) and voiced[frame]

    # Pushed to where the voice begins. Only a window's first word: inside speech, a word opening on
    # a quiet consonant (s, f, t) reads as silence and was moved late (measured)
    for i in sorted(firsts):
        start = starts_ms[i]
        limit = starts_ms[i + 1] if i + 1 < len(starts_ms) else len(voiced) * frame_ms
        while start < limit and not is_voiced(start):
            start += frame_ms
        starts_ms[i] = min(start, limit)
    voiced_at = np.nonzero(voiced)[0]
    last_voice_ms = int(voiced_at[-1] + 1) * frame_ms if len(voiced_at) else len(voiced) * frame_ms
    spans = [(s, starts_ms[i + 1] if i + 1 < len(starts_ms) else max(s, last_voice_ms)) for i, s in enumerate(starts_ms)]

    written = written_text.split()
    placed = written_word_spans(written, spoken, spans)
    lettered = [i for i, t in enumerate(written) if _IS_WORD.search(t)]
    if not lettered or sum(placed[i] is not None for i in lettered) / len(lettered) < MIN_PLACED:
        return []
    out, previous_end = [], 0
    for index, token in enumerate(written):
        start, end = placed[index] if placed[index] else (previous_end, previous_end)
        start, end = max(start, previous_end), max(end, previous_end)
        out.append({"text": token, "after": " " if index < len(written) - 1 else "", "startMs": start, "endMs": end})
        previous_end = end
    return out
