# Read-along: the documents the reader consumes

The reader in `packages/web/src/pages/Reader.tsx` draws a book's own PDF page and highlights
the sentence being spoken. It reads two JSON documents and nothing else — no database row, no
tRPC call. That constraint is the point: anything the documents fail to carry shows up in the
reader immediately, and a second implementation of these documents needs nothing from this
codebase but this page.

Both documents carry `"format": "p2af/1"`. A reader should check the major version, open
anything it recognises, and say something useful about anything it does not.

## `GET /read/book/:bookId/book.json`

```jsonc
{
  "format": "p2af/1",
  "book":    { "id": "…", "title": "…", "author": "Mary Shelley", "language": "en",
               "medianBodyPt": 11.7, "cover": "../images/cover.jpg" },
  "sources": [ { "index": 0, "filename": "book.pdf", "url": "/pdf/…", "pageCount": 294 } ],
  "pages":   [ { "i": 0, "src": 0, "p": 1, "w": 311, "h": 487, "rot": 0,
                 "content": [43, 45.7, 228.6, 387], "columns": [[43, 45.7, 228.6, 387]] } ],
  "chapters":[ { "i": 0, "id": "…", "title": "…",
                 "audio": "/audio/chapter/…", "cues": "/read/chapter/…/cues.json",   // both null when unnarrated
                 "durationMs": 2706000, "pageStart": 168, "pageEnd": 180, "mode": "page" } ]
}
```

- **`pages` is flat across a book's PDFs.** A book can have several source files; `i` counts
  pages across all of them in order and `src` says which file a page came from. Chapter
  `pageStart`/`pageEnd` are flat indices too, so a reader never has to do this arithmetic — and
  `p` is the page's number inside its own PDF, which is what a PDF renderer asks for, so the
  inverse arithmetic is not needed either.
- **`w`, `h`, `content` and `columns` are PDF points**, origin top-left, y downwards. `content`
  is the union of the page's text lines; `columns` are the column boxes in reading order, one
  entry for a single-column page. Both are `[x, y, width, height]`.
- **`medianBodyPt`** is the median height of a text line, weighted by how much text the line
  holds — not the font size the PDF reports, which several real files give as 1pt or 53pt for
  ordinary 10pt text. It is what tells a reader, before the reader squints, whether this book
  can be read at a given width.
- **`author` and `cover` are both null when nothing knows them.** The author is the book's own,
  taken from the PDF's metadata where it has any and editable on the book page; a container carries
  a cover and says where it is, while the server serves none.
- **`audio` and `cues` are both null for a chapter nobody has narrated.** There is no cue document
  to fetch, and a container cannot carry a path to a file it does not hold.
- **Every URL is relative to `book.json` itself.** Served from `/read/book/:id/book.json` these are
  root-relative and name routes on this server; inside a container they name entries beside it.
- **`mode`** says whether the chapter can be *marked*, not whether it has pages: `"page"` when
  the spoken text can be pinned to the PDF, `"text"` when it cannot. A `"text"` chapter still
  lists its `pageStart`/`pageEnd`, and both surfaces still draw those pages — the pages come from
  the PDF, so they are there long before a word is spoken. `mode` carries **`why`**: `"edited"`
  (a chapter whose text was changed after extraction), `"generated"` (text that was written
  rather than extracted), `"unnarrated"` (nothing has spoken it yet, and the map is written while
  a chapter is narrated), or `"unmapped"` (narrated before the map existed, so narrating it again
  writes one). The last two are the same missing map for opposite reasons, and the document
  separates them so neither reader has to work it out from `audio`.
  Only a chapter with no pages at all falls back to the reflowed text.

## `GET /read/chapter/:chapterId/cues.json`

```jsonc
{
  "format": "p2af/1",
  "totalMs": 2706000,
  "granularity": "word",
  "marks": "word",
  "cues": [
    { "t": [0, 4210],
      "s": "Such a study would indeed be of great interest.",
      "c": 0,
      "r": [[168, 1641, 6550, 7068, 243]],
      "w":  [[0, 488, "Such"], [488, 550, "a"], [550, 900, "study"]],
      "wr": [[[168, 1641, 6550, 325, 243]], [[168, 2010, 6550, 90, 243]], [[168, 2140, 6550, 520, 243]]] }
  ]
}
```

- **`t`** is `[startMs, endMs]` into the chapter's audio. Cues are ordered and non-overlapping;
  there can be gaps between them, and a reader should keep the last cue lit across a gap rather
  than blinking the highlight out.
- **`c`** is the synthesis chunk the cue was cut from, counting from zero. Several cues share a
  chunk where the engine timed words. It is what lets a chunk and the print it became light each
  other up: the chapter modal's chunk previews are the same chunks in the same order, one-based
  because they are labelled and named after `chunk-001.wav`.
- **`s`** is the spoken text. Concatenated in order, the cues *are* the chapter's text — which
  is why a reflowed text view needs no further document.
- **`r`** is a list of `[page, x, y, width, height]`, where `page` is the flat page index and
  the rest are **ten-thousandths of that page's box**, origin top-left — a percentage of the
  rendered page is the same number divided by a hundred. Absent when the cue has no place on
  the page.
