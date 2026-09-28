import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  linkedTokens, passageIndex, pairAtTime, switchNarration, tokenAtTime,
  type BilingualDocument, type BilingualPair, type BilingualSide,
} from "../../../../server/src/lib/bilingual-format.ts";
import type { DocumentSource } from "../../lib/reader-source.ts";
import type { ReaderChapter, ReaderManifest } from "../../lib/reader-doc.ts";
import { useAudioTime } from "../../lib/use-audio-time.ts";
import { usePlayPauseKey } from "../../lib/play-pause-key.ts";
import { SPEEDS, loadSpeed, saveSpeed } from "../../lib/playback-speed.ts";
import { formatDuration } from "../../lib/format.ts";
import { followCue } from "../../lib/cue-follow.ts";
import { languageLabel as language } from "../../lib/voices.ts";
import { paragraphGroups, pairPresentation, listenPosition, linkedText, sharesPrimaryRecording } from "../../lib/bilingual-reading.ts";
import { WordMeaning, useWordMeaning } from "./WordMeaning.tsx";
import { Button } from "../Button.tsx";
import { IconPause, IconPlay } from "../icons.tsx";

const BAND = { top: 160, bottom: 100, landing: 0.3 };
const SIDES = ["source", "target"] as const;

type Props = {
  doc: BilingualDocument;
  source: DocumentSource;
  manifest: ReaderManifest;
  chapter: ReaderChapter;
  controls: ReactNode;
  onChapter: (index: number) => void;
  onExit: () => void;
  initialMs: number;
  onPosition: (ms: number) => void;
  bookId?: string;
};

