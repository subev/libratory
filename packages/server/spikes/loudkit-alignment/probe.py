#!/usr/bin/env python3
"""Render a corpus with loudkit and keep every head's attention, for choosing the timing heads.

  probe.py <repo> <voice> <corpus.txt> <out-dir> [--language en] [--heads all|pinned]

One line of the corpus is one chunk, as the synthesizer sees it. Writes chunk-NNN.wav and, per
loudkit window inside it, chunk-NNN-W.npz (attention [steps, 256, span] float16 + meta), and
run.json with speed and memory. Gold comes from SpeechTranscriber on the WAVs (score.py).
Run with .venv-loudkit.
"""

import argparse
import json
import os
import resource
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts"))
from loudkit_attention import MODELS, capture, shipped_attempt  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    parser.add_argument("voice")
    parser.add_argument("corpus")
    parser.add_argument("out")
    parser.add_argument("--language", default="en")
    parser.add_argument("--heads", default="all", choices=["all", "pinned", "none"])
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    import loudkit
    from loudkit.execution import ExecutionConfig

    revision = MODELS[args.repo]["revision"]
    engine = loudkit.load(args.repo, revision=revision, device="mps",
                          execution=ExecutionConfig(device="mps", attention="sdpa", num_threads=4))
    snap = Path(os.path.expanduser(f"~/.cache/huggingface/hub/models--{args.repo.replace('/', '--')}/snapshots/{revision}"))
    voice = loudkit.voice(os.path.realpath(snap / "voices" / f"{args.voice}.safetensors"))
    space = int(engine.frontend.encode(" ", args.language)[-1])
    limit = engine.algorithm.start_speech_token
    rate = engine.algorithm.sample_rate
    engine.synthesize("Ready.", voice, seed=1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    heads = None if args.heads == "all" else MODELS[args.repo]["heads"]
    chunks = [line.strip() for line in Path(args.corpus).read_text().splitlines() if line.strip()]
    audio_s = wall_s = 0.0
    for index, text in enumerate(chunks, start=1):
        t0 = time.perf_counter()
        pieces, offset = [], 0.0
        if args.heads == "none":
            for result in engine.stream(text, voice, seed=args.seed + index, language=args.language):
                pieces.append(result.audio)
        else:
            with capture(engine, heads) as attempts:
                for w, result in enumerate(engine.stream(text, voice, seed=args.seed + index, language=args.language)):
                    duration = len(result.audio) / rate
                    found = shipped_attempt(attempts, result.tokens, limit)
                    meta = {"chunk": index, "window": w, "text": result.chunks[0].text, "offset": offset,
                            "duration": duration, "n_speech": len(result.tokens), "space": space,
                            "text_tokens": found["text_tokens"] if found else None}
                    np.savez_compressed(out / f"chunk-{index:03d}-{w}.npz", meta=json.dumps(meta),
                                        attention=found["attention"] if found else np.zeros((0, 0, 0), np.float16))
                    pieces.append(result.audio)
                    offset += duration
        wall_s += time.perf_counter() - t0
        audio = np.concatenate(pieces)
        audio_s += len(audio) / rate
        sf.write(out / f"chunk-{index:03d}.wav", audio, rate)
        print(f"{index}/{len(chunks)} {len(audio) / rate:.1f}s", file=sys.stderr, flush=True)
    run = {"repo": args.repo, "voice": args.voice, "language": args.language, "heads": args.heads,
           "audio_s": round(audio_s, 1), "wall_s": round(wall_s, 1), "rtf": round(audio_s / wall_s, 2),
           "peak_rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**30, 2)}
    (out / "run.json").write_text(json.dumps(run, indent=1))
    print(json.dumps(run))


if __name__ == "__main__":
    main()
