#!/usr/bin/env python3

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from transformers import AutoTokenizer, VitsModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bg_speech import speakable  # noqa: E402
from chunk_io import load_existing_chunk, read_chunks, write_chunk_manifest  # noqa: E402


MODEL_ID = "facebook/mms-tts-bul"
VOICE_IDS = {"bul"}
PAUSE_MS = 250
SEED = 555








def select_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize Bulgarian text to WAV using Meta MMS")
    parser.add_argument("--input", required=True, help="Path to chunked input text file")
    parser.add_argument("--output", required=True, help="Path to output WAV file")
    parser.add_argument("--voice", required=True, help="Voice name")
    parser.add_argument("--chunks-dir", default=None, help="Optional directory to persist per-chunk WAV previews")
    args = parser.parse_args()

    if args.voice not in VOICE_IDS:
        raise RuntimeError(f"Unsupported Meta MMS voice: {args.voice}")

    local_only = os.environ.get("HF_HUB_OFFLINE") == "1"
    device = select_device()
    torch.manual_seed(SEED)

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, local_files_only=local_only)
    model = VitsModel.from_pretrained(MODEL_ID, local_files_only=local_only).to(device)
    model.eval()

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    audio_parts: list[np.ndarray] = []
    sample_rate = int(model.config.sampling_rate)

    for index, chunk in enumerate(chunks, start=1):
        waveform = load_existing_chunk(args.chunks_dir, index)
        if waveform is None:
            inputs = tokenizer(speakable(chunk), return_tensors="pt")
            inputs = {name: tensor.to(device) for name, tensor in inputs.items()}

            with torch.no_grad():
                waveform = model(**inputs).waveform.squeeze(0).detach().to("cpu").float().numpy()

            if args.chunks_dir:
                os.makedirs(args.chunks_dir, exist_ok=True)
                sf.write(os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav"), waveform, sample_rate)

        audio_parts.append(waveform)
        if index < len(chunks):
            silence = np.zeros(int(sample_rate * PAUSE_MS / 1000), dtype=np.float32)
            audio_parts.append(silence)

        total_samples = sum(len(part) for part in audio_parts)
        total_seconds = round(total_samples / sample_rate, 1)
        print(json.dumps({
            "type": "progress",
            "chunk": index,
            "totalChunks": len(chunks),
            "audioSeconds": total_seconds,
        }), flush=True)

    if not audio_parts:
        raise RuntimeError("No audio chunks were produced")

    full_audio = np.concatenate(audio_parts).astype(np.float32)
    sf.write(args.output, full_audio, sample_rate)
    total_seconds = round(len(full_audio) / sample_rate, 1)
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
