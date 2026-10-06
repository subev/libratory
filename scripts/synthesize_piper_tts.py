#!/usr/bin/env python3
"""Piper (piper-tts, GPL-3.0, run as a subprocess) with the Bulgarian `dimitar` voice (CC0).

Runs in its own venv (.venv-piper): onnxruntime and numpy 2 must not touch the main env's pins.
ONNX on the CPU, ~20x realtime, and the one local Bulgarian engine with working speed control
(`length_scale` = 1 / speed). espeak-ng, bundled in the wheel, expands digits in any language;
bg_speech still runs first for dates, currency and abbreviations, which espeak reads letter by letter.

Every chunk also gets word timings from Piper's own phoneme durations (phoneme_words.py), written
beside the chunk WAV as Kokoro's are, so the read-along lights words, not just sentences.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bg_speech import speakable  # noqa: E402
from phoneme_words import chunk_words  # noqa: E402
from chunk_io import load_existing_chunk, read_chunks, write_chunk_manifest, write_chunk_words  # noqa: E402

VOICE_REPO = "rhasspy/piper-voices"
VOICE_REVISION = "6249c8a9178e606f0de19227d5426e5dfaf9fc9e"
VOICES = {"dimitar": "bg/bg_BG/dimitar/medium/bg_BG-dimitar-medium"}
PAUSE_MS = 250


def voice_files(voice: str, local_only: bool) -> Path:
    from huggingface_hub import hf_hub_download
    stem = VOICES[voice]
    hf_hub_download(VOICE_REPO, f"{stem}.onnx.json", revision=VOICE_REVISION, local_files_only=local_only)
    return Path(hf_hub_download(VOICE_REPO, f"{stem}.onnx", revision=VOICE_REVISION, local_files_only=local_only))










def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize Bulgarian text to WAV using Piper")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--voice")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--chunks-dir", default=None)
    parser.add_argument("--cache-only", action="store_true", help="Download every catalog voice, then exit")
    args = parser.parse_args()

    if args.cache_only:
        for voice in VOICES:
            voice_files(voice, local_only=False)
        print(json.dumps({"type": "cached"}), flush=True)
        return
    if not (args.input and args.output and args.voice):
        parser.error("--input, --output and --voice are required")
    if args.voice not in VOICES:
        raise RuntimeError(f"Unsupported Piper voice: {args.voice}")
    if not 0.25 <= args.speed <= 4:
        raise RuntimeError(f"Speed out of range: {args.speed}")

    from piper import PiperVoice, SynthesisConfig

    local_only = os.environ.get("HF_HUB_OFFLINE") == "1"
    try:
        model_path = voice_files(args.voice, local_only)
    except Exception as exc:
        raise RuntimeError("The Piper Bulgarian voice is not downloaded — run `pnpm run setup`") from exc
    # Patches the graph in memory to return per-phoneme sample counts; without the onnx package it
    # loads unpatched and every chunk simply has no word timings
    voice = PiperVoice.load(str(model_path), include_alignments=True)

    def phonemize_word(token: str) -> str:
        return "".join("".join(sentence) for sentence in voice.phonemize(token))
    sample_rate = voice.config.sample_rate
    config = SynthesisConfig(length_scale=1 / args.speed)

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    audio_parts: list[np.ndarray] = []
    for index, chunk in enumerate(chunks, start=1):
        # A chunk spoken before word timings existed is spoken again; Piper does it in a fraction of a second
        waveform = load_existing_chunk(args.chunks_dir, index, needs_words=True)
        if waveform is None:
            spoken = speakable(chunk)
            pieces, timed = [], []
            offset = 0
            for part in voice.synthesize(spoken, syn_config=config, include_alignments=True):
                for alignment in part.phoneme_alignments or []:
                    timed.append((alignment.phoneme, offset, offset + int(alignment.num_samples)))
                    offset += int(alignment.num_samples)
                # The sentence's own length is the truth; its phoneme counts must not drift past it
                offset = sum(len(p) for p in pieces) + len(part.audio_float_array)
                pieces.append(part.audio_float_array)
            if not pieces:
                raise RuntimeError(f"No audio generated for chunk {index}")
            waveform = np.concatenate(pieces).astype(np.float32)
            if args.chunks_dir:
                os.makedirs(args.chunks_dir, exist_ok=True)
                sf.write(os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav"), waveform, sample_rate)
                try:
                    words = chunk_words(chunk, spoken, phonemize_word, timed, sample_rate)
                except Exception as exc:  # timings are a bonus; a failure costs them, not the chapter
                    print(f"word timings failed for chunk {index}: {exc}", file=sys.stderr)
                    words = []
                write_chunk_words(args.chunks_dir, index, words)

        audio_parts.append(waveform)
        if index < len(chunks):
            audio_parts.append(np.zeros(int(sample_rate * PAUSE_MS / 1000), dtype=np.float32))

        total_seconds = round(sum(len(part) for part in audio_parts) / sample_rate, 1)
        print(json.dumps({"type": "progress", "chunk": index, "totalChunks": len(chunks), "audioSeconds": total_seconds}), flush=True)

    full_audio = np.concatenate(audio_parts).astype(np.float32)
    sf.write(args.output, full_audio, sample_rate)
    print(json.dumps({"type": "done", "audioSeconds": round(len(full_audio) / sample_rate, 1), "chunks": len(chunks)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
