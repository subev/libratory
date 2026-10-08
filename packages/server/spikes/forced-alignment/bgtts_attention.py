#!/usr/bin/env python3
"""The attention BgTTS-38M-V2 gives Piper's audio of the corpus, for scoring option A of
tasks/forced-alignment.md against Piper's own word timings.

Run with .venv-bgtts:
  bgtts_attention.py <corpus.txt> <piper-chunks-dir> <out-dir>

Each Piper chunk WAV is encoded with MioCodec and fed to the decoder as if BgTTS had said it; the
attention per head goes to chunk-NNN.npz with the chunk's spoken words. Chunks the model would
split into pieces are skipped: where the pieces meet in Piper's audio is not known.
"""

import json
import os
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "scripts"))
import synthesize_bgtts as bg  # noqa: E402
from attention_words import piece_attention, spoken_words  # noqa: E402
from bg_speech import speakable  # noqa: E402
from chunk_io import read_chunks  # noqa: E402


def main():
    corpus, piper_dir, out = sys.argv[1:]
    model_dir = bg.snapshot(local_only=True)
    sys.path.insert(0, str(model_dir))
    from model import CrossAttention, load_for_inference
    from tokenizer import TTSTokenizer
    from codec import CodecV6
    from inference import _split_text

    model = load_for_inference(str(model_dir / "checkpoint_inference.pt"), device="cpu")
    model.eval()
    tokenizer = TTSTokenizer()
    codec = CodecV6(device="cpu")
    os.makedirs(out, exist_ok=True)

    for index, chunk in enumerate(read_chunks(corpus), start=1):
        pieces = _split_text(speakable(chunk), tokenizer, min(250, model.config.max_text_len))
        if len(pieces) > 1:
            print(f"chunk {index}: {len(pieces)} pieces, skipped", file=sys.stderr)
            continue
        encoded = codec.encode(os.path.join(piper_dir, f"chunk-{index:03d}.wav"))
        attention = piece_attention(model, CrossAttention, tokenizer, pieces[0], encoded["codes"], encoded["global_embedding"])
        words, ranges = spoken_words(tokenizer, pieces[0])
        meta = {"written": chunk, "words": words, "ranges": ranges}
        np.savez_compressed(os.path.join(out, f"chunk-{index:03d}.npz"), meta=json.dumps(meta, ensure_ascii=False), attention=attention.astype(np.float16))
        print(f"chunk {index}: attention {attention.shape}", flush=True)


if __name__ == "__main__":
    main()
