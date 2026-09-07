#!/usr/bin/env python3
"""Copies ffmpeg, poppler and tesseract — plus every library they need — into the desktop bundle.

Homebrew's binaries link their dependencies by absolute path into /opt/homebrew, so copying one
into an app gives you something that only runs on a machine that already has Homebrew, which is
the prerequisite the app exists to remove. This walks the dependency closure, copies it, and
rewrites every load command to @loader_path so the folder runs from anywhere.

    python3 scripts/bundle-tools.py [--out packages/desktop/resources/bin]

Tesseract also needs data beside its binary — the eng/osd packs, plus configs/pdf and pdf.ttf,
without which `tesseract … pdf` fails with no useful message — so <resources>/tessdata ships too.

Same lesson as the embedded Postgres, and the same reason DYLD_LIBRARY_PATH is not the answer:
the hardened runtime strips DYLD_*, so it would work in development and fail in the shipped app.
"""
import argparse
import hashlib
import json
import urllib.request
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PINS_FILE = Path(__file__).parent / "pins.json"
PINS = json.loads(PINS_FILE.read_text())
PINNED = PINS["bundledTools"]["versions"]
TESSDATA_PIN = PINS["tessdata"]
TOOLS = list(PINNED)
SYSTEM_PREFIXES = ("/usr/lib/", "/System/")
# Two packs ship (26 MB against 1.14 GB for all of them); the rest are downloads, and osd names the script.
# They come from the pinned tessdata_best tree the app downloads from, so shipped and downloaded packs
# are one model family — Homebrew's eng is the fast model and reads worse.
SHIPPED_PACKS = ["eng", "osd"]
TESSERACT_FILES = ["pdf.ttf", "configs", "tessconfigs"]


def rpaths(binary: Path) -> list[str]:
    out = subprocess.run(["otool", "-l", str(binary)], capture_output=True, text=True).stdout
    return re.findall(r"path (\S+) \(offset", out)


def raw_deps(binary: Path) -> list[str]:
    out = subprocess.run(["otool", "-L", str(binary)], capture_output=True, text=True).stdout
    return [m.group(1) for line in out.splitlines()[1:] if (m := re.match(r"\s+(\S+)", line))]


# Homebrew's binaries reference most of their libraries as @rpath/foo.dylib rather than by absolute
# path, so a scanner that skips anything starting with "@" walks a closure of almost nothing and
# produces a folder that is missing exactly the libraries that matter.
def resolve_dep(dep: str, owner: Path) -> Path | None:
    if dep.startswith("@rpath/"):
        name = dep[len("@rpath/"):]
        for rp in rpaths(owner):
            base = rp.replace("@loader_path", str(owner.parent)).replace("@executable_path", str(owner.parent))
            candidate = Path(base) / name
            if candidate.exists():
                return candidate
        return None
    if dep.startswith("@loader_path") or dep.startswith("@executable_path"):
        candidate = Path(dep.replace("@loader_path", str(owner.parent)).replace("@executable_path", str(owner.parent)))
        return candidate if candidate.exists() else None
    p = Path(dep)
    return p if p.exists() else None


def deps(binary: Path) -> list[str]:
    return [d for d in raw_deps(binary) if not d.startswith(SYSTEM_PREFIXES)]


# Keyed by the name the load command uses, not the name on disk. libpoppler.149.dylib is a symlink
# to libpoppler.149.0.0.dylib, and copying the target while rewriting to the link's name produces a
# folder whose libraries all exist and none of which can be found.
def closure(roots: list[Path]) -> dict[str, Path]:
    found: dict[str, Path] = {}
    queue = list(roots)
    while queue:
        item = queue.pop()
        for dep in deps(item):
            name = Path(dep).name
            if name in found:
                continue
            real = resolve_dep(dep, item)
            if real is None:
                continue
            found[name] = real
            queue.append(real)
    return found


def check(args: list[str], what: str) -> None:
    if subprocess.run(args, capture_output=True).returncode != 0:
        raise SystemExit(f"{what} failed: {' '.join(args[:2])} {args[-1]}")


# install_name_tool takes every -change, -id and -add_rpath in one call, and each call rewrites the
# whole binary. One per dependency was 679 invocations over this closure; this is 107.
def relocate(path: Path, libdir_rel: str) -> None:
    args = []
    ident = subprocess.run(["otool", "-D", str(path)], capture_output=True, text=True).stdout.splitlines()
    if len(ident) > 1 and ident[1].startswith("/"):
        args += ["-id", f"@rpath/{path.name}"]
    for dep in deps(path):
        args += ["-change", dep, f"@rpath/{Path(dep).name}"]
    args += ["-add_rpath", libdir_rel]
    subprocess.run(["install_name_tool", *args, str(path)], capture_output=True)
    # Apple Silicon refuses to run a binary whose signature does not match, and install_name_tool
    # invalidates it. Without this they are SIGKILLed with no message at all, which looks exactly
    # like a missing library and is not.
    check(["codesign", "--force", "--sign", "-", "--timestamp=none", str(path)], "re-signing")


VERSION_RE = re.compile(r"(?:ffmpeg|pdftotext|pdfinfo|pdftoppm)(?: version)? (\d+[\d.]*)|tesseract (\d+[\d.]*)")


def version_flag(name: str) -> str:
    if name == "ffmpeg":
        return "-version"
    return "--version" if name == "tesseract" else "-v"


def installed_version(binary: Path) -> str | None:
    out = subprocess.run([str(binary), version_flag(binary.name)], capture_output=True, text=True)
    m = VERSION_RE.search(out.stdout + out.stderr)
    return (m.group(1) or m.group(2)) if m else None


