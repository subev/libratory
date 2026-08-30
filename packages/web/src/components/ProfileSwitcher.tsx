import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../trpc.ts";
import { getStoredProfileId, setStoredProfileId } from "../lib/profile.ts";
import { formatBytes } from "../lib/format.ts";
import { useDismissOnOutsidePointer, useTopmostEscape } from "./Modal.tsx";
import { IconAdd, IconCheck, IconChevronDown, IconClose, IconDelete, IconProfile, IconRename, IconWarning } from "./icons.tsx";
import { Button } from "./Button.tsx";

type Profile = { id: string; name: string; isDefault: boolean; books: number; folders: number };

type Mode = { kind: "rename" | "delete" | "blocked"; id: string } | { kind: "new" } | null;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function blockedReason(p: Profile) {
  if (p.isDefault) return "The default profile stays — it is where books land when no profile is chosen.";
  const parts = [];
  if (p.books) parts.push(plural(p.books, "book"));
  if (p.folders) parts.push(plural(p.folders, "folder"));
  return `${parts.join(" and ")} still live here. Move or delete them first.`;
}

const focusInput = (el: HTMLInputElement | null) => {
  el?.focus();
  el?.select();
};

function NameEditor({
  value,
  onChange,
  onSave,
  onCancel,
  label,
  saveLabel,
  placeholder,
  pending,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
  saveLabel: string;
  placeholder?: string;
  pending: boolean;
  testId: string;
}) {
  return (
    <>
      <input
        ref={focusInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !pending) onSave();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        aria-label={label}
        className="w-full min-w-0 px-2 py-1 text-xs rounded border border-(--border-input) bg-(--bg-input) text-(--text-primary) outline-none focus:border-(--accent)"
        data-testid={`${testId}-input`}
      />
      <button
        type="button"
        onClick={onSave}
        disabled={pending}
        title="Save"
        aria-label={saveLabel}
        className="shrink-0 w-6 h-6 flex items-center justify-center text-(--accent-text) hover:text-(--accent-text-hover) disabled:opacity-40"
        data-testid={`${testId}-save`}
      >
        <IconCheck className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        title="Cancel"
        aria-label="Cancel"
        className="shrink-0 w-6 h-6 flex items-center justify-center text-(--text-faint) hover:text-(--text-secondary)"
      >
        <IconClose className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

export function ProfileSwitcher() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const { data: profiles, isFetching } = trpc.profiles.list.useQuery();
  const createMutation = trpc.profiles.create.useMutation();
  const renameMutation = trpc.profiles.rename.useMutation();
  const deleteMutation = trpc.profiles.delete.useMutation();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const { data: usage } = trpc.profiles.usage.useQuery(undefined, { enabled: open, staleTime: 60_000 });

  const stored = getStoredProfileId();
  // Deleted-elsewhere guard; skip while fetching so a just-created id isn't wiped mid-refetch
  const staleStored = !!profiles && !isFetching && !!stored && !profiles.some((p) => p.id === stored);
  useEffect(() => {
    if (staleStored) {
      setStoredProfileId(null);
      queryClient.invalidateQueries();
    }
  }, [staleStored, queryClient]);

  const reset = useCallback(() => {
    setMode(null);
    setDraft("");
    setError(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  // Escape backs out of the row being edited first, and only then closes the popover.
  useTopmostEscape(() => (mode ? reset() : close()), open);

  useDismissOnOutsidePointer(root, close, open);

  const active = profiles?.find((p) => p.id === stored) ?? profiles?.[0];
  if (!profiles || !active) return null;

  function activate(id: string) {
    setStoredProfileId(id);
    close();
    navigate("/");
    queryClient.invalidateQueries();
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const createProfile = () => {
    const name = draft.trim();
    if (!name) return reset();
    return run(async () => {
      const profile = await createMutation.mutateAsync({ name });
      utils.profiles.list.setData(undefined, (old) =>
        old ? [...old, { id: profile.id, name: profile.name, isDefault: false, books: 0, folders: 0 }] : old,
      );
      activate(profile.id);
    });
  };

  const renameProfile = (p: Profile) => {
    const name = draft.trim();
    if (!name || name === p.name) return reset();
    return run(async () => {
      await renameMutation.mutateAsync({ id: p.id, name });
      utils.profiles.list.invalidate();
      reset();
    });
  };

  const deleteProfile = (p: Profile) =>
    run(async () => {
      await deleteMutation.mutateAsync({ id: p.id });
      reset();
      if (p.id === stored) {
        setStoredProfileId(null);
        navigate("/");
      }
      queryClient.invalidateQueries();
    });

  function metaFor(p: Profile) {
    const parts = [];
    if (p.books) parts.push(plural(p.books, "book"));
    if (p.folders) parts.push(plural(p.folders, "folder"));
    const bytes = usage?.[p.id];
    if (bytes) parts.push(formatBytes(bytes));
    if (parts.length > 0) return parts.join(" · ");
    return p.isDefault ? "Default profile" : "Empty";
  }

  return (
    <div ref={root} className="relative ml-3">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          if (open) return close();
          setOpen(true);
          // Book and folder mutations invalidate their own lists, never this one, so the counts
          // that decide "delete" vs "still has books" would go stale where the popover can't see it.
          utils.profiles.list.invalidate();
        }}
        aria-expanded={open}
        aria-controls="profile-menu"
        title="Switch profile"
        data-testid="profile-chip"
      >
        <IconProfile className="h-3.5 w-3.5 text-(--text-faint)" />
        <span className="text-(--text-primary)">{active.name}</span>
        <IconChevronDown className="h-3 w-3 text-(--text-faint)" />
      </Button>

      {open && (
        <div
          id="profile-menu"
          className="absolute left-0 top-full mt-1.5 z-50 w-76 rounded-xl border border-(--border) bg-(--bg-card) shadow-2xl overflow-hidden"
          data-testid="profile-menu"
        >
          <div className="px-3 pt-2.5 pb-2 border-b border-(--border)">
            <p className="text-[10px] font-bold tracking-widest uppercase text-(--text-faint)">Profile</p>
            <p className="text-[11px] leading-snug text-(--text-muted)">
              Separate libraries on this machine. No accounts, no passwords.
            </p>
          </div>

          {error && (
            <p className="px-3 py-2 text-xs text-(--danger-text) bg-(--danger-bg)">{error}</p>
          )}

          <div className="p-1.5 flex flex-col gap-px">
            {profiles.map((p) => {
              if (mode?.kind === "rename" && mode.id === p.id) {
                return (
                  <div key={p.id} className="flex items-center gap-1.5 p-1 rounded-lg bg-(--bg-subtle)">
                    <NameEditor
                      value={draft}
                      onChange={setDraft}
                      onSave={() => renameProfile(p)}
                      onCancel={reset}
                      label={`Rename ${p.name}`}
                      saveLabel="Save name"
                      pending={renameMutation.isPending}
                      testId="rename"
                    />
                  </div>
                );
              }

              if (mode?.kind === "delete" && mode.id === p.id) {
                return (
                  <div key={p.id} className="flex flex-col gap-2 p-2.5 rounded-lg bg-(--danger-bg)" data-testid="delete-confirm">
                    <p className="text-xs leading-snug text-(--text-primary)">
                      Delete “{p.name}”? The profile is empty, so nothing else goes with it.
                    </p>
                    <div className="flex gap-1.5">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => deleteProfile(p)}
                        disabled={deleteMutation.isPending}
                        data-testid="confirm-delete"
                      >
                        Delete
                      </Button>
                      <Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>
                    </div>
                  </div>
                );
              }

              if (mode?.kind === "blocked" && mode.id === p.id) {
                return (
                  <div key={p.id} className="flex gap-2 p-2.5 rounded-lg bg-(--warning-bg)" data-testid="delete-blocked">
                    <IconWarning className="h-3.5 w-3.5 mt-0.5 shrink-0 text-(--warning-text)" />
                    <div className="flex flex-col items-start gap-1.5">
                      <p className="text-xs leading-snug text-(--text-secondary)">{blockedReason(p)}</p>
                      {p.isDefault ? (
                        <Button variant="ghost" size="sm" onClick={reset}>OK</Button>
                      ) : (
                        <Button variant="primary" soft size="sm" onClick={() => activate(p.id)}>Show them</Button>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div key={p.id} className="flex items-center gap-0.5 rounded-lg hover:bg-(--bg-card-hover)">
                  <button
                    type="button"
                    aria-current={p.id === active.id}
                    onClick={() => activate(p.id)}
                    className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left"
                    data-testid="profile-row"
                  >
                    <span className="w-3.5 shrink-0 text-(--accent-text)">
                      {p.id === active.id && <IconCheck className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-(--text-primary)">{p.name}</span>
                      <span className="block truncate text-[11px] tabular-nums text-(--text-faint)">{metaFor(p)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setError(null); setDraft(p.name); setMode({ kind: "rename", id: p.id }); }}
                    title="Rename"
                    aria-label={`Rename ${p.name}`}
                    className="shrink-0 w-6 h-6 flex items-center justify-center text-(--text-faint) hover:text-(--text-secondary)"
                    data-testid="rename-profile"
                  >
                    <IconRename className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      const empty = !p.isDefault && p.books === 0 && p.folders === 0;
                      setMode({ kind: empty ? "delete" : "blocked", id: p.id });
                    }}
                    title="Delete"
                    aria-label={`Delete ${p.name}`}
                    className="shrink-0 w-6 h-6 mr-1 flex items-center justify-center text-(--text-faint) hover:text-(--danger-text)"
                    data-testid="delete-profile"
                  >
                    <IconDelete className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="p-1.5 border-t border-(--border)">
            {mode?.kind === "new" ? (
              <div className="flex items-center gap-1.5 p-1">
                <NameEditor
                  value={draft}
                  onChange={setDraft}
                  onSave={createProfile}
                  onCancel={reset}
                  label="New profile name"
                  saveLabel="Create profile"
                  placeholder="Profile name"
                  pending={createMutation.isPending}
                  testId="new-profile"
                />
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setError(null); setDraft(""); setMode({ kind: "new" }); }}
                className="w-full justify-start gap-2"
                data-testid="new-profile"
              >
                <IconAdd className="h-3.5 w-3.5 shrink-0 text-(--text-faint)" />
                New profile
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
