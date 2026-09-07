import { useState } from "react";
import { trpc } from "../trpc.ts";
import { formatBytes } from "../lib/format.ts";
import { useOcrLanguages } from "../lib/use-ocr-languages.ts";
import { Button } from "./Button.tsx";

export function OcrLanguagePacksSettings() {
  const utils = trpc.useUtils();
  const { languages, error } = useOcrLanguages();
  const [picked, setPicked] = useState("");
  const invalidate = () => void utils.ocrLanguages.list.invalidate();
  const download = trpc.ocrLanguages.download.useMutation({ onSuccess: invalidate });
  const remove = trpc.ocrLanguages.remove.useMutation({ onSuccess: invalidate });

  const installed = languages.filter((l) => l.installed);
  const available = languages.filter((l) => !l.installed);
  const failed = languages.filter((l) => l.download?.error);

  return (
    <section data-testid="settings-ocr-languages">
      <h3 className="text-sm font-semibold text-(--text-primary) mb-1">OCR language packs</h3>
      <p className="text-xs text-(--text-muted) mb-2">
        Tesseract reads a scanned page with one data pack per language. English ships with the app; every other
        language is a download of a few megabytes, kept beside it and used offline from then on.
      </p>
      {error && <p className="text-xs text-(--danger-text)" data-testid="settings-ocr-languages-error">{error.message}</p>}
      <div className="rounded-md border border-(--border) p-3 space-y-2">
        <ul className="space-y-1 text-sm">
          {installed.map((l) => (
            <li key={l.code} className="flex items-center gap-2" data-testid={`settings-ocr-pack-${l.code}`}>
              <span className="text-(--text-primary)">{l.name}</span>
              <span className="text-xs text-(--text-muted)">{formatBytes(l.bytes)}</span>
              {l.code !== "eng" && (
                <Button size="sm" className="ml-auto" onClick={() => remove.mutate({ code: l.code })} disabled={remove.isPending} data-testid={`settings-ocr-pack-${l.code}-remove`}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {languages.some((l) => l.download && !l.download.error) && (
          <ul className="space-y-1 text-xs text-(--text-muted)">
            {languages.filter((l) => l.download && !l.download.error).map((l) => (
              <li key={l.code} data-testid={`settings-ocr-pack-${l.code}-downloading`}>
                Downloading {l.name}… {Math.min(99, Math.round(((l.download?.received ?? 0) / l.bytes) * 100))}% of {formatBytes(l.bytes)}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 text-xs">
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="min-w-0 flex-1 rounded border border-(--border-input) bg-(--bg-input) px-1.5 py-1 text-xs"
            data-testid="settings-ocr-pack-select"
          >
            <option value="">Add a language…</option>
            {available.map((l) => (
              <option key={l.code} value={l.code}>{l.name} — {formatBytes(l.bytes)}</option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { download.mutate({ code: picked }); setPicked(""); }}
            disabled={!picked || download.isPending}
            data-testid="settings-ocr-pack-download"
          >
            Download
          </Button>
        </div>
        {(failed.length > 0 || download.error || remove.error) && (
          <p className="text-xs text-(--danger-text)" data-testid="settings-ocr-pack-error">
            {failed.map((l) => `${l.name}: ${l.download?.error}`).join(" · ") || download.error?.message || remove.error?.message}
          </p>
        )}
      </div>
    </section>
  );
}
