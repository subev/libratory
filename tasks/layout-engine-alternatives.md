# Evaluate alternatives to Marker layout extraction

Research date: 2026-09-09. Status: proposal; no engine installed or benchmarked, and no application behavior changed. Based on the checkout and current upstream documentation/source. Upstream default branches are moving targets; pin package versions and model revisions before experiments. Rankings below concern architectural fit, not measured extraction quality.

User clarification: OCR already works well; the interest is layout, including MinerU. Preserve the existing OCR stage and prioritize layout/reading-order quality.

Recommendation: compare our pinned Marker against MinerU's pipeline in text mode and Docling's standard PDF pipeline, with current Marker's no-OCR path as an upgrade baseline. PP-DocLayoutV3 remains the candidate for a smaller custom layout stack. Defer Chandra and other recognition replacements. Start with a small corpus before implementing an engine picker.

MinerU follow-up: its CLI exposes `pipeline` plus `txt` parsing and independent formula/table switches; start there rather than its default hybrid backend. Verify that the pinned configuration preserves existing text without recognition fallback. Its `middle.json` contains page dimensions, paragraph blocks, lines/spans and discarded blocks; ingest those discarded blocks as excluded-but-reviewable content. Its layout PDF numbers regions in reading order, making a useful comparison artifact. These details make MinerU worth a first-round trial alongside Docling. [CLI options](https://opendatalab.github.io/MinerU/usage/cli_tools/), [structured output](https://opendatalab.github.io/MinerU/reference/output_files/).

## What Libratory actually needs

There are four separate jobs:

| Job | Question it answers | Current implementation |
| --- | --- | --- |
| OCR | What characters are printed in this scan? | Tesseract or Surya, persisted as a searchable PDF |
| Layout and reading order | Which text belongs together, what kind is it, and what comes next? | Marker with `--disable_ocr` |
| Chapter detection | Which headings are chapter boundaries? | Our TOC/LLM, numbered-heading and heading-level logic |
| Reader alignment | Where are the words being spoken on the PDF? | Source-block polygons plus PDF text-layer geometry and text alignment |

Replacing layout will not necessarily fix misrecognized letters or a bad chapter-selection heuristic. Conversely, a better OCR engine does not necessarily fix columns being read in the wrong order.

For our audiobook/reader workflow the priorities are complete prose in reading order, useful headings, exclusion of page furniture, preservation of source coordinates, and repeatable editing. Table/formula reconstruction matters when the user wants that content, but is not the primary objective of the present narrator pipeline.

Repository evidence:

- [marker.ts](../packages/server/src/lib/marker.ts): `extractPdf` rejects textless PDFs and invokes Marker with OCR disabled. `FlatBlock`/`SourceBlock` hold text, block type, page, inclusion, optional heading level and polygon. Array order is reading order. Default included types are Text, SectionHeader, ListItem and Handwriting. Other nonempty text blocks remain available with `included: false`.
- [extract.ts](../packages/server/src/workers/extract.ts): the multi-file worker ensures the searchable text layer before layout and inserts chapters with source blocks and source-file indices.
- [page_geometry.py](../scripts/page_geometry.py) and [cue-rects.ts](../packages/server/src/lib/cue-rects.ts): fine geometry comes independently from `pdftext`/PDFium. Block polygons constrain alignment; they are not themselves accurate word boxes. Our coordinate frame is PDF points, origin top-left.
- [books.ts](../packages/server/src/routes/books.ts), [propose.ts](../packages/server/src/workers/propose.ts), [redetect.ts](../packages/server/src/workers/redetect.ts): structure inspection, proposals, applying boundaries and re-detection read saved Marker blocks. Merely returning chapters from a new CLI would leave these features broken.
- [pyproject.toml](../pyproject.toml): Marker 1.10.2, Surya 0.17.1, Transformers 4.57.6 and NumPy 1.26.4 share the runtime with speech and embeddings. [security-ml-upgrades.md](security-ml-upgrades.md) already records why extraction upgrades need isolation and regression checks.

## Candidate assessment

### Docling standard PDF pipeline — first independent parser to test

Docling's document representation includes typed content, body/furniture separation, hierarchy and bounding-box provenance. Consume its structured document, including furniture, rather than Markdown alone. This is close to the information our adapter needs. [Document format](https://docling-project.github.io/docling/concepts/docling_document/).

Use the standard pipeline with `do_ocr=False`, predownloaded artifacts, remote services disabled, and optional enrichment disabled initially. Its documented accelerator choices include CPU, MPS and CUDA. That is a good fit for our supported machines, although successful MPS execution on our selected version remains a benchmark gate. [Pipeline options](https://docling-project.github.io/docling/reference/pipeline_options/), [accelerator example](https://github.com/docling-project/docling/blob/main/docs/examples/run_with_accelerator.py).

A specific trap: the layout model identifies section headings but default PDF heading levels are all 1. Current docs offer optional hierarchy recovery using bookmarks, numbering and font styles. Enable and evaluate it, or leave levels unknown and rely on our TOC/numbered-heading path. Do not pass every heading to our heuristic as an equally strong chapter candidate. Offline artifact prefetch and explicit artifact paths are documented. [Advanced options](https://docling-project.github.io/docling/usage/advanced_options/).

Docling code is MIT; the Heron layout checkpoint is Apache-2.0. Its published weight file is approximately 172 MB, which is a layout checkpoint size, not the complete installed runtime. [Repository](https://github.com/docling-project/docling), [Heron files](https://huggingface.co/docling-project/docling-layout-heron/tree/main).

Assessment: moderate integration effort. Docling already handles text-to-layout association and document assembly, reducing the work we would own. Actual prose retention, heading quality, speed and memory are unmeasured here.

### PaddleOCR — distinguish the components

“PaddleOCR” describes several different choices:

| Component | Role in our app |
| --- | --- |
| PP-OCR recognition models | Alternative scan recognition; requires integrating the searchable-PDF step |
| PP-DocLayoutV3 | Layout regions, labels, polygons and reading order; we supply existing PDF text |
| PP-StructureV3 | Fuller layout/OCR/table parsing pipeline |
| PaddleOCR-VL, currently 1.6 | Generative document recognition/parsing, a different experiment from layout alone |

The project explicitly distinguishes PP-StructureV3's finer text/table-cell coordinates from the VL family's output. [PaddleOCR repository](https://github.com/PaddlePaddle/PaddleOCR).

**PP-DocLayoutV3 is the most directly relevant component.** Its official model describes polygonal regions and logical reading order, including curved/skewed documents. Official safetensors weights and a Transformers example exist; the model is 33.3M parameters and Apache-2.0. Thus adopting this model does not inherently require the Paddle runtime. [Model card](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3), [PyTorch weights and example](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_safetensors).

The work we must supply is substantial: rasterize each page, transform detected coordinates into PDF space, associate existing PDF text lines/chars with regions without duplication or omissions, preserve the model's order, and derive heading levels. Text outside every detected region must remain visible as unclassified content rather than disappear. Overlapping regions and full-width headings across columns need explicit handling.

Paddle documents Paddle, Transformers and ONNX Runtime inference routes. Its docs mix an older V2 overview with V3 examples, so version-specific API/schema verification matters. Published millisecond timings use a server benchmark environment and do not establish Mac book-extraction speed. [Layout analysis documentation](https://www.paddleocr.ai/latest/en/version3.x/module_usage/layout_analysis.html).

Native Paddle offers ARM64 CPU wheels; that alone is not evidence of Metal GPU acceleration. For our Mac build, test the official PyTorch route or ONNX CPU route. Treat MPS execution/operator support as unverified. [Paddle installation requirements](https://www.paddlepaddle.org.cn/documentation/docs/zh/install/index_cn.html).

Assessment: moderate-to-high effort for layout-only integration, with an appealing small-model path. PP-StructureV3 could reduce custom association work but adds more pipeline/runtime surface. Neither should replace existing OCR without a separate recognition comparison, especially for Bulgarian/Cyrillic.

### Chandra OCR 2 — evaluate for difficult scans

Current Chandra 2 is a 4B vision-language model; older references to Chandra's 9B size describe the first version. It produces structured page content with block labels and bounding boxes. That makes it a credible document-parser candidate, including for scans, complex layouts and handwriting. These are upstream capabilities and benchmark claims, not results on our library. [Chandra 2 announcement](https://www.datalab.to/blog/chandra-2).

The implementation generates HTML from images. Its layout prompt uses coordinates normalized to 0–1000; the parser converts those to image pixels. The exposed layout chunks have block boxes, labels and HTML content; the parser strips nested bbox attributes. Do not assume this supplies precise word geometry or a searchable PDF. Validate boxes ourselves because its parser has permissive malformed-box handling. [Prompt](https://github.com/datalab-to/chandra/blob/master/chandra/prompts.py), [output parser](https://github.com/datalab-to/chandra/blob/master/chandra/output.py).

For clean digital books, re-recognizing the page introduces an additional possible source of omissions, repetitions or changed wording. For scans, Chandra text may be better than the existing OCR layer yet disagree with it. We must choose between aligning the new transcript to existing geometry, creating a new searchable layer from sufficiently fine recognition, or explicitly offering coarser/text-only reading. Stretching a paragraph into its block box would not establish accurate word positions.

Local Hugging Face and vLLM modes are documented. The HF loader uses bfloat16 and a configurable device; its package requires Transformers >=5.2, incompatible with our current shared pin. Mac support/performance needs a real test; the advertised H100 throughput is not a laptop estimate. Four billion two-byte weights alone imply roughly 8 GB before activations and runtime overhead, not an 8 GB machine requirement. [Repository](https://github.com/datalab-to/chandra), [loader](https://github.com/datalab-to/chandra/blob/master/chandra/model/hf.py), [dependencies](https://github.com/datalab-to/chandra/blob/master/pyproject.toml).

Code is Apache-2.0; weights have modified OpenRAIL terms, including commercial thresholds and a competing-product restriction. Personal-use availability should not be confused with unrestricted redistribution. Record the exact chosen checkpoint's terms when packaging. [Model license](https://github.com/datalab-to/chandra/blob/master/MODEL_LICENSE).

Assessment: moderate effort to produce comparable block output, high effort to preserve the full reader experience if recognized text changes. Best tested as an explicitly selected alternative for difficult source files/pages.

### Other candidates worth knowing about

- **Current Marker itself:** upstream now documents `fast` with a small RF-DETR layout detector and `--disable_ocr` with all VLM calls disabled. Include that combination as a baseline improvement. This is current upstream behavior, not behavior verified in our pinned 1.10.2 or a tested release. [Marker documentation](https://github.com/datalab-to/marker). Current Surya has also changed inference management and output schemas, so upgrading the shared runtime is a migration. [Surya migration notes](https://github.com/datalab-to/surya).
- **MinerU:** a serious full-parser candidate with pipeline, hybrid and VLM backends. Its pipeline supports CPU; other local backends have higher hardware requirements, with Apple Silicon documented. The full local setup lists 16 GB minimum RAM and 20 GB disk. Keep it as a second-round candidate if the first parsers miss difficult structures. [MinerU](https://github.com/opendatalab/MinerU). Current licensing is custom Apache-based with additional conditions, rather than the AGPL cited in older comparisons. [License](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md).
- **GLM-OCR:** another recognition candidate whose complete pipeline already combines PP-DocLayoutV3 with region recognition. That reinforces the value of separating layout from recognition in our own design. [Architecture](https://github.com/zai-org/GLM-OCR).
- **dots.ocr / dots.mocr:** structured generative extraction with boxes, categories and reading order. The repository says dots.ocr-1.5 was renamed dots.mocr. Worth a later recognition comparison; it shares the transcript-to-PDF alignment questions above. [Project](https://github.com/studio-dots-ai/dots.ocr).
- **olmOCR:** useful as a quality reference, especially its benchmark, but its documented local GPU setup requires NVIDIA hardware and substantial disk space. Lower priority for our Mac/CPU-first integration. [Installation](https://github.com/allenai/olmocr).
- **Existing PDF geometry plus heuristics:** a useful model-free baseline for clean, single-column prose. We already have the text/positions, but would own heading, column and repeated-header logic. This should be evaluated as a limited mode, not assumed to generalize to complex books.

## Integration outline

The natural boundary is an ordered document-block artifact before chapter detection. Extract the existing chapter functions from Marker-specific I/O and preserve their behavior initially.

Each adapter should emit a versioned document with source identity/hash, engine and model revision, settings, page dimensions, coordinate frame, and ordered blocks. Blocks need stable IDs within an extraction, canonical kinds, original engine labels, text, page, polygon, optional heading level, and text provenance (native PDF, OCR layer, generated recognition). Keep inclusion policy in Libratory. Unknown labels must remain available for review.

Use typed unions and runtime validation. Normalize coordinate units, origin, rotation and crop offsets at the boundary. Preserve per-page provenance even when a parser merges paragraphs across page breaks.

Save raw engine output beside the normalized artifact. Add a reader for legacy Marker JSON so existing books still work. Change structure/proposal/apply/re-detection consumers to the common artifact. Index-based chapter proposals must carry an extraction revision so a proposal cannot be applied after a different engine changes the blocks.

Record engine choice separately from `ocrEngine`; per-book default plus per-file applied provenance fits multi-file books. Keep expensive engine switches explicit. Re-detection from existing blocks must remain distinct from re-running extraction. Preserve synthetic-book guards, inserted chapters, user edits and completed work; a comparison must not call the destructive existing re-detection/retry flows on the live book.

Use an isolated Python environment first, following the existing Pocket precedent. Add engine-specific model manifests/download status and explicit local paths. `HF_HUB_OFFLINE=1` does not govern every third-party downloader; verify inference with network access unavailable. Ship only the selected optional models. The existing 5.1 GB extraction bundle includes OCR as well as layout, so a small replacement layout model does not imply we can remove all of it while retaining Surya OCR.

Wrap inference with progress events, cancellation, explicit errors and no automatic cross-engine retry. Keep extraction-pool limits. Any UI choice belongs in Source files/Extract, with download size and device availability. A “try selected pages” comparison should preserve current chapters until the user explicitly applies extraction results.

## Proposed experiment and decision gates

1. Assemble 40–60 representative pages from 6–10 books: clean prose, multi-column, footnotes, nested TOC/headings, scanned/faded pages, Cyrillic including Bulgarian, tables, and rotated/cropped pages. Include known failures and adjacent pages where paragraphs cross boundaries.
2. On identical searchable PDFs, run pinned Marker, a pinned current Marker no-OCR version, Docling without OCR, and PP-DocLayoutV3 plus text association. Separately run Chandra on original page images to measure recognition improvements. Keep the two comparisons distinct.
3. Compare omitted/duplicated prose, word accuracy against checked transcriptions, reading-order errors, body/furniture classification, chapter heading recall and hierarchy, and coordinate alignment. Measure actual highlight coverage/precision as well as readable output. Inspect failures manually.
4. Measure cold start, warm pages/minute, peak RAM/VRAM, installed bytes and model bytes on Apple Silicon and Linux CPU; add CUDA when available. Do not rank whole pipelines using isolated model-inference timings.
5. Verify missing-model errors, offline operation and cancellation. Then run at least one long book through extraction, structure review, re-detection, synthesis and reader/export alignment. No installs or book processing have been performed during this research.

Planning estimates, not measured delivery promises: a constrained parser comparison can take a few engineering days once representative inputs are available; a production-quality shared artifact plus one selectable engine is approximately 1–2 engineering weeks, including migration, packaging and reader checks. Custom Paddle text association or a Chandra searchable-text/alignment path can add substantially more work.

The decision should follow the observed failure: choose a layout alternative for ordering/classification problems, a recognition alternative for wrong characters, and chapter-detection changes for correct headings split at the wrong tier. There is no evidence yet that one new engine should replace all three stages.
