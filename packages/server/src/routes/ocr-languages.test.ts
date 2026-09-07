import { describe, expect, it } from "vitest";

import { ocrLanguagesRouter } from "./ocr-languages.ts";
import { TESSDATA_LANGUAGES } from "../lib/tessdata-manifest.ts";

const caller = ocrLanguagesRouter.createCaller({});

describe("ocrLanguages router", () => {
  it("lists every pack in the manifest with an installed flag", async () => {
    const list = await caller.list();
    expect(list).toHaveLength(TESSDATA_LANGUAGES.length);
    expect(list.every((l) => typeof l.installed === "boolean")).toBe(true);
  });

  it("only knows the packs in the manifest", async () => {
    await expect(caller.download({ code: "klingon" })).rejects.toThrow(/Unknown language pack/);
    await expect(caller.remove({ code: "eng" })).rejects.toThrow(/English ships with the app/);
  });
});
