#!/usr/bin/env python3

import argparse
import gc
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bg_speech import speakable  # noqa: E402


MODEL_ID = "raditotev/bg-tts-v5-mlx"
SPEAKER_IDS = {
    "default": 0,
    "narrator": 1,
}
CHUNK_SEPARATOR = "\f"
PAUSE_MS = 250
SAMPLE_RATE = 22050


def resolve_checkpoint() -> str:
    model_path = os.environ.get("BG_TTS_MLX_MODEL_PATH")
    if model_path:
        return model_path

    from huggingface_hub import snapshot_download

    local_only = os.environ.get("HF_HUB_OFFLINE") == "1"
    return snapshot_download(MODEL_ID, local_files_only=local_only)


def load_inference_module(checkpoint: str):
    sys.path.insert(0, checkpoint)
    try:
        import tts_mlx.inference as mlx_inference
    except ImportError as exc:
        raise RuntimeError(
            "Could not import bg-tts-v5-mlx inference code. Cache the model repo and install MLX dependencies first."
        ) from exc

    return mlx_inference


def load_pipeline(mlx_inference, checkpoint: str):
    if os.path.exists(os.path.join(checkpoint, "model.safetensors")):
        model = mlx_inference.load_from_safetensors(checkpoint)
    else:
        model = mlx_inference.load_from_pytorch_checkpoint(checkpoint)
    model.eval()

    tokenizer = mlx_inference.TTSTokenizer()

    from nanocodec_mlx.models.audio_codec import AudioCodecModel

    codec = AudioCodecModel.from_pretrained(mlx_inference.NANOCODEC_MODEL_NAME)
    return model, tokenizer, codec


def synthesize_chunk_audio(mlx_inference, model, tokenizer, codec, text: str, speaker_id: int):
    import numpy as np

    tokens = mlx_inference.generate(
        model,
        tokenizer,
        text,
        speaker_id=speaker_id,
        temperature=0.25,
        top_k=50,
        top_p=0.8,
    )

    if tokens is None or len(tokens) == 0:
        raise RuntimeError("No audio tokens were generated")

    tokens = tokens[: len(tokens) - len(tokens) % mlx_inference.CODEC_NUM_CODEBOOKS]
    if len(tokens) == 0:
        raise RuntimeError("Generated audio token count is not aligned to the codec")

    num_frames = len(tokens) // mlx_inference.CODEC_NUM_CODEBOOKS
    codes = tokens.reshape(num_frames, mlx_inference.CODEC_NUM_CODEBOOKS).T
    codes_mx = mlx_inference.mx.array(codes.astype(np.int32))[None, :, :]
    tokens_len = mlx_inference.mx.array([num_frames], dtype=mlx_inference.mx.int32)

    wav_mx, _ = codec.decode(codes_mx, tokens_len)
    mlx_inference.mx.eval(wav_mx)
    return np.array(wav_mx[0, 0, :], dtype=np.float32)


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


def load_existing_chunk(chunks_dir, index: int):
    """Return a previously-synthesized chunk's audio so resume can skip regenerating it."""
    if not chunks_dir:
        return None
    path = os.path.join(chunks_dir, f"chunk-{index:03d}.wav")
    if not os.path.exists(path):
        return None
    try:
        import soundfile as sf

        data, _ = sf.read(path, dtype="float32")
        return data if len(data) else None
    except Exception:
        return None


def main() -> None:
    import numpy as np
    import soundfile as sf

    parser = argparse.ArgumentParser(description="Synthesize Bulgarian text to WAV using bg-tts-v5-mlx")
    parser.add_argument("--input", required=True, help="Path to chunked input text file")
    parser.add_argument("--output", required=True, help="Path to output WAV file")
    parser.add_argument("--voice", default="narrator", help="Voice name (default or narrator)")
    parser.add_argument("--chunks-dir", default=None, help="Optional directory to persist per-chunk WAV previews")
    args = parser.parse_args()

    speaker_id = SPEAKER_IDS.get(args.voice)
    if speaker_id is None:
        raise RuntimeError(f"Unsupported Bulgarian MLX voice: {args.voice}")

    chunks = read_chunks(args.input)
    if args.chunks_dir:
        write_chunk_manifest(args.chunks_dir, chunks)
    checkpoint = resolve_checkpoint()
    mlx_inference = load_inference_module(checkpoint)
    model, tokenizer, codec = load_pipeline(mlx_inference, checkpoint)

    print(json.dumps({"type": "chunks", "total": len(chunks)}), flush=True)

    total_samples = 0
    silence = np.zeros(int(SAMPLE_RATE * PAUSE_MS / 1000), dtype=np.float32)

    with sf.SoundFile(args.output, mode="w", samplerate=SAMPLE_RATE, channels=1, format="WAV", subtype="FLOAT") as out_file:
        for index, chunk in enumerate(chunks, start=1):
            chunk_audio = load_existing_chunk(args.chunks_dir, index)
            if chunk_audio is None:
                chunk_audio = synthesize_chunk_audio(mlx_inference, model, tokenizer, codec, speakable(chunk), speaker_id)
                if args.chunks_dir:
                    os.makedirs(args.chunks_dir, exist_ok=True)
                    sf.write(os.path.join(args.chunks_dir, f"chunk-{index:03d}.wav"), chunk_audio, SAMPLE_RATE)
            out_file.write(chunk_audio)
            total_samples += len(chunk_audio)

            if index < len(chunks):
                out_file.write(silence)
                total_samples += len(silence)

            total_seconds = round(total_samples / SAMPLE_RATE, 1)
            print(json.dumps({
                "type": "progress",
                "chunk": index,
                "totalChunks": len(chunks),
                "audioSeconds": total_seconds,
            }), flush=True)

            del chunk_audio
            mlx_inference.mx.clear_cache()
            gc.collect()

    if total_samples == 0:
        raise RuntimeError("No audio chunks were produced")

    total_seconds = round(total_samples / SAMPLE_RATE, 1)
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
