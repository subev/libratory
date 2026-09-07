import { TESSDATA_LANGUAGES } from "./tessdata-manifest.ts";

// Mirrors packages/web/src/lib/languages.ts, plus codes that list has dropped but stored books carry.
const PACK_BY_ISO: Record<string, string> = {
  ar: "ara", bg: "bul", cs: "ces", da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", fa: "fas", fi: "fin",
  fr: "fra", he: "heb", hi: "hin", hr: "hrv", hu: "hun", id: "ind", it: "ita", ja: "jpn", ko: "kor", nl: "nld",
  no: "nor", pl: "pol", pt: "por", ro: "ron", ru: "rus", sk: "slk", sl: "slv", sr: "srp", sv: "swe", tr: "tur",
  uk: "ukr", vi: "vie", zh: "chi_sim",
};

export type TesseractLanguage = { pack: string; name: string };

export function packName(pack: string): string {
  return TESSDATA_LANGUAGES.find((l) => l.code === pack)?.name ?? pack;
}

export function isoForPack(pack: string): string | null {
  return Object.entries(PACK_BY_ISO).find(([, p]) => p === pack)?.[0] ?? null;
}

export function tesseractLanguage(code: string | null): TesseractLanguage {
  if (!code) return { pack: "eng", name: "English" };
  const pack = PACK_BY_ISO[code.trim().toLowerCase()];
  if (!pack) throw new Error(`Tesseract has no language pack mapped for "${code}"`);
  return { pack, name: packName(pack) };
}
