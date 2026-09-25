import { useState } from "react";
import { trpc } from "../../trpc.ts";
import { PROVIDER_SETUP, type ProviderSetup } from "../../lib/assistant-providers.ts";
import { formatTokens } from "../../lib/ai-presets.ts";
import { Button } from "../Button.tsx";
import { IconCheck, IconChosen, IconChoose, IconExternal } from "../icons.tsx";

type Tile = ProviderSetup["envVar"] | "local";

function ProviderTile({ label, note, selected, configured, onSelect, testId }: { label: string; note: string; selected: boolean; configured: boolean; onSelect: () => void; testId: string }) {
  return (
    // button-ok: a selectable tile in a radio-like group, not an action
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm ${
        selected ? "border-(--accent) bg-(--accent-subtle)" : "border-(--border) bg-(--bg-card) hover:bg-(--bg-card-hover)"
      }`}
      data-testid={testId}
    >
      <span className="mt-0.5 shrink-0 text-(--accent-text)">
        {selected ? <IconChosen className="h-4 w-4" weight="fill" /> : <IconChoose className="h-4 w-4 text-(--text-faint)" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-medium text-(--text-primary)">
          <span className="truncate">{label}</span>
          {configured && <IconCheck className="h-3 w-3 shrink-0 text-(--success-text)" />}
        </span>
        <span className="block text-xs text-(--text-muted)">{note}</span>
      </span>
    </button>
  );
}

function KeySteps({ provider, onConnected }: { provider: ProviderSetup; onConnected: () => void }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState("");
  const connect = trpc.secrets.connect.useMutation({
    onSuccess: () => {
      setDraft("");
      utils.secrets.list.invalidate();
      utils.llmModels.list.invalidate();
      utils.llmModels.getDefault.invalidate();
      onConnected();
    },
  });
  const trimmed = draft.trim();
  const wrongShape = trimmed !== "" && !trimmed.startsWith(provider.keyPrefix);
  const failed = connect.error !== null;

  return (
    <div className="space-y-3" data-testid="assistant-key-steps">
      <ol className="space-y-2 text-sm text-(--text-primary)">
        <li className="flex gap-2">
          <Step n={1} />
          <span>
            Open{" "}
            <a href={provider.keysUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-(--accent-text) hover:underline">
              {new URL(provider.keysUrl).host}
              <IconExternal className="h-3 w-3" />
            </a>{" "}
            and sign in.
          </span>
        </li>
        <li className="flex gap-2">
          <Step n={2} />
          <span>
            Choose “{provider.createLabel}” and copy it. It starts with <code className="rounded bg-(--bg-subtle) px-1 font-mono text-xs">{provider.keyPrefix}</code>.
          </span>
        </li>
        <li className="flex gap-2">
          <Step n={3} />
          <span>Paste it here.</span>
        </li>
      </ol>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); connect.reset(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && trimmed && !wrongShape) connect.mutate({ envVar: provider.envVar, value: trimmed }); }}
          placeholder={`Paste your ${provider.label} key`}
          aria-invalid={failed || wrongShape}
          className={`min-w-0 flex-1 rounded-md border bg-(--bg-input) px-2 py-1.5 text-xs text-(--text-primary) ${failed || wrongShape ? "border-(--danger)" : "border-(--border-input)"}`}
          data-testid="assistant-key-input"
        />
        <Button variant="primary" size="sm" onClick={() => connect.mutate({ envVar: provider.envVar, value: trimmed })} disabled={!trimmed || wrongShape || connect.isPending} data-testid="assistant-key-connect">
          {connect.isPending ? "Checking…" : failed ? "Try again" : "Connect"}
        </Button>
      </div>
      {wrongShape && <p className="text-xs text-(--danger-text)">A {provider.label} key starts with {provider.keyPrefix} — this looks like something else.</p>}
      {failed && <p className="text-xs text-(--danger-text)" data-testid="assistant-key-error">{connect.error.message}. Nothing was saved.</p>}
      <p className="text-xs text-(--text-muted)">{provider.cost}</p>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-(--accent) text-[10px] font-semibold text-(--on-accent)">{n}</span>;
}

// Ollama and LM Studio as Settings sees them; picking a model makes it the default, which is what
// the panel runs on. Probed only once this tile is chosen — the probe is a dozen round trips.
function LocalModels({ onConnected }: { onConnected: () => void }) {
  const utils = trpc.useUtils();
  const { data: status, isPending, refetch, isFetching } = trpc.llmModels.status.useQuery();
  const { data: chosen } = trpc.llmModels.getDefault.useQuery();
  const pick = trpc.llmModels.setDefault.useMutation({
    onSuccess: () => {
      utils.llmModels.getDefault.invalidate();
      utils.llmModels.list.invalidate();
      onConnected();
    },
  });
  const start = trpc.llmModels.startLocalServer.useMutation({ onSuccess: () => refetch() });
  const servers = status?.local ?? [];
  const running = servers.filter((s) => s.running);

  return (
    <div className="space-y-3 text-sm" data-testid="assistant-local-models">
      {isPending && <p className="text-xs text-(--text-muted)">Looking for Ollama and LM Studio…</p>}
      {!isPending && running.length === 0 && (
        <div className="space-y-2">
          <p className="text-(--text-primary)">No local server is running. Ollama or LM Studio can run a model on this Mac: free and private, slower than a cloud model.</p>
          {servers.map((server) => (
            <div key={server.name} className="flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => start.mutate({ name: server.name })} disabled={start.isPending}>
                {start.isPending ? "Starting…" : `Start ${server.name}`}
              </Button>
              <span className="text-xs text-(--text-muted)">{server.startHint}</span>
            </div>
          ))}
          {start.error && <p className="text-xs text-(--danger-text)">{start.error.message}</p>}
        </div>
      )}
      {running.map((server) => (
        <div key={server.name} className="space-y-1">
          <p className="text-xs font-medium text-(--text-secondary)">{server.name}</p>
          {server.models.length === 0 && <p className="text-xs text-(--text-muted)">Running, but no chat model is installed yet.</p>}
          {server.models.map((m) => (
            <label key={m.key} className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs ${m.supportsTools ? "text-(--text-primary) hover:bg-(--bg-card-hover)" : "text-(--text-faint)"}`}>
              <input type="radio" name="assistant-local-model" checked={chosen?.chosen === m.key} disabled={!m.supportsTools || pick.isPending} onChange={() => pick.mutate({ key: m.key })} />
              <span className="font-mono">{m.label}</span>
              <span className="text-(--text-faint)">{formatTokens(m.contextTokens)}</span>
              {!m.supportsTools && <span className="text-(--text-faint)">· cannot call tools</span>}
            </label>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => refetch()} disabled={isFetching}>{isFetching ? "Scanning…" : "Rescan"}</Button>
        <span className="text-xs text-(--text-muted)">Free, private, slower.</span>
      </div>
    </div>
  );
}

