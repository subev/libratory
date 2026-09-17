export function extractionProgress(logs: { message: string }[]): string | null {
  let local: string | null = null;
  let currentPage: string | null = null;
  let ai: string | null = null;
  let cachedAi = 0;
  let output: string | null = null;
  for (const { message } of logs) {
    if (message === "Starting extraction" || message.startsWith("Extracting file ")) { local = null; currentPage = null; ai = null; cachedAi = 0; output = null; }
    const localCache = /^Local OCR: (\d+)\/(\d+) pages cached/.exec(message);
    const localSaved = /^Local OCR saved page \d+\/(\d+) — (\d+) pages cached/.exec(message);
    const oldLocal = /^OCR page (\d+)\/(\d+)/.exec(message);
    if (localCache) { local = `Local OCR ${localCache[1]}/${localCache[2]} saved`; currentPage = null; }
    else if (localSaved) { local = `Local OCR ${localSaved[2]}/${localSaved[1]} saved`; currentPage = null; }
    else if (oldLocal) {
      if (local?.endsWith("saved")) currentPage = `reading page ${oldLocal[1]}`;
      else local = `Local OCR page ${oldLocal[1]}/${oldLocal[2]}`;
    }
    const aiCache = /^AI transcription: (\d+)\/(\d+) pages cached/.exec(message);
    if (aiCache) { cachedAi = Number(aiCache[1]); ai = `AI ${cachedAi}/${aiCache[2]} saved`; }
    const aiDone = /^AI read page .*\((\d+)\/(\d+) done\)$/.exec(message);
    if (aiDone) ai = `AI ${Math.max(cachedAi, Number(aiDone[1]))}/${aiDone[2]} saved`;
    const aiSaved = /^AI read page .*\((\d+)\/(\d+) saved;/.exec(message);
    if (aiSaved) ai = `AI ${aiSaved[1]}/${aiSaved[2]} saved`;
    if (message === "Writing searchable PDF and reader geometry") output = message;
    if (/^Detected \d+ chapters|^Cancelled|^Extraction cancelled|^Extraction failed|^File .* failed:/.test(message)) { local = null; currentPage = null; ai = null; output = null; }
  }
  return output ?? ([local ? `${local}${currentPage ? ` (${currentPage})` : ""}` : null, ai].filter(Boolean).join(" · ") || null);
}
