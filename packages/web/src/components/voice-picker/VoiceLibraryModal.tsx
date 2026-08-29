import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cartesiaVoiceToEntry,
  elevenlabsVoiceToEntry,
  languageLabel,
  MULTILINGUAL,
  voiceCoversLanguage,
  pocketCustomVoiceToEntry,
  pocketVoiceToEntry,
  providerOfVoice,
  PROVIDER_ORDER,
  sayVoiceToEntry,
  staticVoices,
  type Voice,
} from "../../lib/voices.ts";
import { trpc } from "../../trpc.ts";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock.ts";
import { PocketLanguageNotice } from "./PocketLanguageNotice.tsx";
import { ModelBundleNotice } from "../ModelBundleNotice.tsx";
import { PocketVoiceCloner } from "./PocketVoiceCloner.tsx";
import { VoiceRow } from "./VoiceRow.tsx";
import { Empty, Section } from "./layout.tsx";
import { useVoicePicker } from "./context.tsx";

const CLONED = "cloned";

const ALL = "all";
// Showing 500 Cartesia voices at once answers nothing; a taste of each provider does.
const PREVIEW_PER_PROVIDER = 6;
const RAIL_LANGUAGE_LIMIT = 8;
const NONE_EXPANDED: ReadonlySet<string> = new Set();

// Every other engine here is free; this one is metered, and running out mid-chapter is the
// normal case on a free month. What is left belongs where the voices are chosen.
function sectionLabel(provider: string, count: number, quota: { remaining: number; limit: number } | null | undefined): string {
  const base = `${provider} \u00b7 ${count}`;
  if (provider !== "ElevenLabs" || !quota?.limit) return base;
  return `${base} \u00b7 ${quota.remaining.toLocaleString()} of ${quota.limit.toLocaleString()} characters left`;
}

// What this book is being translated into comes first — that's what you're here to synthesize —
// then English, then the rest by how many voices they have.
function orderLanguages(counts: Map<string, number>, priority: string[]): string[] {
  const rank = (c: string) => (priority.includes(c) ? 0 : c === "en" ? 1 : 2);
  return [...counts.keys()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? priority.indexOf(a) - priority.indexOf(b) : 0) ||
      counts.get(b)! - counts.get(a)! ||
      languageLabel(a).localeCompare(languageLabel(b)),
  );
}

