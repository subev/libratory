import { useId } from "react";
import { Button } from "../Button.tsx";
import type { bilingualExportStatus, BilingualExportOptions as AudioChoice } from "../../../../server/src/lib/bilingual-export.ts";

export function BilingualExportOptions({ originalLanguage, translationLanes, exportTranslation, onTranslation,
  bilingualAudio, onAudio, bilingualRows, selectedCount, bilingualReason, onPrepare, pages }: {
  originalLanguage: string | null;
  translationLanes: { key: string; label: string }[];
  exportTranslation: string;
  onTranslation: (key: string) => void;
  bilingualAudio: AudioChoice;
  onAudio: (choice: AudioChoice) => void;
  bilingualRows: Awaited<ReturnType<typeof bilingualExportStatus>>;
  selectedCount: number;
  bilingualReason?: string;
  // Opens the pairing panel for the unpaired chapters; the export dialog comes back afterwards
  onPrepare?: () => void;
  // A printed book: its pages ride along with the original recording
  pages?: boolean;
}) {
  const translationId = useId();
  const unpaired = bilingualRows.filter((row) => !row.paired);
  return <div className="space-y-3 text-sm" data-testid="bilingual-export-options">
    <p>Original: {originalLanguage ?? "original language"}</p>
    <label htmlFor={translationId} className="block">Translation</label>
    <select id={translationId} className="block w-full" value={exportTranslation} onChange={(event) => onTranslation(event.target.value)}>
      {translationLanes.map((lane) => <option key={lane.key} value={lane.key}>{lane.label}</option>)}
    </select>
    <fieldset className="space-y-2">
      <legend className="mb-1 font-semibold">Include available recordings</legend>
      <label className="flex items-center gap-2"><input type="checkbox" checked={bilingualAudio.sourceAudio}
        onChange={(event) => onAudio({ ...bilingualAudio, sourceAudio: event.target.checked })} />
        Original ({bilingualRows.filter((row) => row.source.available).length}/{selectedCount} chapters)
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={bilingualAudio.targetAudio}
        onChange={(event) => onAudio({ ...bilingualAudio, targetAudio: event.target.checked })} />
        {exportTranslation} ({bilingualRows.filter((row) => row.target.available).length}/{selectedCount} chapters)
      </label>
    </fieldset>
    <p className="text-xs text-(--text-muted)">{bilingualRows.filter((row) => row.paired).length}/{selectedCount} chapters paired.
      Word links in {bilingualRows.reduce((sum, row) => sum + row.linkedGroups, 0)}/{bilingualRows.reduce((sum, row) => sum + row.matchedGroups, 0)} matched sentence groups.
      Word timing present: original {bilingualRows.filter((row) => row.source.words).length}/{selectedCount}, translation {bilingualRows.filter((row) => row.target.words).length}/{selectedCount}.
      Chapters without recordings remain readable. Uncheck both for text only.
      {pages && (bilingualAudio.sourceAudio ? " The original pages come along, for reading the print beside the translation." : " Include the original recording to bring the pages along.")}</p>
    {bilingualRows.some((row) => bilingualAudio.sourceAudio && row.source.legacy || bilingualAudio.targetAudio && row.target.legacy) &&
      <p className="text-xs text-(--warning-text)">Older MP3 recordings may seek inaccurately. Convert them in Bilingual reading before exporting.</p>}
    {bilingualReason && <p role="status" className="text-xs text-(--text-muted)">{bilingualReason}</p>}
    {unpaired.length > 0 && onPrepare &&
      <Button size="sm" onClick={onPrepare} title={`Pair ${unpaired.length} chapter${unpaired.length === 1 ? "" : "s"} with ${exportTranslation}, then come back to export`} data-testid="bilingual-export-pair">
        Pair sentences… ({unpaired.length})
      </Button>}
    <p className="text-xs text-(--text-muted)">Exports prepared work only. No translation, linking or narration jobs are started.</p>
  </div>;
}
