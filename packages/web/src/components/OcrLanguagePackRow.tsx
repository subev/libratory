import { useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.ts";
import { formatBytes } from "../lib/format.ts";
import { useOcrLanguages } from "../lib/use-ocr-languages.ts";
import { Button } from "./Button.tsx";
import { IconCheck, IconDownload, IconOffline } from "./icons.tsx";

// The full-width row that gets someone the pack they are missing without leaving where they are.
export function OcrLanguagePackRow({
  code,
  onInstalled,
  installedHint = "Selected and ready.",
  offlineHint,
}: {
  code: string;
  onInstalled?: () => void;
  installedHint?: string;
  offlineHint?: string;
}) {
  const utils = trpc.useUtils();
  const { languages } = useOcrLanguages();
  const download = trpc.ocrLanguages.download.useMutation({ onSuccess: () => void utils.ocrLanguages.list.invalidate() });
  const [startedHere, setStartedHere] = useState(false);
  const lang = languages.find((l) => l.code === code);
  const justInstalled = Boolean(lang?.installed && startedHere);
  const notified = useRef(false);
  useEffect(() => {
    if (!justInstalled || notified.current) return;
    notified.current = true;
    onInstalled?.();
  }, [justInstalled, onInstalled]);
  if (!lang) return null;

  const size = formatBytes(lang.bytes);
  if (lang.installed) {
    if (!justInstalled) return null;
    return (
      <div className="flex items-start gap-2 rounded-md bg-(--success-bg) px-3 py-2 text-xs text-(--success-text)" data-testid={`ocr-pack-${code}-installed`}>
        <IconCheck className="mt-0.5 shrink-0" />
        <span><span className="font-medium">{lang.name} installed.</span> {installedHint}</span>
      </div>
    );
  }

  const active = lang.download && !lang.download.error ? lang.download : null;
  if (active) {
    const pct = Math.min(99, Math.round((active.received / active.total) * 100));
    return (
      <div className="rounded-md bg-(--accent-subtle) px-3 py-2 text-xs text-(--text-secondary) space-y-1.5" data-testid={`ocr-pack-${code}-downloading`}>
        <div className="flex items-start gap-2">
          <IconDownload className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium text-(--text-primary)">Downloading {lang.name}…</span> It lands in the same folder as the
            shipped packs; the run can start the moment it finishes.
          </span>
        </div>
        <div className="h-1 rounded bg-(--bg-subtle)"><div className="h-1 rounded bg-(--accent)" style={{ width: `${pct}%` }} /></div>
        <div className="text-(--text-muted)">{pct}% of {size}</div>
      </div>
    );
  }

  const error = lang.download?.error ?? download.error?.message ?? null;
  const offline = error?.includes("Could not reach") ?? false;
  const start = () => {
    setStartedHere(true);
    download.mutate({ code });
  };
  if (offline) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-(--bg-subtle) px-3 py-2 text-xs text-(--text-muted)" data-testid={`ocr-pack-${code}-offline`}>
        <IconOffline className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-(--text-secondary)">No network.</span> {lang.name} ({size}) can't be fetched right now.
          {offlineHint ? ` ${offlineHint}` : ""}
        </span>
        <Button size="sm" onClick={start} disabled>Download</Button>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md bg-(--accent-subtle) px-3 py-2 text-xs text-(--text-secondary)" data-testid={`ocr-pack-${code}-needed`}>
      <IconDownload className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-(--text-primary)">{lang.name}, {size}.</span> Tesseract needs a data pack per language.
        The app ships English only, so this one is a download.
        {error && <span className="block text-(--danger-text)" data-testid={`ocr-pack-${code}-error`}>{error}</span>}
      </span>
      <Button variant="primary" size="sm" onClick={start} disabled={download.isPending} data-testid={`ocr-pack-${code}-download`}>
        Download
      </Button>
    </div>
  );
}