// `footer`/`title` let a caller host the picker for its own action (synthesis) instead of stacking
// a second modal on top of it — the whole reason SynthesizeModal is a thin wrapper, not a dialog.
export function VoiceLibraryModal({
  onClose,
  title = "Choose a voice",
  footer,
  priorityLanguages = [],
}: {
  onClose: () => void;
  title?: string;
  footer?: React.ReactNode;
  /** Codes to pin at the top — what this book is actually being synthesized into. */
  priorityLanguages?: string[];
}) {
  const { state } = useVoicePicker();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useBodyScrollLock();

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Opened from inside other modals that keep document-level key handlers (ChapterModal closes on
  // Escape and navigates chapters on arrows). Capture-phase + stopImmediatePropagation keeps Escape
  // from closing both; the container's own handler below stops arrows leaking out of the search box.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const { data: sayVoices = [] } = trpc.sayVoices.list.useQuery(undefined, { staleTime: Infinity });
  const { data: cartesiaVoices = [] } = trpc.cartesiaVoices.list.useQuery(undefined, { staleTime: Infinity });
  const { data: elevenlabsVoices = [] } = trpc.elevenlabsVoices.list.useQuery(undefined, { staleTime: Infinity });
  const { data: elevenlabsQuota } = trpc.elevenlabsVoices.quota.useQuery(undefined, { staleTime: 60_000, enabled: elevenlabsVoices.length > 0 });
  const { data: pocket, refetch: refetchPocket } = trpc.pocketVoices.list.useQuery(undefined, { staleTime: Infinity });
  const { data: pocketLanguages = [] } = trpc.pocketVoices.languages.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.some((l) => l.downloading) ? 1500 : false),
  });
  const deleteCustomVoice = trpc.pocketVoices.deleteCustom.useMutation({ onSuccess: () => void refetchPocket() });

  const clonedVoices = useMemo(() => (pocket?.custom ?? []).map(pocketCustomVoiceToEntry), [pocket]);

  // Pocket ships one checkpoint per language, so its catalogue repeats under each installed one.
  const pocketVoices = useMemo(
    () =>
      pocketLanguages
        .filter((language) => language.installed)
        .flatMap((language) => (pocket?.voices ?? []).map((voice) => pocketVoiceToEntry(voice, language.code))),
    [pocket, pocketLanguages],
  );

  const allVoices = useMemo<Voice[]>(
    () => [...staticVoices, ...sayVoices.map(sayVoiceToEntry), ...cartesiaVoices.map(cartesiaVoiceToEntry), ...elevenlabsVoices.map(elevenlabsVoiceToEntry), ...pocketVoices],
    [sayVoices, cartesiaVoices, elevenlabsVoices, pocketVoices],
  );

  const languageCounts = useMemo(() => {
    // A multilingual voice has no row of its own — it belongs to each language it can read.
    const codes = new Set(allVoices.map((v) => v.language ?? "en"));
    codes.delete(MULTILINGUAL);
    // Pocket languages that aren't downloaded still get a row, so they can be requested from here.
    for (const language of pocketLanguages) codes.add(language.code);
    for (const code of priorityLanguages) codes.add(code);

    const counts = new Map<string, number>();
    for (const code of codes) {
      counts.set(code, allVoices.reduce((n, v) => n + (voiceCoversLanguage(v, code) ? 1 : 0), 0));
    }
    return counts;
  }, [allVoices, pocketLanguages, priorityLanguages]);

  const languages = useMemo(() => orderLanguages(languageCounts, priorityLanguages), [languageCounts, priorityLanguages]);

  const [chosen, setChosen] = useState<string>(() => {
    const fromSelection = allVoicesLanguageOf(state.selectedId);
    // A multilingual voice says nothing about intent, so the book's own language wins.
    if (fromSelection && fromSelection !== MULTILINGUAL) return fromSelection;
    return priorityLanguages[0] ?? fromSelection ?? "en";
  });
  const [showAllLanguages, setShowAllLanguages] = useState(false);
  const language = chosen === CLONED || languages.includes(chosen) ? chosen : (languages[0] ?? "en");

  const matches = useCallback(
    (...fields: (string | undefined)[]) => {
      const needle = query.trim().toLowerCase();
      return !needle || fields.filter(Boolean).join(" ").toLowerCase().includes(needle);
    },
    [query],
  );

  // Most of the tail comes from Cartesia's 43-language catalogue and installed macOS voices; keep
  // the rail to what's plausibly in play, with the rest one click away.
  const railLanguages = useMemo(() => {
    if (showAllLanguages) return languages;
    const head = languages.slice(0, RAIL_LANGUAGE_LIMIT);
    return head.includes(language) || language === CLONED ? head : [...head, language];
  }, [languages, showAllLanguages, language]);

  const pocketLanguage = pocketLanguages.find((l) => l.code === language) ?? null;

  const visible = useMemo(() => {
    const pool =
      language === CLONED
        ? clonedVoices
        // A multilingual model reads any language, so it belongs in every list.
        : allVoices.filter((v) => voiceCoversLanguage(v, language));
    return pool.filter((v) => matches(v.label, v.note, providerOfVoice(v)));
  }, [allVoices, clonedVoices, language, matches]);

  const byProvider = useMemo(() => {
    const groups = new Map<string, Voice[]>();
    for (const voice of visible) {
      const provider = providerOfVoice(voice);
      groups.set(provider, [...(groups.get(provider) ?? []), voice]);
    }
    const ordered = [...groups.keys()].sort(
      (a, b) => (PROVIDER_ORDER.indexOf(a) + 1 || 99) - (PROVIDER_ORDER.indexOf(b) + 1 || 99),
    );
    return ordered.map((provider) => ({ provider, voices: groups.get(provider)! }));
  }, [visible]);

  // Open on the provider of the current voice so the selection is visible without hunting.
  const selectedProvider = useMemo(() => {
    const current = visible.find((v) => v.id === state.selectedId);
    return current ? providerOfVoice(current) : ALL;
  }, [visible, state.selectedId]);
  // The rail and the per-provider "show all" belong to one language's list, so they are held
  // against the language that produced them and forgotten when it changes.
  const [picked, setPicked] = useState<{ language: string; provider: string | null; expanded: ReadonlySet<string> }>({
    language,
    provider: null,
    expanded: NONE_EXPANDED,
  });
  const provider = picked.language === language ? picked.provider : null;
  const expanded = picked.language === language ? picked.expanded : NONE_EXPANDED;
  const setProvider = (name: string | null) => setPicked({ language, provider: name, expanded });
  const expand = (name: string) => setPicked({ language, provider, expanded: new Set(expanded).add(name) });
  const activeProvider = query ? ALL : (provider ?? selectedProvider);

  const shown = activeProvider === ALL ? byProvider : byProvider.filter((g) => g.provider === activeProvider);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="voice-library-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-library-title"
        className="bg-(--bg-card) rounded-lg shadow-xl w-[92vw] max-w-3xl h-[80vh] max-h-[46rem] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="voice-library-modal"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--border) shrink-0">
          <h2 id="voice-library-title" className="text-sm font-medium text-(--text-primary)">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-(--text-faint) hover:text-(--text-tertiary) p-1 rounded"
            title="Close"
            aria-label="Close voice picker"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <nav className="w-48 shrink-0 border-r border-(--border) p-2 overflow-y-auto" aria-label="Languages">
            {clonedVoices.length > 0 && (
              <button
                type="button"
                onClick={() => setChosen(CLONED)}
                aria-current={language === CLONED ? "page" : undefined}
                className={`w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-md mb-2 text-sm ${ language === CLONED ? "bg-(--bg-selected) text-(--text-primary)" : "text-(--text-secondary) hover:bg-(--bg-subtle)" }`}
                data-testid="voice-language-cloned"
              >
                <span className="truncate">Your voices</span>
                <span className="text-xs text-(--text-faint) tabular-nums">{clonedVoices.length}</span>
              </button>
            )}

            {railLanguages.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setChosen(code)}
                aria-current={code === language ? "page" : undefined}
                className={`w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-md mb-1 text-sm ${ code === language ? "bg-(--bg-selected) text-(--text-primary)" : "text-(--text-secondary) hover:bg-(--bg-subtle)" }`}
                data-testid={`voice-language-${code}`}
              >
                <span className="truncate">{languageLabel(code)}</span>
                <span className="text-xs text-(--text-faint) tabular-nums">{languageCounts.get(code) || "\u2193"}</span>
              </button>
            ))}

            {!showAllLanguages && languages.length > railLanguages.length && (
              <button
                type="button"
                onClick={() => setShowAllLanguages(true)}
                className="w-full text-left px-3 py-2 rounded-md text-xs text-(--accent-text) hover:bg-(--bg-subtle)"
                data-testid="voice-show-all-languages"
              >
                Show all {languages.length} languages
              </button>
            )}
          </nav>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="p-2 border-b border-(--border) shrink-0">
              <input
                ref={searchRef}
                type="search"
                name="voice-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={language === CLONED ? "Search your voices…" : `Search ${languageLabel(language)} voices…`}
                aria-label="Search voices"
                className="w-full rounded-md border border-(--border-input) bg-(--bg-input) px-3 py-1.5 text-sm"
                data-testid="voice-search"
              />
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-2" data-testid="voice-list">
              {language === CLONED ? (
                <>
                  {visible.map((voice) => (
                    <VoiceRow
                      key={voice.id}
                      voice={voice}
                      action={
                        <button
                          type="button"
                          onClick={() => deleteCustomVoice.mutate({ id: voice.id.slice("pocket:custom:".length) })}
                          disabled={deleteCustomVoice.isPending}
                          title={`Delete ${voice.label}`}
                          aria-label={`Delete ${voice.label}`}
                          className="shrink-0 px-2 py-1 text-xs text-(--text-faint) hover:text-(--danger-text) disabled:opacity-50 rounded"
                          data-testid={`pocket-delete-${voice.id}`}
                        >
                          Delete
                        </button>
                      }
                    />
                  ))}
                  {pocket?.cloningAvailable ? (
                    <PocketVoiceCloner onAdded={() => void refetchPocket()} />
                  ) : (
                    <p className="px-3 py-2 text-xs text-(--text-muted)">
                      Voice cloning unavailable — accept the terms at huggingface.co/kyutai/pocket-tts, set HF_TOKEN
                      in .env, then re-run <code>pnpm run setup</code>.
                    </p>
                  )}
                </>
              ) : (
                <>
                  {pocketLanguage && !pocketLanguage.installed && <PocketLanguageNotice language={pocketLanguage} />}

                  {byProvider.length > 1 && (
                    <div className="flex flex-wrap gap-1 px-1 pb-2" role="group" aria-label="Providers">
                      <ProviderChip
                        label="All"
                        count={visible.length}
                        active={activeProvider === ALL}
                        onClick={() => setProvider(ALL)}
                      />
                      {byProvider.map(({ provider: name, voices }) => (
                        <ProviderChip
                          key={name}
                          label={name}
                          count={voices.length}
                          active={activeProvider === name}
                          onClick={() => setProvider(name)}
                        />
                      ))}
                    </div>
                  )}

                  {language === "bg" && (
                    <div className="mx-1 mb-3 space-y-2">
                      <ModelBundleNotice id="bulgarian" verb="Narrating in Bulgarian" />
                      <ModelBundleNotice id="bulgarian-narrator" verb="Narrating with the BG-TTS V5 voice" />
                    </div>
                  )}

                  {shown.length > 0
                    ? shown.map(({ provider: name, voices }) => {
                        // In the combined view each provider shows a taste; one provider shows all.
                        const capped = activeProvider === ALL && !expanded.has(name) && voices.length > PREVIEW_PER_PROVIDER;
                        const rows = capped ? voices.slice(0, PREVIEW_PER_PROVIDER) : voices;
                        return (
                          <Section key={name} label={sectionLabel(name, voices.length, elevenlabsQuota)}>
                            {rows.map((voice) => <VoiceRow key={voice.id} voice={voice} />)}
                            {capped && (
                              <button
                                type="button"
                                onClick={() => expand(name)}
                                className="w-full text-left px-3 py-1.5 text-xs text-(--accent-text) hover:underline rounded"
                                data-testid={`voice-show-all-${name}`}
                              >
                                Show all {voices.length} {name} voices
                              </button>
                            )}
                          </Section>
                        );
                      })
                    : !pocketLanguage && (
                        <Empty>
                          {query ? (
                            `No ${languageLabel(language)} voices match “${query}”.`
                          ) : (
                            <>
                              No {languageLabel(language)} voices installed.
                              {cartesiaVoices.length === 0 && " Cartesia's cloud catalogue covers most languages."}
                              {elevenlabsVoices.length === 0 && " ElevenLabs' free tier gives an API key and 10,000 characters a month."}
                              {(cartesiaVoices.length === 0 || elevenlabsVoices.length === 0) && " Add a key under Settings → Cloud voices."}
                            </>
                          )}
                        </Empty>
                      )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-(--border) shrink-0">
          {footer ?? (
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md text-sm font-medium border border-(--border-input) text-(--text-secondary) hover:bg-(--bg-subtle)"
                data-testid="voice-library-done"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Opens on the language of the current selection so the picker lands where the user already is.
function allVoicesLanguageOf(voiceId: string): string | null {
  if (voiceId.startsWith("pocket:custom:")) return CLONED;
  const known = staticVoices.find((v) => v.id === voiceId);
  if (known?.language) return known.language;
  if (voiceId.startsWith("pocket:")) {
    const rest = voiceId.slice("pocket:".length);
    const separator = rest.indexOf(":");
    return separator === -1 ? "en" : rest.slice(0, separator);
  }
  return null;
}

function ProviderChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2 py-1 text-xs rounded-full border ${ active ? "border-(--accent) text-(--accent-text) bg-(--bg-selected)" : "border-(--border) text-(--text-muted) hover:bg-(--bg-subtle)" }`}
      data-testid={`voice-provider-${label}`}
    >
      {label} <span className="tabular-nums text-(--text-faint)">{count}</span>
    </button>
  );
}
