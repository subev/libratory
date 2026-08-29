import type { VariantRef } from "../components/ChapterTable.tsx";

// Source Serif carries Bulgarian localised letterforms, and OpenType only applies them when the
// text is marked as Bulgarian — unmarked, Bulgarians get Russian shapes from the right font.
export function readingLang(bookLanguage: string | null | undefined, variant?: VariantRef | null) {
  if (variant?.kind === "translation") return variant.key;
  return bookLanguage || undefined;
}
