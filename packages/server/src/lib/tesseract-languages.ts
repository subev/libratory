import { TESSDATA_LANGUAGES } from "./tessdata-manifest.ts";

// Mirrors packages/web/src/lib/languages.ts, plus codes that list has dropped but stored books carry.
const PACK_BY_ISO: Record<string, string> = {
  ar: "ara", bg: "bul", cs: "ces", da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", fa: "fas", fi: "fin",
  fr: "fra", he: "heb", hi: "hin", hr: "hrv", hu: "hun", id: "ind", it: "ita", ja: "jpn", ko: "kor", nl: "nld",
  no: "nor", pl: "pol", pt: "por", ro: "ron", ru: "rus", sk: "slk", sl: "slv", sr: "srp", sv: "swe", tr: "tur",
  uk: "ukr", vi: "vie", zh: "chi_sim",
  af: "afr", am: "amh", as: "asm", az: "aze", be: "bel", bn: "ben", bo: "bod", br: "bre", bs: "bos", ca: "cat", co: "cos",
  cy: "cym", dv: "div", dz: "dzo", eo: "epo", et: "est", eu: "eus", fo: "fao", fy: "fry", ga: "gle", gd: "gla", gl: "glg",
  gu: "guj", ht: "hat", hy: "hye", is: "isl", iu: "iku", jv: "jav", ka: "kat", kk: "kaz", km: "khm", kn: "kan", ku: "kmr",
  ky: "kir", la: "lat", lb: "ltz", lo: "lao", lt: "lit", lv: "lav", mi: "mri", mk: "mkd", ml: "mal", mn: "mon", mr: "mar",
  ms: "msa", mt: "mlt", my: "mya", ne: "nep", oc: "oci", or: "ori", pa: "pan", ps: "pus", qu: "que", sa: "san", sd: "snd",
  si: "sin", sq: "sqi", su: "sun", sw: "swa", ta: "tam", te: "tel", tg: "tgk", th: "tha", ti: "tir", tl: "fil", to: "ton",
  tt: "tat", ug: "uig", ur: "urd", uz: "uzb", yi: "yid", yo: "yor",
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

// What OSD's script name usually means, most common first; the book's own language wins when it is set.
const PACKS_BY_SCRIPT: Record<string, string[]> = {
  Latin: ["eng", "fra", "deu", "spa", "ita", "por", "nld", "pol", "ces", "hun", "ron", "tur", "swe", "dan", "fin", "nor", "hrv", "slv", "slk", "vie", "ind"],
  Cyrillic: ["bul", "rus", "ukr", "srp", "mkd", "bel"],
  Han: ["chi_sim", "chi_tra", "jpn"],
  Japanese: ["jpn"],
  Hangul: ["kor"],
  Arabic: ["ara", "fas", "urd"],
  Hebrew: ["heb"],
  Greek: ["ell"],
  Devanagari: ["hin", "mar", "nep", "san"],
  Thai: ["tha"],
  Armenian: ["hye"],
  Georgian: ["kat"],
  Bengali: ["ben"],
  Tamil: ["tam"],
  Telugu: ["tel"],
  Kannada: ["kan"],
  Malayalam: ["mal"],
  Gujarati: ["guj"],
  Gurmukhi: ["pan"],
  Sinhala: ["sin"],
  Khmer: ["khm"],
  Lao: ["lao"],
  Myanmar: ["mya"],
  Tibetan: ["bod"],
  Ethiopic: ["amh", "tir"],
  Syriac: ["syr"],
  Cherokee: ["chr"],
  Fraktur: ["frk", "deu"],
};

export function packsForScript(script: string | null): string[] {
  return script ? PACKS_BY_SCRIPT[script] ?? [] : [];
}
