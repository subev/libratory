import { execFile } from "node:child_process";

export type SayVoice = {
  slug: string;
  name: string;
  locale: string;
  sample: string;
};

export function sayVoiceSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function parseSayVoiceList(output: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of output.split("\n")) {
    const [, rawName, locale, sample] = line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s*#\s?(.*)$/) ?? [];
    if (rawName === undefined || locale === undefined || sample === undefined) continue;
    const name = rawName.trim();
    voices.push({ slug: sayVoiceSlug(name), name, locale, sample: sample.trim() });
  }
  return voices;
}

let cached: Promise<SayVoice[]> | null = null;

export function listSayVoices(): Promise<SayVoice[]> {
  cached ??= new Promise<SayVoice[]>((resolve) => {
    execFile("say", ["-v", "?"], (err, stdout) => {
      resolve(err ? [] : parseSayVoiceList(String(stdout)));
    });
  });
  return cached;
}

export async function resolveSayVoice(slug: string): Promise<SayVoice | null> {
  const voices = await listSayVoices();
  return voices.find((v) => v.slug === slug) ?? null;
}
