# Legacy MP3 seek mismatch — 2026-09-28

The user trial of `long.epub` (The Three Sisters) found that clicking a sentence near the end
played words from the previous sentence, in both languages and more noticeably in Bulgarian.
The concrete report was clicking “Сега всички те се отправиха…” and hearing “Наистина…”.

## Reproduction and measured cause

Both saved recordings are variable-bitrate MP3s with Xing seek tables. The Bulgarian sentence
anchor requests 1657.499 seconds. A headless Chromium audio-element test, using a Blob URL as the
EPUB reader does, captured the actual decoded output through Web Audio. Cross-correlation against
a full sequential FFmpeg decode located the audio that was really played. Inspecting only
`audio.currentTime` would miss this: the element reports the requested position while playing
an earlier part of the recording.

Each capture buffer is 2048 samples at 8 kHz (256 ms). The table subtracts that capture latency
from the difference between the element clock and the matched waveform. Values are diagnostic
measurements on this browser, not guarantees for every browser or recording.

| Recording / requested position | MP3 audio early by | M4A audio early by |
| --- | ---: | ---: |
| English / 600.000 s | 0.635 s | -0.002 s |
| English / 1290.609 s | 4.530 s | 0.001 s |
| Bulgarian / 800.000 s | 4.263 s | 0.001 s |
| Bulgarian / 1657.499 s | 6.704 s | 0.000 s |

Waveform correlation for these matches was 0.965–0.999. An additional Bulgarian MP3 probe at
100 seconds did not produce a reliable match within the searched window; exclude it from timing
claims. Its raw capture is retained. The M4A probe there matched normally.

This is consistent with FFmpeg's own warning that MP3 TOC seeking may be imprecise
([decoder source](https://www.ffmpeg.org/doxygen/trunk/mp3dec_8c_source.html)). The browser
measurements, rather than that general warning, establish the error in these two files.

## Comparison artifact

`packages/server/data/tmp/bilingual-acceptance/long-m4a.epub` contains the same text, pairs,
anchors and speech, with both recordings converted to AAC in M4A (64 kbps, 44.1 kHz, mono,
fast-start). No synthesis, translation or linking calls were made. The comparison updates audio
references, OPF media types and SHA-256 narration revisions; the original EPUB and library audio
are untouched. Both hashes/references and unchanged text/pairs/anchors were checked.
The comparison also passed a focused offline reader check: both reported late-chapter sentences
play, Space pauses, and no page errors occur.

The local diagnostic scripts and raw captures are under that directory's `seek-audit/` folder.
They depend on local recordings, Playwright and the existing Python signal-analysis environment;
they are experiment artifacts, not a portable regression suite. Full decoded references and
conversion intermediates are in `/tmp/bilingual-{en,bg}-*`.

## Production follow-up

The [round 2 response](bilingual-reader-review-round-2-response.md) records the implemented
explicit conversion action and maintained acoustic check. It updates the active recording paths
for both live reading and future exports, retaining MP3 originals. The historical remaining-work
notes below describe the state before that follow-up; the native release gate remains open.

## Remaining work

The user repeated the click in the M4A comparison and confirmed it works correctly. An
independent review is being arranged by the user before further implementation. Neither lane
has provider word timestamps: the English sync map has 86 chunks and Bulgarian 74, with 253
paired passages. Sentence times inside those chunks remain estimates. Accurate media seeking
does not make those estimates acoustically exact, and no global timing offset should be applied.

New narration already uses M4A, but normal EPUB export currently copies legacy MP3s unchanged.
The comparison is **not a production exporter fix**. Before calling legacy-audio acceptance done,
choose and implement an explicit conversion path for old recordings, retaining existing text/link
artifacts, binding revisions to the converted bytes, and validating source snapshots before
conversion. Cover both primary and translated audio, ordinary-reader media overlays and bilingual
references. Include a focused acoustic-seek check; tests of the reported media clock alone cannot
catch this defect. Do not rewrite saved library recordings silently.
