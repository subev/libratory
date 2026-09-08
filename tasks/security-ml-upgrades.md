# Finish ML security upgrades

The September 2026 security pass patched Pillow (12.3), PyTorch (2.13), and setuptools (84).
The nine remaining OSV records are in Transformers 4.57.6 and Accelerate 1.14.0; three are
duplicate PYSEC/GHSA records. They remain visible in every audit. Exact-version exceptions in
`scripts/python-audit-exceptions.json` expire on 2026-10-08 and fail CI after that date.

## Transformers

Marker 1.10.2 requires Transformers <5. Upgrading Transformers alone previously broke extraction.
PyPI now lists Marker 2.0.0 + Surya 0.22.1 with Transformers >=5.12.1, but this also changes
pdftext/pypdfium2, the Surya APIs/checkpoints, and huggingface-hub to >=1.5. Treat this as an
extraction-runtime migration, with real PDF layout, OCR, Kokoro, BGE-M3 and both MLX narrator
checks against cached models. Do not silently replace models or download them during inference.

Review GHSA-29pf-2h5f-8g72 (model config/kernel execution) and GHSA-xrqw-3rrv-vx5w
(tokenizer save path traversal) in particular. Application-selected repositories reduce exposure
but do not eliminate upstream model compromise. Trainer checkpoint restore, X-CLIP conversion,
and LightGlue are not app entry points. Remove the matching exceptions after migration.

## Accelerate

GHSA-4j2p-28q2-5m79 has no published fix as of the audit. Monitor upstream's validation of
sharded checkpoint `weight_map` paths. The app does not offer arbitrary checkpoint imports;
that restriction is not a substitute for an upstream fix.

Keep raw reports available; do not dismiss these GitHub alerts as fixed or turn off scanning.
