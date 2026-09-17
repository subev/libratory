import { useState } from "react";
import type { ExtractionSettings } from "../../../server/src/lib/extraction-presets.ts";
import { trpc } from "../trpc.ts";
import { Button } from "./Button.tsx";

export function ExtractionPresetEditor({ value, onChange, disabled }: {
  value: ExtractionSettings | null; onChange: (value: ExtractionSettings) => void; disabled: boolean;
}) {
  const presets = trpc.extractionPresets.list.useQuery();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const save = trpc.extractionPresets.save.useMutation({ onSuccess: (preset) => { setSelectedId(preset?.id ?? null); setName(""); void utils.extractionPresets.list.invalidate(); } });
  const remove = trpc.extractionPresets.remove.useMutation({ onSuccess: () => { void utils.extractionPresets.list.invalidate(); } });
  const settings = value ?? presets.data?.[0]?.settings;
  const matching = presets.data?.filter((p) => p.settings.prompt === settings?.prompt && p.settings.lineOrdering === settings?.lineOrdering && p.settings.orderingPrompt === settings?.orderingPrompt
    && Boolean(p.settings.omitVerseCounters) === Boolean(settings?.omitVerseCounters));
  const active = matching?.find((p) => p.id === selectedId) ?? matching?.[0];
  if (!settings) return <p className="text-sm text-(--text-muted)">{presets.error?.message ?? "Loading extraction presets…"}</p>;
  const pending = disabled || save.isPending || remove.isPending;
  return <fieldset disabled={pending} className="space-y-3" data-testid="extraction-presets">
    <label className="block text-sm text-(--text-secondary)">Prompt preset
      <select className="mt-1 w-full rounded border border-(--border) bg-(--bg-input) px-3 py-2" value={active?.id ?? "custom"}
        onChange={(e) => { const preset = presets.data?.find((p) => p.id === e.target.value); if (preset) { setSelectedId(preset.id); onChange(preset.settings); } }}>
        <option value="custom" disabled>Custom instructions</option>
        {presets.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    <label className="block text-sm text-(--text-secondary)">Transcription instructions
      <textarea className="mt-1 w-full rounded border border-(--border) bg-(--bg-input) px-3 py-2 text-sm" rows={6} maxLength={20000}
        value={settings.prompt} onChange={(e) => onChange({ ...settings, prompt: e.target.value })} />
    </label>
    <label className="flex gap-2 text-sm text-(--text-secondary)">
      <input type="checkbox" checked={settings.lineOrdering} onChange={(e) => onChange({ ...settings, lineOrdering: e.target.checked })} />
      Order detected lines before transcription
    </label>
    {settings.lineOrdering && <>
      <p className="text-xs text-(--text-muted)">Uses the installed Surya models and an extra AI call per page. Invalid ordering stops extraction for review. Original groups and notes are retained. Isolated page numbers confirmed at the page edge are excluded from narration.</p>
      <label className="block text-sm text-(--text-secondary)">Reading-order instructions
        <textarea className="mt-1 w-full rounded border border-(--border) bg-(--bg-input) px-3 py-2 text-sm" rows={4} maxLength={10000}
          value={settings.orderingPrompt} onChange={(e) => onChange({ ...settings, orderingPrompt: e.target.value })} />
      </label>
      <label className="flex gap-2 text-sm text-(--text-secondary)">
        <input type="checkbox" checked={settings.omitVerseCounters ?? false} onChange={(e) => onChange({ ...settings, omitVerseCounters: e.target.checked })} />
        Remove margin verse counters after ordering
      </label>
      <p className="text-xs text-(--text-muted)">For verse numbered every five lines. Uses measured margin positions; keeps the original transcription and records removals. Review unusual layouts before narration.</p>
    </>}
    <div className="flex gap-2">
      <input aria-label="New preset name" placeholder="Name this preset" className="min-w-0 flex-1 rounded border border-(--border) bg-(--bg-input) px-3 py-2 text-sm" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <Button variant="secondary" disabled={pending || !name.trim() || !settings.prompt.trim()} onClick={() => save.mutate({ name, settings })}>Save preset</Button>
      {active && !active.builtIn && <Button variant="danger" soft disabled={pending} onClick={() => remove.mutate({ id: active.id })}>Delete preset</Button>}
    </div>
    {(save.error || remove.error) && <p className="text-sm text-(--danger-text)">{save.error?.message ?? remove.error?.message}</p>}
  </fieldset>;
}
