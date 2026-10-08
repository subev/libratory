#!/usr/bin/env python3
"""BgTTS-38M-V2 (beleata74, Apache-2.0): a 38M encoder-decoder over MioCodec, Bulgarian + English.

Runs in its own venv (.venv-bgtts): MioCodec needs torchaudio, which stops at 2.9.x while the main
env pins torch 2.13. CPU by default — measured ~11x realtime on an M-series Mac, so the GPU buys
little and stays free for Kokoro and BGE-M3.

The model's code ships in the HF repo beside the weights, so it is imported from the pinned
snapshot rather than vendored. The three voices are the reference clips the authors ship; the
speaker embedding is taken from them at load.

Word timings come from the model's own cross-attention over the codes it produced
(attention_words.py), written beside each chunk WAV as Piper's and Kokoro's are.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bg_speech import speakable  # noqa: E402
from attention_words import chunk_words, piece_attention, spoken_words, voiced_frames  # noqa: E402
from chunk_io import load_existing_chunk, read_chunks, write_chunk_manifest, write_chunk_words  # noqa: E402

MODEL_REPO = "beleata74/BgTTS-38M-V2"
MODEL_REVISION = "3f6ca06b3ca78352eb00d8e96349c0bedaa3d2f1"
CODEC_REPO = "Aratako/MioCodec-25Hz-24kHz"
VOICES = {
    "female": "samples/sample_female_bg1.wav",
    "male": "samples/sample_male_bg1.wav",
    "male2": "samples/sample_male2_bg1.wav",
}
SNAPSHOT_PATTERNS = ["*.py", "checkpoint_inference.pt", *VOICES.values()]
PAUSE_MS = 250
SEED = 555
# The model card's recommendation: 0.3 is stable, 0.5-0.7 more expressive and less predictable
TEMPERATURE = 0.3
SAMPLE_RATE = 24000


def snapshot(local_only: bool) -> Path:
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(
        MODEL_REPO, revision=MODEL_REVISION, allow_patterns=SNAPSHOT_PATTERNS, local_files_only=local_only,
    ))


def cache_only() -> None:
    # MioCodec pulls WavLM base+ through torch hub on first load; loading the codec once fetches it
    from huggingface_hub import snapshot_download
    model_dir = snapshot(local_only=False)
    snapshot_download(CODEC_REPO)
    sys.path.insert(0, str(model_dir))
    from codec import CodecV6
    CodecV6(device="cpu")
    print(json.dumps({"type": "cached", "path": str(model_dir)}), flush=True)








def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize Bulgarian text to WAV using BgTTS-38M-V2")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--voice")
    parser.add_argument("--chunks-dir", default=None)
    parser.add_argument("--cache-only", action="store_true", help="Download the model, codec and WavLM, then exit")
    args = parser.parse_args()

    if args.cache_only:
        cache_only()
        return
    if not (args.input and args.output and args.voice):
        parser.error("--input, --output and --voice are required")
    if args.voice not in VOICES:
        raise RuntimeError(f"Unsupported BgTTS voice: {args.voice}")

    local_only = os.environ.get("HF_HUB_OFFLINE") == "1"
    try:
        model_dir = snapshot(local_only)
    except Exception as exc:
        raise RuntimeError("BgTTS-38M-V2 is not downloaded — run `pnpm run setup` and accept the BgTTS step") from exc
    sys.path.insert(0, str(model_dir))
    from model import CrossAttention, load_for_inference
    from tokenizer import TTSTokenizer
    from codec import CodecV6
    from inference import generate, _split_text

    device = "cpu"
    model = load_for_inference(str(model_dir / "checkpoint_inference.pt"), device=device)
    tokenizer = TTSTokenizer()
    codec = CodecV6(device=device)
    speaker = codec.encode(str(model_dir / VOICES[args.voice]))["global_embedding"].to(device)
    max_len = min(250, model.config.max_text_len)

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    audio_parts: list[np.ndarray] = []
    for index, chunk in enumerate(chunks, start=1):
        waveform = load_existing_chunk(args.chunks_dir, index, needs_words=True)
        if waveform is None:
            torch.manual_seed(SEED + index)
            # Expanding numbers can push a sentence past the encoder's 256 characters
            codes, timed_pieces = [], []
            for piece in _split_text(speakable(chunk), tokenizer, max_len):
                piece_codes = generate(model, tokenizer, piece, speaker, temperature=TEMPERATURE, device=device)
                if piece_codes is None or len(piece_codes) == 0:
                    raise RuntimeError(f"No audio generated for chunk {index}: {piece[:60]!r}")
                codes.append(piece_codes)
                if args.chunks_dir:
                    attention = piece_attention(model, CrossAttention, tokenizer, piece, piece_codes, speaker)
                    timed_pieces.append((attention, *spoken_words(tokenizer, piece)))
            waveform = codec.decode(torch.cat(codes), speaker).numpy().astype(np.float32)
            if args.chunks_dir:
                os.makedirs(args.chunks_dir, exist_ok=True)
                sf.write(os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav"), waveform, SAMPLE_RATE)
                write_chunk_words(args.chunks_dir, index, chunk_words(chunk, timed_pieces, voiced_frames(waveform, SAMPLE_RATE)))

        audio_parts.append(waveform)
        if index < len(chunks):
            audio_parts.append(np.zeros(int(SAMPLE_RATE * PAUSE_MS / 1000), dtype=np.float32))

        total_seconds = round(sum(len(part) for part in audio_parts) / SAMPLE_RATE, 1)
        print(json.dumps({"type": "progress", "chunk": index, "totalChunks": len(chunks), "audioSeconds": total_seconds}), flush=True)

    full_audio = np.concatenate(audio_parts).astype(np.float32)
    sf.write(args.output, full_audio, SAMPLE_RATE)
    print(json.dumps({"type": "done", "audioSeconds": round(len(full_audio) / SAMPLE_RATE, 1), "chunks": len(chunks)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
