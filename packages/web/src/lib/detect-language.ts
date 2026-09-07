import { franc } from "franc-min";

// Mirrors packages/server/src/lib/detect-language.ts: franc answers in ISO 639-3, the app's list is 639-1
const ISO1_BY_ISO3: Record<string, string> = {
  arb: "ar", bul: "bg", cmn: "zh", hrv: "hr", ces: "cs", dan: "da", nld: "nl", eng: "en", fin: "fi", fra: "fr",
  deu: "de", ell: "el", heb: "he", hin: "hi", hun: "hu", ind: "id", ita: "it", jpn: "ja", kor: "ko", nob: "no",
  pes: "fa", pol: "pl", por: "pt", ron: "ro", rus: "ru", spa: "es", swe: "sv", tur: "tr", ukr: "uk", vie: "vi",
  srp: "sr", slk: "sk", slv: "sl",
};

const MIN_CHARS = 200;

export function detectLanguage(text: string): string | null {
  if (text.trim().length < MIN_CHARS) return null;
  return ISO1_BY_ISO3[franc(text, { only: Object.keys(ISO1_BY_ISO3), minLength: MIN_CHARS })] ?? null;
}
