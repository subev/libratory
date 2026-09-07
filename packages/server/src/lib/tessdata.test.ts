import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { downloadPack, listOcrLanguages, manifestEntry, removePack, stageTessdata } from "./tessdata.ts";
import { TESSDATA_LANGUAGES } from "./tessdata-manifest.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tessdata-"));
  dirs.push(dir);
  return dir;
}

async function fakeSource(): Promise<string> {
  const source = await scratch();
  await mkdir(path.join(source, "configs"));
  await writeFile(path.join(source, "configs", "pdf"), "tessedit_create_pdf 1\n");
  await mkdir(path.join(source, "tessconfigs"));
  for (const f of ["pdf.ttf", "eng.traineddata", "osd.traineddata"]) await writeFile(path.join(source, f), f);
  return source;
}

describe("stageTessdata", () => {
  it("copies what a pdf run needs into an empty directory and leaves what is already there alone", async () => {
    const source = await fakeSource();
    const dir = path.join(await scratch(), "tessdata");
    await mkdir(dir);
    await writeFile(path.join(dir, "bul.traineddata"), "downloaded earlier");

    await stageTessdata(dir, async () => source);

    expect((await readdir(dir)).sort()).toEqual(["bul.traineddata", "configs", "eng.traineddata", "osd.traineddata", "pdf.ttf", "tessconfigs"]);
    expect((await stat(path.join(dir, "configs", "pdf"))).size).toBeGreaterThan(0);
  });

  it("never asks where the defaults live once everything is in place", async () => {
    const dir = await fakeSource();
    await stageTessdata(dir, async () => { throw new Error("should not be called"); });
  });
});

describe("manifest", () => {
  it("names every pack with its pinned size and checksum", () => {
    for (const l of TESSDATA_LANGUAGES) {
      expect(l.name.length).toBeGreaterThan(1);
      expect(l.bytes).toBeGreaterThan(0);
      expect(l.sha1).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(manifestEntry("eng").bytes).toBe(15400601);
    expect(manifestEntry("bul").bytes).toBe(8844613);
    expect(manifestEntry("chi_sim").name).toBe("Chinese, Simplified");
    expect(TESSDATA_LANGUAGES.some((l) => l.code === "osd")).toBe(false);
  });
});

describe("packs on disk", () => {
  it("reports a pack as installed when its file is present, with the book language it serves", async () => {
    const dir = await fakeSource();
    const list = await listOcrLanguages(dir);
    expect(list.find((l) => l.code === "eng")).toMatchObject({ installed: true, iso: "en", download: null });
    expect(list.find((l) => l.code === "bul")).toMatchObject({ installed: false, iso: "bg" });
    expect(list).toHaveLength(TESSDATA_LANGUAGES.length);
  });

  it("removes a downloaded pack but refuses the shipped English one", async () => {
    const dir = await fakeSource();
    await writeFile(path.join(dir, "bul.traineddata"), "x");
    expect(await removePack("bul", dir)).toEqual({ removed: true });
    expect(await removePack("bul", dir)).toEqual({ removed: false });
    await expect(removePack("eng", dir)).rejects.toThrow(/English ships with the app/);
    await expect(removePack("klingon", dir)).rejects.toThrow(/No language pack/);
  });

  it("downloads the smallest pack, verifies it against the pinned tree, and leaves no part file", async (ctx) => {
    const dir = await scratch();
    const smallest = [...TESSDATA_LANGUAGES].sort((a, b) => a.bytes - b.bytes)[0];
    if (!smallest) throw new Error("empty manifest");
    const progress = { received: 0, total: smallest.bytes, error: null };
    try {
      await downloadPack(smallest, dir, progress);
    } catch (err) {
      if (err instanceof Error && /reach|fetch failed|ENOTFOUND|EAI_AGAIN/.test(`${err.message} ${err.cause}`)) return ctx.skip();
      throw err;
    }
    expect((await stat(path.join(dir, `${smallest.code}.traineddata`))).size).toBe(smallest.bytes);
    expect(progress.received).toBe(smallest.bytes);
    expect(await readdir(dir)).toEqual([`${smallest.code}.traineddata`]);
  }, 60_000);
});
