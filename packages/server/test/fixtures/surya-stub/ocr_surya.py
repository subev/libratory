# Stand-in for scripts/ocr_surya.py: emits the real script's events and copies the input to --out.
import argparse, json, shutil, sys, time
ap = argparse.ArgumentParser(); ap.add_argument("--pdf"); ap.add_argument("--out"); ap.add_argument("--page", type=int); ap.add_argument("--stream-lines", action="store_true")
a = ap.parse_args()
def emit(**e): sys.stdout.write(json.dumps(e) + "\n"); sys.stdout.flush()
emit(event="start", pages=1); emit(event="page", page=a.page or 1, width=612.0, height=792.0); emit(event="detected", page=a.page or 1, lines=2)
for i, text in enumerate(["first line", "second line"], 1):
    time.sleep(0.4); emit(event="line", page=a.page or 1, index=i, total=2, text=text, bbox=[72.0, 72.0 * i, 300.0, 72.0 * i + 12.0])
emit(event="page-done", page=a.page or 1, elapsedMs=800)
if a.out: shutil.copyfile(a.pdf, a.out)
emit(event="done", elapsedMs=900)