- **`w`** is `[startMs, endMs, word]` per word, present only where the engine reported timings.
- **`wr`** is the rects for each word, index-aligned with `w`, so the page can mark the word being
  spoken inside the sentence. An entry is empty for a word that has no place on the page — a comma
  or full stop — and word rects never fall back to the paragraph box the way a cue's do: a
  word-sized highlight covering a whole block is worse than none.

Rects dominate the size of a chapter's cues: roughly 11 KB per minute of audio once words are
placed, so a ten-hour book carries about 6 MB of them against 200-300 MB of audio.

### `granularity`

Says what a highlight actually means, so a reader can be honest about it:

| value | meaning |
| --- | --- |
| `word` | every cue is a sentence and carries word timings |
| `sentence` | some chunks carried word timings and became sentences; the rest are whole chunks |
| `chunk` | no word timings — one highlight is a whole synthesis chunk, often a paragraph |

Kokoro reports word timings during synthesis. Engines chunked a sentence at a time (macOS
`say`, MMS) land on sentence-sized chunks without them. The Bulgarian MLX narrator emits a fixed
~20–24 s per chunk by design and stays at `chunk`, as does any audio synthesized before word
timings existed.

### `marks`

Says what the *print* can carry, which is not the same question:

| value | meaning |
| --- | --- |
| `word` | the pages have a text layer, so a cue's words can be marked where they sit |
| `paragraph` | the pages carry no text layer; every cue falls back to the block it sits in, and `wr` is empty throughout |

Absent means nobody could measure it, which a reader should read as markable — containers written
before the field carry no answer, and neither does a chapter whose page geometry failed to build
or which never landed on a page. Saying nothing is deliberate: the alternative is telling someone
their book has no text layer on the strength of a missing file.

The two fields are independent, and a reader that conflates them will say the wrong thing. A scan
narrated by Kokoro is `granularity: "word"` with `marks: "paragraph"` — the voice is measured to
the word and the page cannot show it. The reverse is just as common: a born-digital book narrated
by the Bulgarian MLX narrator is `chunk` and `word`.

## How the rectangles are produced

1. `chapters.text_map` records where each source block starts and ends inside `cleanText`,
   written by the normalize worker (`lib/normalizer.ts`, `workers/normalize.ts`).
2. A cue's text is located in `cleanText` (`locateChunks`), giving a character range, which the
   text map resolves to source blocks and a sub-range within each.
3. `scripts/page_geometry.py` extracts, per page, the line boxes and one x edge per character
   straight from pdfium via `pdftext` — no model, about four seconds for a 300-page book, and it
   works on books extracted long ago. Cached beside the extraction output as `geometry.json`.
   A line's box is the reported one grown to the ink its characters actually cover: pdfium's
   per-character box runs baseline to ascender in some fonts, which would leave every descender
   hanging outside its own highlight. Only the height grows — the x edges stay the advances a
   character range is measured along.
4. `lib/cue-rects.ts` finds the block's lines geometrically, looks the cue's characters up in
   them — both sides reduced to letters and digits, so markdown stripping and hyphen joins can't
   defeat the match — and turns the result into rects.

The ladder, coarser but never wrong: character-exact line rects → the whole line → the block's
box → nothing at all when the page's geometry is unknown. A range crossing many lines becomes
the shape a text selection takes: partial first line, solid middle, partial last.

## Carrying the documents in a file

The synced EPUB export (`lib/readaloud-epub.ts`) carries these documents alongside the reflowed
text and media overlays it already produced, under `OEBPS/p2af/`:

```
OEBPS/chNNN.xhtml, chNNN_overlay.smil   reflowed text and its media overlay
OEBPS/audio/chNNN.m4a                   one copy, shared by both layers
OEBPS/p2af/book.json                    the manifest, urls relative to itself
OEBPS/p2af/cues/chNNN.json              one per narrated chapter
OEBPS/p2af/source/NN.pdf                the original, untouched
```

The extra entries are manifested in `package.opf` but kept out of the spine, so a reader that
knows nothing about them opens an ordinary read-along audiobook, and one that does draws the
pages. The audio and the PDFs are **stored rather than deflated**, which lets a reader hand a
slice of the file straight to a player or a PDF renderer without inflating anything —
`lib/zip.ts` in the web package does exactly that, with no dependency beyond `DecompressionStream`.

A chapter the export left out keeps its `pageStart`/`pageEnd` and loses its `audio` and `cues`,
which is the same shape as a chapter nobody has narrated — so no reader needs a special case for
a partial export.

`e2e/fixtures/tiny-book-readalong.epub` is one of these, built from `fixtures/tiny-book.pdf` by
the pipeline itself: three pages, three narrated chapters, word granularity, 1.2 MB. It is checked
in because it is what a second implementation of this page is written against.

`/open` reads such a file with no server involved: `lib/reader-source.ts` is the seam, with one
implementation over HTTP and one over a container. Nothing that draws a page knows which it got.