// The panel before a model is connected: the five ways to get one, and the steps for the chosen one.
// Reads and writes the same key store as Settings.
export function AssistantSetup({ onConnected }: { onConnected: () => void }) {
  const [tile, setTile] = useState<Tile>(PROVIDER_SETUP[0]?.envVar ?? "local");
  const { data: secrets } = trpc.secrets.list.useQuery();
  const configured = (envVar: string) => secrets?.keys.some((k) => k.envVar === envVar && k.configured) ?? false;
  const chosenProvider = PROVIDER_SETUP.find((p) => p.envVar === tile);

  return (
    <div className="space-y-4 p-4" data-testid="assistant-setup">
      <div>
        <h3 className="font-(family-name:--stack-display) text-base font-semibold text-(--text-primary)">Connect a model to turn on the assistant</h3>
        <p className="mt-1 text-sm text-(--text-muted)">
          It explains how Libratory turns a PDF into an audiobook, tells you what to do next and does it for you. It needs an AI model: a cloud key, or a model on this Mac.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {PROVIDER_SETUP.map((p) => (
          <ProviderTile
            key={p.envVar}
            label={p.label}
            note={p.recommended ? "Recommended · cheapest" : "Pay as you go"}
            selected={tile === p.envVar}
            configured={configured(p.envVar)}
            onSelect={() => setTile(p.envVar)}
            testId={`assistant-tile-${p.envVar.replace(/_API_KEY$/, "").toLowerCase().replaceAll("_", "-")}`}
          />
        ))}
        <ProviderTile label="On this Mac" note="Free · Ollama or LM Studio" selected={tile === "local"} configured={false} onSelect={() => setTile("local")} testId="assistant-tile-local" />
      </div>
      <div className="rounded-md border border-(--border) bg-(--bg-card) p-3">
        {chosenProvider ? <KeySteps key={chosenProvider.envVar} provider={chosenProvider} onConnected={onConnected} /> : <LocalModels onConnected={onConnected} />}
      </div>
      <p className="text-xs text-(--text-faint)">Keys are kept on this Mac, in the same place as Settings, and never sent anywhere but the provider.</p>
    </div>
  );
}
