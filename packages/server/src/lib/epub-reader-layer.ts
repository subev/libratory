import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "linkedom";
import type { P2afLayer } from "./p2af.ts";
import { validateBilingualExport, writeP2afLayer } from "./readaloud-epub.ts";

const exec = promisify(execFile);

// Adds only text to the generated EPUB; its existing spine, styles and chapter files stay intact.
export async function attachTextReaderLayer(epub: string, workspace: string, layer: P2afLayer): Promise<void> {
  if (layer.cues.length || layer.sources.length || layer.manifest.chapters.some((chapter) => chapter.audio)
    || layer.bilingual?.some((entry) => entry.audio.length || entry.doc.source.narration || entry.doc.target.narration)) {
    throw new Error("Text EPUB reader layer cannot carry narration or PDFs");
  }
  await attachReaderLayer(epub, workspace, layer);
}

export async function attachReaderLayer(epub: string, workspace: string, layer: P2afLayer): Promise<void> {
  if (layer.sources.length) throw new Error("This EPUB layer does not package PDFs");
  const readEntry = async (entry: string) => (await exec("unzip", ["-p", epub, entry], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const parser = new DOMParser();
  const container = parser.parseFromString(await readEntry("META-INF/container.xml"), "text/xml");
  const packagePath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!packagePath || !/^[a-zA-Z0-9_./-]+\.opf$/.test(packagePath) || packagePath.split("/").includes("..") || path.isAbsolute(packagePath)) {
    throw new Error("Invalid EPUB package path");
  }
  const document = parser.parseFromString(await readEntry(packagePath), "text/xml");
  const manifest = document.querySelector("manifest");
  if (!manifest) throw new Error("EPUB package has no manifest");
  const resources = ["book.json", ...layer.cues.map((cue) => cue.path), ...(layer.texts ?? []).map((text) => text.path), ...(layer.bilingual ?? []).map((entry) => entry.path)];
  const audio = (layer.bilingual ?? []).flatMap((entry) => entry.audio);
  if (new Set(resources).size !== resources.length) throw new Error("Duplicate reader resource path");
  for (const [i, resource] of resources.entries()) {
    const item = document.createElement("item");
    item.setAttribute("id", `libratory_reader_${i}`);
    item.setAttribute("href", `p2af/${resource}`);
    item.setAttribute("media-type", "application/json");
    manifest.appendChild(item);
  }
  for (const [i, resource] of audio.entries()) {
    const item = document.createElement("item");
    item.setAttribute("id", `libratory_audio_${i}`);
    item.setAttribute("href", `p2af/${resource.path}`);
    item.setAttribute("media-type", resource.mediaType);
    manifest.appendChild(item);
  }
  const root = path.join(workspace, "reader-layer");
  const packageDir = path.dirname(packagePath);
  const layerDir = path.join(root, packageDir, "p2af");
  await mkdir(layerDir, { recursive: true });
  await writeP2afLayer(layerDir, layer);
  await validateBilingualExport(layerDir, layer);
  await writeFile(path.join(root, packagePath), document.toString());
  const audioDir = path.posix.join(packageDir, "p2af/audio");
  await exec("zip", ["-X", "-q", "-9", "-r", epub, packagePath, path.join(packageDir, "p2af"),
    ...(audio.length ? ["-x", `${audioDir}/*`] : [])], { cwd: root });
  if (audio.length) await exec("zip", ["-X", "-q", "-0", "-r", epub, audioDir], { cwd: root });
}
