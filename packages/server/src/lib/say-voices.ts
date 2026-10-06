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
  return matchSayVoice(await listSayVoices(), slug);
}

// macOS 27 lists "Samantha (English (US))" where earlier releases said "Samantha", so a voice id
// stored before the update no longer matches its slug. Falling back to the name without its
// parenthetical keeps such a book narrating; `say -v` accepts either spelling. An exact slug —
// "daria-enhanced" — still wins, and the first variant listed stands in for a bare name.
export function matchSayVoice(voices: SayVoice[], slug: string): SayVoice | null {
  return (
    voices.find((v) => v.slug === slug) ??
    voices.find((v) => sayVoiceSlug(v.name.replace(/\s*\(.*$/, "")) === slug) ??
    null
  );
}