# Homebrew ships one version of each of these and upgrades it under you — today's formula is ffmpeg
# 8.1 where this bundle was built and tested against 7.1.1. That difference is invisible in a DMG
# and shows up as a book that extracts differently, so the build stops here rather than shipping it.
def check_versions(originals: list[Path], update: bool) -> int:
    found = {t: installed_version(p) for t, p in zip(TOOLS, originals)}
    if update:
        pins = json.loads(PINS_FILE.read_text())
        pins["bundledTools"]["versions"].update({t: v for t, v in found.items() if v})
        PINS_FILE.write_text(json.dumps(pins, indent=2) + "\n")
        print(f"pins.json updated: {', '.join(f'{t} {v}' for t, v in found.items())}")
        return 0

    drift = {t: (PINNED[t], v) for t, v in found.items() if v != PINNED[t]}
    if not drift:
        return 0
    print("Bundled tool versions do not match scripts/pins.json:", file=sys.stderr)
    for tool, (want, got) in drift.items():
        print(f"  {tool}: pinned {want}, installed {got or 'unknown'}", file=sys.stderr)
    print(
        "\nThese go inside the DMG, so a change here reaches every user. Adopt it deliberately:\n"
        "  1. extract and synthesize a real book with the new versions\n"
        "  2. python3 scripts/bundle-tools.py --update-pins\n"
        "  3. tar -czf libratory-tools-arm64.tar.gz -C packages/desktop/resources bin tessdata\n"
        "  4. gh release create tools-N that tarball, and put its url + sha256 in pins.json",
        file=sys.stderr,
    )
    return 1


def fetch_pack(code: str, blobs: dict[str, dict], dest: Path) -> None:
    blob = blobs.get(f"{code}.traineddata")
    if not blob:
        raise SystemExit(f"{code}.traineddata is not in the pinned tessdata tree")
    url = f"https://raw.githubusercontent.com/{TESSDATA_PIN['repo']}/{TESSDATA_PIN['commit']}/{code}.traineddata"
    with urllib.request.urlopen(url) as r:
        data = r.read()
    digest = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    if len(data) != blob["size"] or digest != blob["sha"]:
        raise SystemExit(f"{code}.traineddata does not match the pinned tree ({len(data)} bytes, sha1 {digest[:12]}…)")
    (dest / f"{code}.traineddata").write_bytes(data)


# TESSDATA_PREFIX is one directory, so the packs, the configs and pdf.ttf all have to live in it.
def copy_tessdata(dest: Path) -> Path:
    prefix = subprocess.run(["brew", "--prefix"], capture_output=True, text=True).stdout.strip()
    source = Path(prefix) / "share" / "tessdata"
    if not source.is_dir():
        raise SystemExit(f"No tessdata at {source} — brew install tesseract")
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    for name in TESSERACT_FILES:
        item = source / name
        if not item.exists():
            raise SystemExit(f"{item} is missing — brew install tesseract")
        if item.is_dir():
            shutil.copytree(item, dest / name)
        else:
            shutil.copy2(item, dest / name)
    tree_url = f"https://api.github.com/repos/{TESSDATA_PIN['repo']}/git/trees/{TESSDATA_PIN['commit']}"
    with urllib.request.urlopen(tree_url) as r:
        blobs = {e["path"]: e for e in json.load(r)["tree"] if e["type"] == "blob"}
    for code in SHIPPED_PACKS:
        fetch_pack(code, blobs, dest)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="packages/desktop/resources/bin")
    ap.add_argument("--update-pins", action="store_true", help="adopt the installed versions as the pin")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    libdir = out / "lib"
    shutil.rmtree(out, ignore_errors=True)
    libdir.mkdir(parents=True)

    originals = []
    for tool in TOOLS:
        found = shutil.which(tool)
        if not found:
            print(f"{tool} is not installed — brew install ffmpeg poppler tesseract", file=sys.stderr)
            return 1
        originals.append(Path(found).resolve())

    if (code := check_versions(originals, args.update_pins)) != 0 or args.update_pins:
        return code

    # Walked where they were installed: @loader_path only means anything before they move
    libs = closure(originals)
    # Without otool (no Xcode command line tools) every dependency scan comes back empty and this
    # happily produces three unrelocated binaries that work on this machine and nowhere else.
    if not libs:
        print("Resolved no libraries — is `xcode-select --install` done?", file=sys.stderr)
        return 1

    roots = []
    for original, tool in zip(originals, TOOLS):
        target = out / tool
        shutil.copy2(original, target)
        os.chmod(target, 0o755)
        roots.append(target)
    for name, real in libs.items():
        shutil.copy2(real, libdir / name)

    for lib in libdir.iterdir():
        os.chmod(lib, 0o755)
        relocate(lib, "@loader_path")
    for root in roots:
        relocate(root, "@loader_path/lib")

    tessdata = copy_tessdata(out.parent / "tessdata")

    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    data_total = sum(f.stat().st_size for f in tessdata.rglob("*") if f.is_file())
    print(f"{len(TOOLS)} tools + {len(libs)} libraries -> {out}  ({total / 1e6:.0f} MB)")
    print(f"tessdata -> {tessdata}  ({data_total / 1e6:.0f} MB)")

    # Proving it here beats discovering it on a machine with no Homebrew
    for root in roots:
        env = {"PATH": "/usr/bin:/bin"}
        if root.name == "tesseract":
            env["TESSDATA_PREFIX"] = str(tessdata)
        r = subprocess.run([str(root), version_flag(root.name)], capture_output=True, text=True, env=env)
        first = [l for l in (r.stdout + r.stderr).splitlines() if l.strip()][:1]
        ok = bool(first) and "error" not in first[0].lower()
        print(f"  {root.name}: {'OK' if ok else 'FAILED'} {first[0][:56] if first else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
