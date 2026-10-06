#!/usr/bin/env python3

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from chunk_io import load_existing_chunk, read_chunks, write_chunk_manifest


PAUSE_MS = 250
SAMPLE_RATE = 24000







CLONING_UNAVAILABLE = (
    "voice cloning weights are unavailable — accept the terms at "
    "https://huggingface.co/kyutai/pocket-tts, set HF_TOKEN, and re-run scripts/setup.sh"
)


def catalog_voices() -> list[str]:
    """The installed package owns the catalog — don't keep a copy that can drift from it."""
    from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES

    return list(_ORIGINS_OF_PREDEFINED_VOICES)


def resolve_voice(model, voice: str):
    """An existing path is a reference to clone; anything else must be a catalog voice name."""
    path = Path(voice)
    if path.exists():
        if not getattr(model, "has_voice_cloning", False):
            raise RuntimeError(CLONING_UNAVAILABLE)
        return model.get_state_for_audio_prompt(path)

    known = catalog_voices()
    if voice not in known:
        raise RuntimeError(f"unknown voice '{voice}' — catalog voices are: {', '.join(sorted(known))}")
    return model.get_state_for_audio_prompt(voice)


def export_voice(audio_path: str, out_path: str, language: str) -> None:
    """Encode a reference recording once so synthesis can reload it in ~10ms."""
    from pocket_tts import TTSModel, export_model_state

    model = TTSModel.load_model(language=language)
    if not getattr(model, "has_voice_cloning", False):
        raise RuntimeError(CLONING_UNAVAILABLE)
    state = model.get_state_for_audio_prompt(Path(audio_path))
    export_model_state(state, out_path)
    print(json.dumps({"type": "exported", "path": out_path}), flush=True)


def cache_models(language: str) -> None:
    from pocket_tts import TTSModel

    model = TTSModel.load_model(language=language)
    for voice in catalog_voices():
        try:
            model.get_state_for_audio_prompt(voice)
        except Exception as exc:
            print(f"warning: could not cache voice {voice}: {exc}", file=sys.stderr)
    print(json.dumps({
        "type": "cached",
        "language": language,
        "voiceCloning": bool(getattr(model, "has_voice_cloning", False)),
    }), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize text to WAV using Kyutai Pocket TTS")
    parser.add_argument("--input", help="Path to chunked input text file")
    parser.add_argument("--output", help="Path to output WAV file")
    parser.add_argument("--voice", help="Catalog voice name, or path to a reference audio/.safetensors file")
    parser.add_argument("--chunks-dir", default=None, help="Optional directory to persist per-chunk WAV previews")
    parser.add_argument("--language", default="english", help="Pocket TTS language model to load")
    parser.add_argument("--cache-only", action="store_true", help="Download model and catalog voices, then exit")
    parser.add_argument("--export-voice", default=None, help="Reference audio to encode into a reusable voice state")
    parser.add_argument("--voice-out", default=None, help="Destination .safetensors path for --export-voice")
    args = parser.parse_args()

    if args.cache_only:
        cache_models(args.language)
        return

    if args.export_voice:
        if not args.voice_out:
            raise RuntimeError("--voice-out is required with --export-voice")
        export_voice(args.export_voice, args.voice_out, args.language)
        return

    for required in ("input", "output", "voice"):
        if not getattr(args, required):
            raise RuntimeError(f"--{required} is required")

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    loaded: list = []

    def synthesizer():
        """Deferred so a fully-resumed chapter never pays the model load."""
        if not loaded:
            from pocket_tts import TTSModel

            model = TTSModel.load_model(language=args.language)
            loaded.append((model, resolve_voice(model, args.voice)))
        return loaded[0]

    audio_parts: list[np.ndarray] = []
    silence = np.zeros(int(SAMPLE_RATE * PAUSE_MS / 1000), dtype=np.float32)
    total_samples = 0

    for index, chunk in enumerate(chunks, start=1):
        waveform = load_existing_chunk(args.chunks_dir, index)
        if waveform is None:
            model, voice_state = synthesizer()
            waveform = model.generate_audio(voice_state, chunk).numpy().astype(np.float32).squeeze()
            if waveform.size == 0:
                raise RuntimeError(f"chunk {index} produced no audio")
            if args.chunks_dir:
                os.makedirs(args.chunks_dir, exist_ok=True)
                sf.write(os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav"), waveform, SAMPLE_RATE)

        audio_parts.append(waveform)
        total_samples += len(waveform)
        if index < len(chunks):
            audio_parts.append(silence)
            total_samples += len(silence)

        print(json.dumps({
            "type": "progress",
            "chunk": index,
            "totalChunks": len(chunks),
            "audioSeconds": round(total_samples / SAMPLE_RATE, 1),
        }), flush=True)

    if not audio_parts:
        raise RuntimeError("No audio chunks were produced")

    full_audio = np.concatenate(audio_parts).astype(np.float32)
    sf.write(args.output, full_audio, SAMPLE_RATE)
    print(json.dumps({
        "type": "done",
        "audioSeconds": round(len(full_audio) / SAMPLE_RATE, 1),
        "chunks": len(chunks),
    }), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
