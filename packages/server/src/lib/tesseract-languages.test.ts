import { describe, expect, it } from "vitest";

import { tesseractLanguage } from "./tesseract-languages.ts";

// Mirrors BOOK_LANGUAGE_OPTIONS in packages/web/src/lib/languages.ts, which the server cannot
// import. A code the dropdown offers and this table does not carry stops OCR on that book, so the
// two lists are checked against each other by hand here rather than assumed to agree.
const BOOK_LANGUAGE_CODES = [
  "ar", "bg", "hr", "cs", "da", "nl", "en", "fi", "fr", "de", "el", "he", "hi", "hu", "id",
  "it", "ja", "ko", "no", "pl", "pt", "ro", "ru", "sk", "es", "sv", "tr", "uk", "vi",
];

describe("tesseractLanguage", () => {
  it("maps every code the book-language dropdown offers", () => {
    for (const code of BOOK_LANGUAGE_CODES) {
      const language = tesseractLanguage(code);
      expect(language.pack, code).toMatch(/^[a-z_]+$/);
      expect(language.name, code).not.toBe("");
    }
  });

  it("reads a book with no language set as English", () => {
    expect(tesseractLanguage(null)).toEqual({ pack: "eng", name: "English" });
    expect(tesseractLanguage("")).toEqual({ pack: "eng", name: "English" });
  });

  it("names the code it cannot map instead of quietly reading the page as English", () => {
    expect(() => tesseractLanguage("xx")).toThrow(/"xx"/);
  });
});