export function BilingualReader({ doc, source, manifest, chapter, controls, onChapter, onExit, bookId, initialMs, onPosition }: Props) {
  const [side, setSide] = useState<BilingualSide>("source");
  const [ms, setMs] = useState(Math.max(0, initialMs));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(loadSpeed);
  const [message, setMessage] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [inspectMode, setInspectMode] = useState(false);
  const meaning = useWordMeaning();
  const selection = meaning.selection;
  const groups = useMemo(() => paragraphGroups(doc), [doc]);
  const presentation = useMemo(() => ({ source: pairPresentation(doc, "source"), target: pairPresentation(doc, "target") }), [doc]);
  const timing = useMemo(() => passageIndex(doc), [doc]);
  const firstPair = doc.pairs[0];
  const heading = firstPair?.source && doc.source.text.slice(...firstPair.source).trim() === chapter.title.trim() ? firstPair.id : null;
  const audioRef = useRef<HTMLAudioElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const landing = useRef({ ms: Math.max(0, initialMs), play: false });
  const lane = doc[side];
  const activePair = pairAtTime(doc, side, ms, timing);
  const activeToken = tokenAtTime(lane, ms);
  const counterpart = activePair && activeToken ? linkedTokens(activePair, side, activeToken.id) : null;
  useAudioTime(audioRef, playing, setMs);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio?.getAttribute("src")) return false;
    if (audio.paused) void audio.play().catch(() => setMessage("Playback could not start. Try Play again."));
    else audio.pause();
    return true;
  }, []);
  usePlayPauseKey(togglePlay);

  useEffect(() => {
    if (following && !selection && content.current) followCue({ ...BAND, top: (toolbar.current?.offsetHeight ?? BAND.top) + 12 }, { root: content.current });
    // The marks move when these IDs change; the effect follows the resulting DOM geometry.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [activePair?.id, activeToken?.id, side, following, selection]);
  useEffect(() => {
    const sourceMs = side === "source" ? ms : switchNarration(doc, side, ms, timing)?.ms;
    if (sourceMs !== undefined) onPosition(sharesPrimaryRecording(doc, chapter.audio) ? sourceMs : 0);
  }, [doc, timing, chapter.audio, side, ms, onPosition]);

  function listen(nextSide: BilingualSide, at: number, play: boolean) {
    setMessage(null);
    meaning.dismiss();
    setFollowing(true);
    landing.current = { ms: at, play };
    if (nextSide === side) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = at / 1000;
        if (play) void audio.play().catch(() => setMessage("Playback could not start. Try Play again."));
      }
    } else {
      audioRef.current?.pause();
      setPlaying(false);
      setSide(nextSide);
    }
    setMs(at);
  }

  function changeVoice(nextSide: BilingualSide) {
    if (nextSide === side) return;
    const landing = switchNarration(doc, side, ms, timing);
    if (!lane.narration) { listen(nextSide, 0, false); return; }
    if (!landing) { setMessage("No timed counterpart here. Click a word in the other language to listen there."); return; }
    listen(landing.side, landing.ms, playing);
  }

  const selectedPair = doc.pairs.find((pair) => pair.id === selection?.pair);
  const selected = selectedPair && selection ? linkedTokens(selectedPair, selection.side, selection.token) : null;
  const renderPair = (pair: BilingualPair, textSide: BilingualSide) => {
    const textLane = doc[textSide], range = pair[textSide];
    if (!range) return null;
    const layout = presentation[textSide].get(pair.id);
    if (!layout) return null;
    const pieces: ReactNode[] = [];
    for (const { token, before, text } of layout.tokens) {
      pieces.push(before);
      const speaking = textSide === side && activeToken?.id === token.id;
      const linked = textSide !== side && counterpart?.[textSide].includes(token.id);
      const inspected = selection?.pair === pair.id && (selected?.[textSide].includes(token.id) || (selection.side === textSide && selection.token === token.id));
      pieces.push(
        <button
          key={token.id}
          type="button"
          aria-label={`Listen from ${textLane.text.slice(...token.range)}`}
          aria-describedby={selection?.side === textSide && selection.token === token.id ? "word-meaning" : undefined}
          className={`inline cursor-pointer select-text rounded-sm hover:bg-(--accent)/18 ${speaking ? "bg-(--accent)/35" : ""} ${linked ? "underline decoration-(--accent-text) decoration-2 underline-offset-4" : ""} ${inspected ? "bg-(--accent)/18" : ""}`}
          data-testid={speaking ? "reader-word" : undefined}
          data-token={`${textSide}:${token.id}`}
          {...meaning.handlers({ pair: pair.id, side: textSide, token: token.id })}
          onClick={(event) => {
            if (meaning.consumeHold() || window.getSelection()?.toString()) return;
            if (inspectMode) { meaning.show({ pair: pair.id, side: textSide, token: token.id }, event.currentTarget); return; }
            const at = listenPosition(textLane, pair, textSide, token.id);
            if (!at) { setMessage(`No narration timing here in ${language(textLane.language)}.`); return; }
            listen(textSide, at.ms, true);
            if (!at.word) setMessage("Word timing is unavailable here; playing from the sentence start.");
          }}
        >{text}</button>,
      );
    }
    pieces.push(layout.after);
    const active = activePair?.id === pair.id && (textSide === side || pair.status === "matched");
    return <span key={pair.id} className={active ? "rounded-sm bg-(--accent)/10" : undefined}
      title={pair.status === "uncertain" ? "Pairing uncertain" : undefined}
      data-testid={activePair?.id === pair.id && textSide === side ? "text-cue-active" : undefined}>{pieces}</span>;
  };

  return (
    <div className="min-h-screen bg-(--bg-reading) px-4 py-3" data-testid="bilingual-reader">
      <div className="mx-auto max-w-5xl">
        <div ref={toolbar} data-testid="bilingual-toolbar" className="sticky top-0 z-10 -mx-4 mb-4 space-y-2 border-b border-(--border) bg-(--bg-page)/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" to={bookId ? `/books/${bookId}?chapter=${chapter.id}` : "/"}>Back</Button>

            <select aria-label="Chapter" value={chapter.i} onChange={(e) => onChapter(Number(e.target.value))} className="max-w-64 rounded border border-(--border) bg-(--bg-input) px-2 py-1 text-sm">
              {manifest.chapters.map((c) => <option key={c.id} value={c.i}>{c.i + 1}. {c.title}</option>)}
            </select>
            {controls}
            <Button size="sm" onClick={onExit}>Single language</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="icon" size="sm" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"} disabled={!lane.narration} onClick={togglePlay}>
              {playing ? <IconPause weight="fill" className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
            </Button>
            <span className="text-xs text-(--text-muted)">Speak</span>
            {SIDES.map((voice) => <Button key={voice} size="sm" variant={side === voice ? "primary" : "secondary"} aria-pressed={side === voice} disabled={!doc[voice].narration} title={doc[voice].narration ? undefined : "No narration in this language"} onClick={() => changeVoice(voice)}>{language(doc[voice].language)}</Button>)}
            <select aria-label="Playback speed" value={speed} className="rounded border border-(--border) bg-(--bg-input) px-2 py-1 text-sm" onChange={(e) => {
              const rate = Number(e.target.value); setSpeed(rate); saveSpeed(rate);
              if (audioRef.current) { audioRef.current.defaultPlaybackRate = rate; audioRef.current.playbackRate = rate; }
            }}>{SPEEDS.map((rate) => <option key={rate} value={rate}>{rate}x</option>)}</select>
            <span className="text-xs tabular-nums text-(--text-muted)">{formatDuration(ms)} / {formatDuration(lane.narration?.totalMs ?? 0)}</span>
            <Button size="sm" variant="ghost" onClick={() => {
              setFollowing(true);
              if (content.current) followCue({ ...BAND, top: (toolbar.current?.offsetHeight ?? BAND.top) + 12 }, { root: content.current, jump: true });
            }}>{following ? playing ? "Following the voice" : "Paused" : "Back to the voice"}</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-(--text-muted)">
            <span>{inspectMode ? "Tap a word for its meaning · Space to play/pause" : "Click to listen · Space to play/pause · Hover or hold for meaning"}</span>
            <Button variant={inspectMode ? "primary" : "ghost"} size="sm" aria-pressed={inspectMode} onClick={() => { setInspectMode(!inspectMode); meaning.dismiss(); }}>Meanings on tap</Button>
            <details>
              <summary className="cursor-pointer hover:text-(--text-primary)">Timing details</summary>
              <div className="max-w-prose space-y-2 py-2">{lane.narration?.qualityNotes.map((note) => <p key={note}>{note}</p>)}</div>
            </details>
          </div>
          {message && <p role="status" className="text-sm text-(--warning-text)">{message}</p>}
        </div>

        <audio key={side} ref={audioRef} src={source.resolve(lane.narration?.audio)} preload="metadata"
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onError={() => { setPlaying(false); setMessage("This narration could not be loaded. Both texts remain available."); }}
          onLoadedMetadata={() => {
            const audio = audioRef.current;
            if (!audio) return;
            audio.defaultPlaybackRate = speed; audio.playbackRate = speed;
            audio.currentTime = landing.current.ms / 1000;
            if (landing.current.play) void audio.play().catch(() => setMessage("Press Play to continue this narration."));
            landing.current.play = false;
          }}
          onTimeUpdate={() => { if (audioRef.current && !playing) setMs(audioRef.current.currentTime * 1000); }} />
        <h1 className="sr-only">{chapter.title}</h1>
        <div className="mb-6 flex justify-between gap-8 px-3 text-sm font-medium text-(--text-muted) md:grid md:grid-cols-2 md:gap-12">
          {SIDES.map((s) => <span key={s}>{language(doc[s].language)}{s === side ? " · Audio" : ""}</span>)}
        </div>
        <div ref={content} className="space-y-6 pb-16" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)}>
          {groups.map((pairs) => (
            <div key={pairs[0]?.id} className="grid gap-3 md:grid-cols-2 md:gap-12" data-testid="bilingual-paragraph">
              {SIDES.map((textSide) => (
                <div key={textSide} className="min-w-0 max-w-prose px-3">
                  <p dir="auto" lang={doc[textSide].language} className={`whitespace-normal font-reading leading-relaxed ${pairs.length === 1 && pairs[0]?.id === heading ? "text-2xl font-medium" : "text-lg"}`}>
                    {pairs.some((pair) => pair[textSide]) ? pairs.map((pair) => renderPair(pair, textSide)) : <span className="font-sans text-sm text-(--text-muted)">No counterpart for this passage.</span>}
                  </p>
                </div>
              ))}
            </div>
          ))}
        </div>
        {selection && selectedPair && <WordMeaning meaning={meaning}>
          <p dir="auto" lang={doc[selection.side].language} className="text-xs text-(--text-muted)">{linkedText(doc[selection.side], selected?.[selection.side].length ? selected[selection.side] : [selection.token])}</p>
          <p dir="auto" lang={doc[selection.side === "source" ? "target" : "source"].language} className="font-reading text-lg">
            {selected?.source.length && selected.target.length ? linkedText(doc[selection.side === "source" ? "target" : "source"], selected[selection.side === "source" ? "target" : "source"]) : selectedPair.status === "uncertain" ? "Pairing uncertain" : selectedPair.linksStatus === "unavailable" ? "Word meanings are not available" : "No equivalent recorded"}
          </p>
          {selectedPair.linksStatus === "partial" && <p className="text-xs text-(--text-muted)">Some word links are missing.</p>}
        </WordMeaning>}

      </div>
    </div>
  );
}
