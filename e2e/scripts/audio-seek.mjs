// Acoustic seek check: the media clock alone can report the right time over the wrong MP3 audio.
// Usage: node e2e/scripts/audio-seek.mjs recording.m4a 800 1657.499
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const file = process.argv[2], targets = process.argv.slice(3).map(Number);
assert(file && targets.length && targets.every((time) => Number.isFinite(time) && time >= 0), "Pass an audio file and seek times in seconds");
const rate = 8000, block = 2048;
const dir = await mkdtemp(path.join(tmpdir(), "libratory-seek-"));
let browser;
try {
  const reference = path.join(dir, "reference.f32");
  await promisify(execFile)("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", reference], { timeout: 120_000 });
  const data = await readFile(reference);
  const pcm = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const encoded = await readFile(file);
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  await page.route("http://audio.test/**", (route) => route.fulfill(new URL(route.request().url()).pathname === "/"
    ? { contentType: "text/html", body: "<html><body>Audio seek check</body></html>" }
    : { contentType: file.endsWith(".mp3") ? "audio/mpeg" : "audio/mp4", body: encoded }));
  await page.goto("http://audio.test/");
  const captures = await page.evaluate(async ({ targets, rate, block }) => {
    const context = new AudioContext({ sampleRate: rate });
    const url = URL.createObjectURL(new Blob([await (await fetch("/audio")).arrayBuffer()]));
    const audio = new Audio(url);
    try {
      await new Promise((resolve, reject) => {
        audio.addEventListener("loadedmetadata", resolve, { once: true });
        audio.addEventListener("error", reject, { once: true });
      });
      const source = context.createMediaElementSource(audio), capture = context.createScriptProcessor(block, 1, 1);
      source.connect(capture); capture.connect(context.destination);
      await context.resume();
      const results = [];
      for (const target of targets) {
        if (target + 3 >= audio.duration) throw new Error("Choose a seek time at least three seconds before the end");
        if (audio.currentTime !== target) await new Promise((resolve) => {
          audio.addEventListener("seeked", resolve, { once: true });
          audio.currentTime = target;
        });
        results.push(await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out capturing playback")), 10_000);
          const samples = []; let clock;
          capture.onaudioprocess = (event) => {
            if (audio.currentTime < target + 0.6) return;
            clock ??= audio.currentTime;
            samples.push(...event.inputBuffer.getChannelData(0));
            if (samples.length >= block * 4) {
              capture.onaudioprocess = null; clearTimeout(timer); audio.pause();
              resolve({ target, clock, samples });
            }
          };
          void audio.play().catch((error) => { clearTimeout(timer); reject(error); });
        }));
      }
      return results;
    } finally { audio.pause(); await context.close(); URL.revokeObjectURL(url); }
  }, { targets, rate, block });

  for (const { target, clock, samples } of captures) {
    // A normalized waveform match also rejects silence or an unrelated passage in the window.
    const start = Math.max(0, Math.floor((target - 20) * rate));
    const end = Math.min(pcm.length - samples.length, Math.ceil((target + 20) * rate));
    function score(at, stride = 8) {
      let dot = 0, left = 0, right = 0;
      for (let i = 0; i < samples.length; i += stride) {
        const x = pcm[at + i], y = samples[i];
        dot += x * y; left += x * x; right += y * y;
      }
      return left && right ? dot / Math.sqrt(left * right) : 0;
    }
    let match = start, correlation = -1;
    for (let at = start; at <= end; at += 8) {
      const value = score(at);
      if (value > correlation) { correlation = value; match = at; }
    }
    const coarse = match;
    correlation = -1;
    for (let at = Math.max(start, coarse - rate / 20); at <= Math.min(end, coarse + rate / 20); at++) {
      const value = score(at, 1);
      if (value > correlation) { correlation = value; match = at; }
    }
    const errorMs = (clock - block / rate - match / rate) * 1000;
    console.log(JSON.stringify({ file, target, correlation, errorMs }));
    assert(correlation > 0.9, "No reliable waveform match; choose a non-silent passage");
    assert(Math.abs(errorMs) < 80, `Audio seek is ${Math.round(errorMs)} ms away from the reported clock`);
  }
} finally { await browser?.close(); await rm(dir, { recursive: true, force: true }); }
