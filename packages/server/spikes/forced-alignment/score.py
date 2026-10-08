#!/usr/bin/env python3
"""Score word timings against Piper's own, for tasks/forced-alignment.md.

  score.py attention <npz-dir> <piper-dir> [L.H …]  attention_words.chunk_words over the captures (default heads: HEADS)
  score.py scan      <npz-dir> <piper-dir>          every head alone, best first
  score.py fold      <npz-dir> <piper-dir> <k>      the k best heads chosen on odd chunks scored on even, and back
  score.py baseline  <piper-dir>                    the control: words spread by letter count over the voiced span

Only words whose Piper time is real are scored: Piper shares a number's reading out evenly over the
written words it came from ("1878 г."), so those and their abbreviations are left out.
Run with .venv-bgtts (numpy + soundfile).
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts"))
from attention_words import HEADS, chunk_words, voiced_frames, FRAME_MS  # noqa: E402


def scored(gold, i):
    token = gold[i]["text"]
    if re.search(r"[\d%]", token):
        return False
    return not (i > 0 and re.search(r"\d", gold[i - 1]["text"]) and len(re.sub(r"\W", "", token)) <= 3)


def voiced(piper_dir, stem):
    audio, rate = sf.read(Path(piper_dir) / f"{stem}.wav", dtype="float32")
    return voiced_frames(audio, rate)


def attention_errors(npz_dir, piper_dir, heads, keep=lambda n: True):
    errors = []
    for npz in sorted(Path(npz_dir).glob("chunk-*.npz")):
        if not keep(int(npz.stem.split("-")[1])):
            continue
        data = np.load(npz)
        meta = json.loads(data["meta"].item())
        pieces = [(data["attention"].astype(np.float32), meta["words"], meta["ranges"])]
        predicted = chunk_words(meta["written"], pieces, voiced(piper_dir, npz.stem), heads)
        gold = json.loads((Path(piper_dir) / f"{npz.stem}.words.json").read_text())
        if [w["text"] for w in gold] != [w["text"] for w in predicted]:
            print(f"{npz.stem}: no words placed", file=sys.stderr)
            continue
        errors += [p["startMs"] - g["startMs"] for i, (p, g) in enumerate(zip(predicted, gold)) if scored(gold, i)]
    return np.array(errors)


def baseline_errors(piper_dir):
    errors = []
    for path in sorted(Path(piper_dir).glob("chunk-*.words.json")):
        gold = json.loads(path.read_text())
        frames = np.nonzero(voiced(piper_dir, path.name.removesuffix(".words.json")))[0]
        t0, t1 = frames[0] * FRAME_MS, (frames[-1] + 1) * FRAME_MS
        lengths = [len(w["text"]) + 1 for w in gold]
        cursor = 0
        for i, (w, n) in enumerate(zip(gold, lengths)):
            if scored(gold, i):
                errors.append(t0 + (t1 - t0) * cursor / sum(lengths) - w["startMs"])
            cursor += n
    return np.array(errors)


def summary(signed):
    a = np.abs(signed)
    return (f"n={len(a)} median={np.median(a):.0f}ms mean={a.mean():.0f}ms p90={np.percentile(a, 90):.0f}ms "
            f"≤50ms={np.mean(a <= 50):.0%} ≤100ms={np.mean(a <= 100):.0%} bias={signed.mean():+.0f}ms")


def every_head(npz_dir):
    layers, heads = np.load(next(Path(npz_dir).glob("chunk-*.npz")))["attention"].shape[:2]
    return [(l, h) for l in range(layers) for h in range(heads)]


def label(heads):
    return " ".join(f"{l}.{h}" for l, h in heads)


def main():
    command, *rest = sys.argv[1:]
    if command == "attention":
        npz_dir, piper_dir, *heads = rest
        heads = [tuple(int(x) for x in h.split(".")) for h in heads] or HEADS
        print(f"attention {label(heads)}: {summary(attention_errors(npz_dir, piper_dir, heads))}")
    elif command == "scan":
        npz_dir, piper_dir = rest
        ranked = sorted((np.median(np.abs(e)), head, e) for head in every_head(npz_dir) for e in [attention_errors(npz_dir, piper_dir, [head])])
        for _, head, errors in ranked[:8]:
            print(f"{label([head])}  {summary(errors)}")
    elif command == "fold":
        npz_dir, piper_dir, k = rest
        for name, choose in [("odd→even", lambda n: n % 2 == 1), ("even→odd", lambda n: n % 2 == 0)]:
            ranked = sorted(every_head(npz_dir), key=lambda head: np.median(np.abs(attention_errors(npz_dir, piper_dir, [head], choose))))
            chosen = ranked[: int(k)]
            print(f"{name} {label(chosen)}: {summary(attention_errors(npz_dir, piper_dir, chosen, lambda n: not choose(n)))}")
    elif command == "baseline":
        print(f"baseline: {summary(baseline_errors(rest[0]))}")


if __name__ == "__main__":
    main()
