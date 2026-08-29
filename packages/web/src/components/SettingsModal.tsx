import { useState } from "react";
import { trpc } from "../trpc.ts";
import type { RouterInputs } from "../../../server/src/router.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { useLlmModels } from "../lib/use-llm-models.ts";
import { formatTokens } from "../lib/ai-presets.ts";
import { TOOLBAR_BUTTON } from "../lib/button-classes.ts";

type SecretVar = RouterInputs["secrets"]["set"]["envVar"];

// Stable and unique per key, unlike a display label — "Google Gemini" would put a space in a testid
const slugOf = (envVar: SecretVar) => envVar.replace(/_API_KEY$/, "").toLowerCase().replaceAll("_", "-");

type KeyCardProps = {
  slug: string;
  label: string;
  note: string;
  configured: boolean;
  keyHint: string | null;
  draft: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
  busy: boolean;
  error: string | null;
};

function KeyCard({ slug, label, note, configured, keyHint, draft, onDraft, onSave, onRemove, busy, error }: KeyCardProps) {
  return (
    <div className="rounded-md border border-(--border) p-3" data-testid={`settings-key-${slug}`}>
      <div className="flex items-center gap-2 text-sm">
        <Dot on={configured} />
        <span className="font-medium text-(--text-primary)">{label}</span>
        <span className="text-xs text-(--text-faint)">{note}</span>
        <span className={`ml-auto text-xs ${configured ? "text-(--success-text)" : "text-(--text-muted)"}`}>
          {configured ? `key set (${keyHint})` : "no key"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
          placeholder={configured ? "Paste a new key to replace it" : "Paste API key"}
          className="flex-1 text-xs rounded-md border border-(--border-input) bg-(--bg-input) px-2 py-1.5 text-(--text-primary)"
          data-testid={`settings-key-input-${slug}`}
        />
        <button
          onClick={onSave}
          disabled={!draft.trim() || busy}
          className="text-xs px-2.5 py-1.5 rounded-md bg-(--accent) text-(--on-accent) font-medium disabled:opacity-50"
          data-testid={`settings-key-save-${slug}`}
        >
          Save
        </button>
        <button
          onClick={onRemove}
          disabled={!configured || busy}
          title={configured ? "Remove the saved key" : "No key to remove"}
          className={TOOLBAR_BUTTON}
          data-testid={`settings-key-remove-${slug}`}
        >
          Remove
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-(--danger-text)" data-testid={`settings-key-error-${slug}`}>{error}</p>}
    </div>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${on ? "bg-(--success)" : "bg-(--text-faint)"}`} />;
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  // The status query always probes fresh server-side — the 30s cache still covers non-settings traffic
  const { data: status, isFetching, refetch } = trpc.llmModels.status.useQuery();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const refreshModels = () => {
    utils.llmModels.status.invalidate();
    utils.llmModels.list.invalidate();
  };
  const { data: secrets, error: secretsError } = trpc.secrets.list.useQuery();
  const keysOfKind = (kind: "llm" | "voice") => (secrets?.keys ?? []).filter((k) => k.kind === kind);
  const setKeyMutation = trpc.secrets.set.useMutation({
    onSuccess: (_data, { envVar }) => {
      setDrafts((d) => ({ ...d, [envVar]: "" }));
      // Not llmModels.status: it re-probes every local Ollama and LM Studio model, which is a
      // dozen HTTP round trips to learn something secrets.list already answered from memory.
      utils.secrets.list.invalidate();
      utils.llmModels.list.invalidate();
      utils.cartesiaVoices.list.invalidate();
      utils.elevenlabsVoices.list.invalidate();
    },
  });
  // Every card drives one mutation, so both the spinner and the error belong to the card that
  // started it — otherwise saving a DeepSeek key greys out Cartesia and reports its failure there.
  const cardState = (envVar: SecretVar) => ({
    busy: setKeyMutation.isPending && setKeyMutation.variables?.envVar === envVar,
    error: setKeyMutation.variables?.envVar === envVar ? (setKeyMutation.error?.message ?? null) : null,
  });
  const startServerMutation = trpc.llmModels.startLocalServer.useMutation({ onSuccess: refreshModels });

  const models = useLlmModels();
  const { data: defaultModel } = trpc.llmModels.getDefault.useQuery();
  const setDefaultMutation = trpc.llmModels.setDefault.useMutation({
    onSuccess: () => utils.llmModels.getDefault.invalidate(),
  });
  const chosenDefault = defaultModel?.chosen ?? "";
  // A chosen model that is not among the available ones (its server stopped, its key removed)
  // still needs an option to sit on — otherwise the select silently displays "Automatic".
  const chosenMissing = chosenDefault !== "" && !models.some((m) => m.key === chosenDefault);

  const keyCard = (k: { envVar: SecretVar; label: string; note: string; configured: boolean; keyHint: string | null }) => (
    <KeyCard
      key={k.envVar}
      slug={slugOf(k.envVar)}
      label={k.label}
      note={k.note}
      configured={k.configured}
      keyHint={k.keyHint}
      draft={drafts[k.envVar] ?? ""}
      onDraft={(value) => setDrafts((d) => ({ ...d, [k.envVar]: value }))}
      onSave={() => save(k.envVar)}
      onRemove={() => setKeyMutation.mutate({ envVar: k.envVar, value: null })}
      {...cardState(k.envVar)}
    />
  );

  const save = (envVar: SecretVar) => {
    const value = drafts[envVar]?.trim();
    if (!value) return;
    setKeyMutation.mutate({ envVar, value });
  };

  return (
    <Modal size="md" onClose={onClose} backdropTestId="settings-modal">
      <ModalHeader title="Settings" onClose={onClose} />

      <div className="p-4 space-y-6 overflow-y-auto">
        <section data-testid="settings-default-model">
          <h3 className="text-sm font-semibold text-(--text-primary) mb-2">Default AI model</h3>
          <div className="rounded-md border border-(--border) p-3">
            <select
              value={chosenDefault}
              onChange={(e) => setDefaultMutation.mutate({ key: e.target.value || null })}
              disabled={setDefaultMutation.isPending || (models.length === 0 && !chosenMissing)}
              className="w-full text-sm rounded-md border border-(--border-input) bg-(--bg-input) text-(--text-primary) px-2 py-1.5"
              data-testid="settings-default-model-select"
            >
              <option value="">Automatic — V4 Flash when configured, else the first available model</option>
              {chosenMissing && <option value={chosenDefault}>{chosenDefault} (not available right now)</option>}
              {[...new Set(models.map((m) => m.source))].map((source) => (
                <optgroup key={source} label={source}>
                  {models
                    .filter((m) => m.source === source)
                    .map((m) => (
                      <option key={m.key} value={m.key} title={`${m.hint} · ${formatTokens(m.contextTokens)} context`}>
                        {m.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <p className="mt-2 text-xs text-(--text-muted)">
              Preselected wherever a model is picked — cleanup, Ask AI, translations, digests, chat, chapter detection.
            </p>
            {chosenMissing && (
              <p className="mt-1 text-xs text-(--warning-text)" data-testid="settings-default-model-warning">
                Not available right now — requests fall back to the automatic choice until it is.
              </p>
            )}
            {setDefaultMutation.error && (
              <p className="mt-1 text-xs text-(--danger-text)">{setDefaultMutation.error.message}</p>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-(--text-primary)">Local models — offline, auto-detected</h3>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className={TOOLBAR_BUTTON}
              data-testid="settings-rescan"
            >
              {isFetching ? "Scanning…" : "Rescan"}
            </button>
          </div>
          <div className="space-y-3">
            {(status?.local ?? []).map((server) => (
              <div key={server.name} className="rounded-md border border-(--border) p-3" data-testid={`settings-local-${server.name.replace(" ", "-").toLowerCase()}`}>
                <div className="flex items-center gap-2 text-sm">
                  <Dot on={server.running} />
                  <span className="font-medium text-(--text-primary)">{server.name}</span>
                  <span className="text-(--text-faint) text-xs">{server.url}</span>
                  <span className={`ml-auto text-xs ${server.running ? "text-(--success-text)" : "text-(--text-muted)"}`}>
                    {server.running ? `running — ${server.models.length} model${server.models.length === 1 ? "" : "s"}` : "not detected"}
                  </span>
                </div>
                {server.running && server.note && (
                  <p className="mt-1.5 text-xs text-(--text-muted) pl-4">{server.note}</p>
                )}
                {server.running ? (
                  server.models.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {server.models.map((m) => (
                        <li key={m.key} className="flex items-center gap-2 text-xs text-(--text-secondary) pl-4">
                          <span className="font-mono">{m.label}</span>
                          <span className="text-(--text-faint)">{formatTokens(m.contextTokens)} context</span>
                          {m.supportsTools ? (
                            <span className="text-(--text-faint)">· chat tools</span>
                          ) : (
                            <span className="text-(--text-faint)">· no chat tools</span>
                          )}
                          {m.contextNote && <span className="text-(--warning-text)">· {m.contextNote}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-(--text-muted) pl-4">No chat models installed yet.</p>
                  )
                ) : (
                  <div className="mt-2 flex items-center gap-2 pl-4">
                    <button
                      onClick={() => startServerMutation.mutate({ name: server.name })}
                      disabled={startServerMutation.isPending}
                      className="text-xs px-2.5 py-1 rounded-md bg-(--accent) text-(--on-accent) font-medium disabled:opacity-50"
                      data-testid={`settings-start-${server.name.replace(" ", "-").toLowerCase()}`}
                    >
                      {startServerMutation.isPending ? "Starting…" : "Start server"}
                    </button>
                    <p className="text-xs text-(--text-muted)">{server.startHint}</p>
                  </div>
                )}
              </div>
            ))}
            {(status?.custom ?? []).map((entry) => (
              <div key={entry.key} className="rounded-md border border-(--border) p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Dot on={true} />
                  <span className="font-medium text-(--text-primary)">{entry.label}</span>
                  <span className="text-(--text-faint) text-xs">{entry.url}</span>
                  <span className="ml-auto text-xs text-(--text-muted)">custom (.env)</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-(--text-primary) mb-2">Cloud providers — need an API key</h3>
          <div className="space-y-3">{keysOfKind("llm").map(keyCard)}</div>
          {startServerMutation.error && <p className="mt-2 text-xs text-(--danger-text)">{startServerMutation.error.message}</p>}
        </section>

        <section>
          <h3 className="text-sm font-semibold text-(--text-primary) mb-2">Cloud voices — need an API key</h3>
          {secretsError ? (
            <p className="text-xs text-(--danger-text)">Could not read the saved keys: {secretsError.message}</p>
          ) : (
            <div className="space-y-3">{keysOfKind("voice").map(keyCard)}</div>
          )}
        </section>

        <p className="text-xs text-(--text-faint)">
          Keys take effect immediately and are never sent back to the browser.
          {secrets?.path && <> They are written to <code className="text-(--text-muted)">{secrets.path}</code></>}
        </p>
      </div>
    </Modal>
  );
}
