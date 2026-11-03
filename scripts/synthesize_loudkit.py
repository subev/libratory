#!/usr/bin/env python3
"""loudkit (loudreader, Apache-2.0): a 0.5B Chatterbox-derived voice in nine languages, on this Mac.

Runs in its own venv (.venv-loudkit): loudkit caps numpy below 2.4 while the other engine envs take
2.5.3. The token generator runs on the CPU and the renderer on Metal where there is one — loudkit's
own split — at about 3.3x realtime on an M4 Pro. Only the torch checkpoint, the voices and the
tokenizer are fetched (`--cache-only`), pinned to a revision and checked against the release's
SHA256SUMS by loudkit's own download.

loudkit's word times are letter-count estimates. Word timings here come from its generator's
self-attention instead (loudkit_attention.py), written beside each chunk WAV as Piper's are; a chunk
whose trace cannot carry them gets none, never an estimate.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from attention_words import FRAME_MS, voiced_frames  # noqa: E402
from chunk_io import load_existing_chunk, read_chunks, write_chunk_manifest, write_chunk_words  # noqa: E402
from loudkit_attention import MODELS, capture, chunk_words, shipped_attempt, word_starts  # noqa: E402

DEFAULT_MODEL = "loudreader/loudr-1"
TURBO_MODEL = "loudreader/loudr-1-turbo"
# The CC0 voices of the release (docs/voices/roster/provenance.json) and the language each reads.
# carmen, colette, dante, henri and ines are left out: CC-BY readers of LibriVox/MLS/CML corpora,
# recorded without consent to voice cloning.
VOICES = {
    "clara": "en", "emma": "en", "henry": "en", "joe": "en", "kathleen": "en", "lucy": "en",
    "miles": "en", "oliver": "en", "oscar": "en", "sophie": "en",
    "dave": "es", "kerstin": "de", "thorsten": "de", "paola": "it", "darkman": "pl", "gosia": "pl",
    "tugao": "pt", "nathalie": "nl", "pim": "nl", "nils": "sv", "selma": "sv", "freja": "da", "soren": "da",
}
PAUSE_MS = 250
SEED = 7
# The generator's decode is a few hundred tiny CPU steps a second; past four threads they only
# contend (3.3x realtime at 4 against 2.5x at the default 10, M4 Pro)
GENERATOR_THREADS = 4


def snapshot(model: str, local_only: bool) -> Path:
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(model, revision=MODELS[model]["revision"], local_files_only=local_only,
                                  allow_patterns=[f"{model.split('/')[1]}.safetensors", "manifest.json", "release.json",
                                                  "SHA256SUMS", "tokenizer.json", *(f"voices/{v}.safetensors" for v in VOICES)]))


def cache_only(model: str) -> None:
    # loudkit's own download checks every file against the release's SHA256SUMS
    from loudkit import hub
    root = hub.download(model, revision=MODELS[model]["revision"], backend="torch")
    print(json.dumps({"type": "cached", "path": str(root)}), flush=True)


def load_engine(model: str):
    import torch
    import loudkit
    from loudkit.execution import ExecutionConfig

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    # sdpa, not loudkit's "auto" (eager beside an MPS renderer): the generator runs on the CPU,
    # where the fused call is fine and eager costs a quarter of the speed
    execution = ExecutionConfig(device=device, attention="sdpa", num_threads=GENERATOR_THREADS)
    return loudkit.load(model, revision=MODELS[model]["revision"], device=device, execution=execution)


def load_voice(model_dir: Path, name: str):
    import loudkit
    # By path: loudkit refuses a voice by name when, as in the HF cache, the file is a symlink
    return loudkit.voice(os.path.realpath(model_dir / "voices" / f"{name}.safetensors"))


def speak_chunk(engine, voice, text, language, seed, speed, timed):
    """(waveform, [(spoken text, word starts or None, window start s)]) for one chunk."""
    rate = engine.algorithm.sample_rate
    limit = engine.algorithm.start_speech_token
    space = int(engine.frontend.encode(" ", language)[-1])
    settings = MODELS[timed] if timed else None
    pieces, windows, offset = [], [], 0.0
    stream = lambda: engine.stream(text, voice, seed=seed, language=language, speed=speed, latency_mode=False)
    if settings is None:
        for result in stream():
            pieces.append(result.audio)
        return np.concatenate(pieces).astype(np.float32), windows
    with capture(engine, settings["heads"]) as attempts:
        for result in stream():
            duration = len(result.audio) / rate
            found = shipped_attempt(attempts, result.tokens, limit)
            starts = word_starts(found, settings["heads"], len(result.tokens), duration, space,
                                 settings["offset_ms"] / speed) if found else None
            windows.append((result.chunks[0].text, starts, offset))
            pieces.append(result.audio)
            offset += duration
    return np.concatenate(pieces).astype(np.float32), windows


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize text to WAV with loudkit")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--voice")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--model", default="default", choices=["default", "turbo"])
    parser.add_argument("--chunks-dir", default=None)
    parser.add_argument("--cache-only", action="store_true", help="Download the checkpoint and voices, then exit")
    args = parser.parse_args()
    model = TURBO_MODEL if args.model == "turbo" else DEFAULT_MODEL

    if args.cache_only:
        cache_only(model)
        return
    if not (args.input and args.output and args.voice):
        parser.error("--input, --output and --voice are required")
    if args.voice not in VOICES:
        raise RuntimeError(f"Unsupported loudkit voice: {args.voice}")
    language = VOICES[args.voice]

    local_only = os.environ.get("HF_HUB_OFFLINE") == "1"
    try:
        model_dir = snapshot(model, local_only)
    except Exception as exc:
        raise RuntimeError("loudkit is not downloaded — install it from the voice picker") from exc
    engine = load_engine(model)
    voice = load_voice(model_dir, args.voice)
    rate = engine.algorithm.sample_rate

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    silence = np.zeros(int(rate * PAUSE_MS / 1000), dtype=np.float32)
    # Streamed to disk rather than held: a long chapter's float32 audio runs to a gigabyte
    partial_output = args.output + ".partial"
    total_samples = 0
    out = sf.SoundFile(partial_output, "w", samplerate=rate, channels=1, format="WAV")
    for index, chunk in enumerate(chunks, start=1):
        waveform = load_existing_chunk(args.chunks_dir, index, needs_words=True)
        if waveform is None:
            waveform, windows = speak_chunk(engine, voice, chunk, language, SEED + index, args.speed,
                                            model if args.chunks_dir else None)
            if args.chunks_dir:
                os.makedirs(args.chunks_dir, exist_ok=True)
                sf.write(os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav"), waveform, rate)
                write_chunk_words(args.chunks_dir, index, chunk_words(chunk, windows, voiced_frames(waveform, rate), FRAME_MS))

        out.write(waveform)
        total_samples += len(waveform)
        if index < len(chunks):
            out.write(silence)
            total_samples += len(silence)
        print(json.dumps({"type": "progress", "chunk": index, "totalChunks": len(chunks),
                          "audioSeconds": round(total_samples / rate, 1)}), flush=True)

    out.close()
    os.replace(partial_output, args.output)
    print(json.dumps({"type": "done", "audioSeconds": round(total_samples / rate, 1), "chunks": len(chunks)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
