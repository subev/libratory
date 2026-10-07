#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

from chunk_io import load_existing_chunk, read_chunks, write_chunk_manifest


PAUSE_MS = 250
SAMPLE_RATE = 22050
DATA_FORMAT = f"LEI16@{SAMPLE_RATE}"








def synthesize_chunk_audio(say_voice: str, text: str, wav_path: str, rate: int | None) -> np.ndarray:
    cmd = ["say", "-v", say_voice, "-o", wav_path, f"--data-format={DATA_FORMAT}", "-f", "-"]
    if rate:
        cmd += ["-r", str(rate)]
    result = subprocess.run(cmd, input=text.encode("utf-8"), capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"say failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    data, _ = sf.read(wav_path, dtype="float32")
    if len(data) == 0:
        raise RuntimeError("No audio was generated")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize text to WAV using the macOS system voice")
    parser.add_argument("--input", required=True, help="Path to chunked input text file")
    parser.add_argument("--output", required=True, help="Path to output WAV file")
    parser.add_argument("--voice", required=True, help="Full macOS voice name, e.g. 'Daria (Enhanced)'")
    parser.add_argument("--chunks-dir", default=None, help="Optional directory to persist per-chunk WAV previews")
    parser.add_argument("--rate", type=int, default=None, help="Speech rate in words per minute")
    args = parser.parse_args()

    say_voice = args.voice

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    audio_parts: list[np.ndarray] = []

    with tempfile.TemporaryDirectory() as tmp_dir:
        for index, chunk in enumerate(chunks, start=1):
            waveform = load_existing_chunk(args.chunks_dir, index)
            if waveform is None:
                if args.chunks_dir:
                    os.makedirs(args.chunks_dir, exist_ok=True)
                    wav_path = os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav")
                else:
                    wav_path = os.path.join(tmp_dir, f"chunk-{index:03d}.wav")
                waveform = synthesize_chunk_audio(say_voice, chunk, wav_path, args.rate)

            audio_parts.append(waveform)
            if index < len(chunks):
                silence = np.zeros(int(SAMPLE_RATE * PAUSE_MS / 1000), dtype=np.float32)
                audio_parts.append(silence)

            total_samples = sum(len(part) for part in audio_parts)
            total_seconds = round(total_samples / SAMPLE_RATE, 1)
            print(json.dumps({
                "type": "progress",
                "chunk": index,
                "totalChunks": len(chunks),
                "audioSeconds": total_seconds,
            }), flush=True)

    if not audio_parts:
        raise RuntimeError("No audio chunks were produced")

    full_audio = np.concatenate(audio_parts).astype(np.float32)
    sf.write(args.output, full_audio, SAMPLE_RATE)
    total_seconds = round(len(full_audio) / SAMPLE_RATE, 1)
    print(json.dumps({
        "type": "done",
        "audioSeconds": total_seconds,
        "chunks": len(chunks),
    }), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
