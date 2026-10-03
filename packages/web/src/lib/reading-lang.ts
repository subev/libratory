import type { VariantRef } from "../components/ChapterTable.tsx";

// Source Serif carries Bulgarian localised letterforms, and OpenType only applies them when the
// text is marked as Bulgarian — unmarked, Bulgarians get Russian shapes from the right font.
export function readingLang(bookLanguage: string | null | undefined, variant?: VariantRef | null) {
  if (variant?.kind === "translation") return variant.key;
  return bookLanguage || undefined;
}

export function readingDirection(language: string): "rtl" | "ltr" | "auto" {
  try {
    const locale = new Intl.Locale(language);
    if (!locale.language || locale.language === "und") return "auto";
    const info: unknown = "getTextInfo" in locale && typeof locale.getTextInfo === "function"
      ? locale.getTextInfo() : "textInfo" in locale ? locale.textInfo : null;
    if (info && typeof info === "object" && "direction" in info && (info.direction === "rtl" || info.direction === "ltr")) return info.direction;
  } catch { /* Unknown tags retain the browser's content-based fallback. */ }
  return "auto";
}
