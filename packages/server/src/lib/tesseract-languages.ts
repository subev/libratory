// Every code the book-language dropdown can produce (packages/web/src/lib/languages.ts, derived
// from TRANSLATION_LANGUAGES) plus the four that list drops today but a stored book may still
// carry. The name is what an error message shows, so it has to read like the option the user
// picked rather than a three-letter tessdata code nobody chose.
const TESSDATA_BY_CODE: Record<string, { pack: string; name: string }> = {
  ar: { pack: "ara", name: "Arabic" },
  bg: { pack: "bul", name: "Bulgarian" },
  cs: { pack: "ces", name: "Czech" },
  da: { pack: "dan", name: "Danish" },
  de: { pack: "deu", name: "German" },
  el: { pack: "ell", name: "Greek" },
  en: { pack: "eng", name: "English" },
  es: { pack: "spa", name: "Spanish" },
  fa: { pack: "fas", name: "Persian" },
  fi: { pack: "fin", name: "Finnish" },
  fr: { pack: "fra", name: "French" },
  he: { pack: "heb", name: "Hebrew" },
  hi: { pack: "hin", name: "Hindi" },
  hr: { pack: "hrv", name: "Croatian" },
  hu: { pack: "hun", name: "Hungarian" },
  id: { pack: "ind", name: "Indonesian" },
  it: { pack: "ita", name: "Italian" },
  ja: { pack: "jpn", name: "Japanese" },
  ko: { pack: "kor", name: "Korean" },
  nl: { pack: "nld", name: "Dutch" },
  no: { pack: "nor", name: "Norwegian" },
  pl: { pack: "pol", name: "Polish" },
  pt: { pack: "por", name: "Portuguese" },
  ro: { pack: "ron", name: "Romanian" },
  ru: { pack: "rus", name: "Russian" },
  sk: { pack: "slk", name: "Slovak" },
  sl: { pack: "slv", name: "Slovenian" },
  sr: { pack: "srp", name: "Serbian" },
  sv: { pack: "swe", name: "Swedish" },
  tr: { pack: "tur", name: "Turkish" },
  uk: { pack: "ukr", name: "Ukrainian" },
  vi: { pack: "vie", name: "Vietnamese" },
  zh: { pack: "chi_sim", name: "Chinese (Simplified)" },
};

export type TesseractLanguage = { pack: string; name: string };

const ENGLISH: TesseractLanguage = { pack: "eng", name: "English" };

// A book with no language set is read as English, which is what ships and what most scans are.
export function tesseractLanguage(code: string | null): TesseractLanguage {
  if (!code) return ENGLISH;
  const entry = TESSDATA_BY_CODE[code.trim().toLowerCase()];
  if (!entry) throw new Error(`Tesseract has no language pack mapped for "${code}"`);
  return entry;
}
