"""The chunk files every narrator script shares with the server.

The server writes the chapter as chunks separated by form feeds; a script writes each chunk's audio
as chunk-NNN.wav (and chunk-NNN.words.json where it times words) beside a chunks.json manifest, so
previews, resume and the sync map all read the same layout whatever engine spoke it.
"""

import json
import os
from pathlib import Path

CHUNK_SEPARATOR = "\f"


def read_chunks(input_path: str) -> list[str]:
    text = Path(input_path).read_text(encoding="utf-8").strip()
    if not text:
        raise RuntimeError("input text is empty")
    return [chunk.strip() for chunk in text.split(CHUNK_SEPARATOR) if chunk.strip()]


def write_chunk_manifest(chunks_dir: str, chunks: list[str]) -> None:
    os.makedirs(chunks_dir, exist_ok=True)
    manifest = [{"index": index, "text": chunk} for index, chunk in enumerate(chunks, start=1)]
    with open(os.path.join(chunks_dir, "chunks.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)


def chunk_words_path(chunks_dir: str, index: int) -> str:
    return os.path.join(chunks_dir, f"chunk-{index:03d}.words.json")


def write_chunk_words(chunks_dir: str, index: int, words: list) -> None:
    # An empty list is written too: it records that timings were tried, so a resume keeps the chunk
    os.makedirs(chunks_dir, exist_ok=True)
    with open(chunk_words_path(chunks_dir, index), "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False)


def load_existing_chunk(chunks_dir, index: int, needs_words: bool = False):
    """A previously-synthesized chunk's audio, so resume can skip regenerating it.

    With needs_words, a chunk spoken before its engine timed words is spoken again.
    """
    if not chunks_dir:
        return None
    path = os.path.join(chunks_dir, f"chunk-{index:03d}.wav")
    if not os.path.exists(path):
        return None
    if needs_words and not os.path.exists(chunk_words_path(chunks_dir, index)):
        return None
    try:
        import soundfile as sf

        data, _ = sf.read(path, dtype="float32")
        return data if len(data) else None
    except Exception:
        return None
