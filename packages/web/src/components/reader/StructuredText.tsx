import type { ReactNode } from "react";
import type { ReaderText } from "../../lib/reader-doc.ts";

export function StructuredText({ document, render }: { document: ReaderText; render?: (start: number, end: number) => ReactNode }) {
  return document.blocks?.map((block, i) => {
    const previous = document.blocks?.[i - 1];
    const next = document.blocks?.[i + 1];
    const Tag = block.kind === "heading" ? "h2" : "div";
    return <section key={block.start} className={next?.breakBefore === "line" ? "mb-0" : "mb-4 last:mb-0"}>
      {block.kind === "footnote" && previous?.kind !== "footnote" ? <hr className="my-4 w-20 border-(--border)" aria-label="Footnotes" /> : null}
      <Tag role={block.kind === "footnote" ? "doc-footnote" : undefined}
        className={block.kind === "verse" ? "whitespace-pre-wrap" : block.kind === "heading" ? "text-xl font-semibold" : block.kind === "footnote" ? "text-base" : undefined}>
        {render ? render(block.start, block.end) : document.text.slice(block.start, block.end)}
      </Tag>
    </section>;
  });
}
