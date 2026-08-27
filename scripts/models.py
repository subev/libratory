#!/usr/bin/env python3
"""Reports which optional model bundles are cached, and fetches one on demand.

Setup used to download every model before the app could open — about 15 GB, most of it for
features a given person may never touch. This is the other half of that: the server asks what is
present, and downloads a bundle at the moment someone asks for the feature it powers.

    models.py --status                 JSON: one entry per bundle
    models.py --download <bundle-id>   fetch it (progress on stderr, from huggingface_hub)

Paths are deliberately not hardcoded on the TypeScript side: surya keeps its weights in a
platformdirs cache that differs per OS, and only Python knows where that is.
"""
import argparse
import json
import os
import sys
from pathlib import Path


def _hf_cached(repo_id: str, allow_patterns=None) -> bool:
    from huggingface_hub import snapshot_download
    try:
        path = snapshot_download(repo_id, local_files_only=True, allow_patterns=allow_patterns)
    except Exception:
        return False
    # snapshot_download returns as soon as the snapshot folder exists, which happens seconds into
    # a multi-gigabyte fetch — hub's own source says it "can't check if all the files are actually
    # there". A cancelled download would otherwise report installed, hide the download button, and
    # fail at synthesis instead, because every worker runs HF_HUB_OFFLINE=1.
    return not _has_partial_blobs(Path(path))


def _has_partial_blobs(snapshot: Path) -> bool:
    blobs = snapshot.parent.parent / "blobs"
    if any(blobs.glob("*.incomplete")):
        return True
    # A symlink into blobs/ that dangles is the other shape a half-finished fetch leaves behind
    return any(not f.exists() for f in snapshot.rglob("*") if f.is_symlink())


def _hf_fetch(repo_id: str, allow_patterns=None) -> None:
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id, allow_patterns=allow_patterns)


def _hf_repo_dir(repo_id: str) -> Path:
    from huggingface_hub.constants import HF_HUB_CACHE
    return Path(HF_HUB_CACHE) / ("models--" + repo_id.replace("/", "--"))


def _bytes_on_disk(paths) -> int:
    total = 0
    for p in paths:
        if not p.exists():
            continue
        # Partly-written blobs land as *.incomplete, and those are most of what a progress bar is
        # for — counting only finished files makes a 5 GB download look stuck at zero for minutes.
        for f in p.rglob("*"):
            try:
                if f.is_file() and not f.is_symlink():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


# huggingface_hub draws tqdm bars per file, which is several moving bars and nothing that adds up
# to "how far along is this". The bundle sizes are already known, so progress is measured off the
# disk instead: one number, and it survives however the library decides to render itself.
def _report_progress(paths, total_mb: int, stop) -> None:
    import time
    while not stop.is_set():
        mb = _bytes_on_disk(paths) // (1024 * 1024)
        print(json.dumps({"type": "progress", "mb": mb, "totalMb": total_mb}), flush=True)
        stop.wait(2)


def _surya_dir():
    # Deliberately not `from surya.settings import settings` — that pulls in torch and turns a
    # status check the UI runs on page load into three quarters of a second. This is the same
    # platformdirs location surya computes, asserted equal against it on 2026-08-26.
    from platformdirs import user_cache_dir
    return Path(user_cache_dir("datalab")) / "models"


def marker_installed() -> bool:
    try:
        d = _surya_dir()
    except Exception:
        return False
    # The directory appears before the weights finish arriving, so an empty one is not installed
    return d.is_dir() and any(p.is_dir() and any(p.iterdir()) for p in d.iterdir())


def marker_download() -> None:
    from marker.models import create_model_dict
    create_model_dict()


BUNDLES = [
    {
        "id": "extraction",
        "label": "Marker layout and OCR",
        "unlocks": "Full extraction (Marker) and OCR — the slow, accurate path for scans and complex layouts",
        "approxMb": 5100,
        "installed": marker_installed,
        "download": marker_download,
        "cacheDirs": lambda: [_surya_dir()],
    },
    {
        "id": "search",
        "label": "BGE-M3 embedding",
        "unlocks": "Semantic search over every book, and asking questions across the whole library",
        "approxMb": 4300,
        "installed": lambda: _hf_cached("BAAI/bge-m3"),
        "download": lambda: _hf_fetch("BAAI/bge-m3"),
        "cacheDirs": lambda: [_hf_repo_dir("BAAI/bge-m3")],
    },
    # One bundle used to hold both Bulgarian voices, flagged Apple-Silicon-only for the sake of
    # the MLX narrator — which made the MMS voice, which runs anywhere, undownloadable on exactly
    # the machines where it is the only Bulgarian option. A Mac that installed the old bundle has
    # both repos cached, so each half reports installed without a migration.
    {
        "id": "bulgarian",
        "label": "Bulgarian voice",
        "unlocks": "The Meta MMS Bulgarian voice",
        "approxMb": 290,
        "installed": lambda: _hf_cached("facebook/mms-tts-bul"),
        "download": lambda: _hf_fetch("facebook/mms-tts-bul"),
        "cacheDirs": lambda: [_hf_repo_dir("facebook/mms-tts-bul")],
    },
    {
        "id": "bulgarian-narrator",
        "label": "Bulgarian narrator",
        "unlocks": "The BG-TTS V5 narrator voice",
        "approxMb": 1000,
        "appleSiliconOnly": True,
        "installed": lambda: _hf_cached("raditotev/bg-tts-v5-mlx"),
        "download": lambda: _hf_fetch("raditotev/bg-tts-v5-mlx"),
        "cacheDirs": lambda: [_hf_repo_dir("raditotev/bg-tts-v5-mlx")],
    },
]

BY_ID = {b["id"]: b for b in BUNDLES}


# Developing a download gate otherwise means deleting several gigabytes to see it, and putting them
# back to see the other state. A file rather than an env var because the e2e suite drives an
# already-running dev server, whose environment it cannot reach. "mlx" is accepted here too, so the
# Apple-Silicon-only narrators can be seen greyed out on a machine that has MLX.
def _mlx_available() -> bool:
    try:
        import mlx.core  # noqa: F401
        return True
    except Exception:
        return False


def _forced_missing() -> set:
    marker = Path(__file__).resolve().parent.parent / ".models-missing"
    if not marker.exists():
        return set()
    return {line.strip() for line in marker.read_text().splitlines() if line.strip()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--capabilities", action="store_true")
    parser.add_argument("--essential", action="store_true")
    parser.add_argument("--download")
    parser.add_argument("--download-all", action="store_true")
    args = parser.parse_args()

    if args.download:
        bundle = BY_ID.get(args.download)
        if not bundle:
            print(f"Unknown bundle: {args.download}", file=sys.stderr)
            return 2
        import threading
        stop = threading.Event()
        reporter = threading.Thread(
            target=_report_progress, args=(bundle["cacheDirs"](), bundle["approxMb"], stop), daemon=True
        )
        reporter.start()
        try:
            bundle["download"]()
        finally:
            stop.set()
            reporter.join(timeout=3)
        return 0

    if args.download_all:
        # WITH_ALL_MODELS=1 in setup.sh. Iterating BY_ID rather than a list spelled out in bash,
        # which silently skipped any bundle added here afterwards.
        import threading
        for bundle in BUNDLES:
            # Fetching a gigabyte of Metal weights onto a machine with no Metal is not "all models"
            if bundle.get("appleSiliconOnly") and not _mlx_available():
                print(f"  {bundle['id']}: Apple Silicon only — skipped", file=sys.stderr)
                continue
            print(f"  {bundle['id']}...", file=sys.stderr)
            stop = threading.Event()
            reporter = threading.Thread(
                target=_report_progress, args=(bundle["cacheDirs"](), bundle["approxMb"], stop), daemon=True
            )
            reporter.start()
            try:
                bundle["download"]()
            finally:
                stop.set()
                reporter.join(timeout=3)
        return 0

    if args.essential:
        # Kokoro is not in BUNDLES because it is not optional — without a voice there is no
        # audiobook. It is the whole of what a first run must fetch before the app is useful.
        # Skipped when already cached so callers can run it on every start — the Docker
        # entrypoint does, and must come up offline once the volume holds the voice.
        if not _hf_cached("hexgrad/Kokoro-82M"):
            _hf_fetch("hexgrad/Kokoro-82M")
        return 0

    if args.capabilities:
        # A Mac still never imports torch here: MPS gates nothing — the two MLX narrators are the
        # only engines that cannot fall back. On Linux the answer decides marker's device, so the
        # half-second import is paid, once, where it buys something.
        cuda = False
        if sys.platform == "linux":
            try:
                import torch
                cuda = torch.cuda.is_available()
            except Exception:
                cuda = False
        mlx = False if "mlx" in _forced_missing() else _mlx_available()
        print(json.dumps({"mlx": mlx, "cuda": cuda}))
        return 0

    if args.status:
        forced_missing = _forced_missing()
        out = []
        for b in BUNDLES:
            try:
                installed = b["id"] not in forced_missing and b["installed"]()
            except Exception:
                installed = False
            out.append({
                "id": b["id"],
                "label": b["label"],
                "unlocks": b["unlocks"],
                "approxMb": b["approxMb"],
                "appleSiliconOnly": b.get("appleSiliconOnly", False),
                "installed": installed,
            })
        print(json.dumps(out))
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
