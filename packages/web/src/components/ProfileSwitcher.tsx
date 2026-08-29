import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../trpc.ts";
import { getStoredProfileId, setStoredProfileId } from "../lib/profile.ts";
import { IconAdd, IconDelete, IconProfile, IconRename } from "./icons.tsx";
import { Button } from "./Button.tsx";

export function ProfileSwitcher() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const { data: profiles, isFetching } = trpc.profiles.list.useQuery();
  const createMutation = trpc.profiles.create.useMutation();
  const renameMutation = trpc.profiles.rename.useMutation();
  const deleteMutation = trpc.profiles.delete.useMutation();
  const [error, setError] = useState<string | null>(null);

  const stored = getStoredProfileId();
  // Deleted-elsewhere guard; skip while fetching so a just-created id isn't wiped mid-refetch
  const staleStored = !!profiles && !isFetching && !!stored && !profiles.some((p) => p.id === stored);
  useEffect(() => {
    if (staleStored) {
      setStoredProfileId(null);
      queryClient.invalidateQueries();
    }
  }, [staleStored, queryClient]);

  const active = profiles?.find((p) => p.id === stored) ?? profiles?.[0];
  if (!profiles || !active) return null;

  function activate(id: string) {
    setStoredProfileId(id);
    navigate("/");
    queryClient.invalidateQueries();
  }

  async function createProfile() {
    const name = window.prompt("New profile name")?.trim();
    if (!name) return;
    setError(null);
    try {
      const profile = await createMutation.mutateAsync({ name });
      utils.profiles.list.setData(undefined, (old) =>
        old ? [...old, { id: profile.id, name: profile.name, isDefault: false }] : old,
      );
      activate(profile.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const renameProfile = async () => {
    const name = window.prompt("Rename profile", active.name)?.trim();
    if (!name || name === active.name) return;
    setError(null);
    try {
      await renameMutation.mutateAsync({ id: active.id, name });
      utils.profiles.list.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteProfile = async () => {
    if (!confirm(`Delete profile "${active.name}"? Its books and folders must be deleted or moved first.`)) return;
    setError(null);
    try {
      await deleteMutation.mutateAsync({ id: active.id });
      setStoredProfileId(null);
      navigate("/");
      queryClient.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ml-auto flex items-center gap-2">
      {error && <span className="text-sm text-(--danger-text)">{error}</span>}
      <span title="Profile" className="text-sm"><IconProfile className="h-4 w-4" /></span>
      <select
        value={active.id}
        onChange={(e) => activate(e.target.value)}
        className="px-2 py-1.5 text-xs rounded-md border border-(--border) bg-(--bg-card) text-(--text-primary) outline-none"
        data-testid="profile-select"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <Button
        variant="icon"
        size="sm"
        aria-label="New profile"
        onClick={createProfile}
        title="New profile"
        data-testid="new-profile"
      >
        <IconAdd className="h-3 w-3" />
      </Button>
      <button
        onClick={renameProfile}
        title="Rename profile"
        className="text-(--text-faint) hover:text-(--text-secondary) text-xs"
        data-testid="rename-profile"
      >
        <IconRename className="h-3 w-3" />
      </button>
      <button
        onClick={deleteProfile}
        disabled={active.isDefault || deleteMutation.isPending}
        title={active.isDefault ? "The default profile cannot be deleted" : "Delete this profile (must be empty)"}
        className="text-(--text-faint) hover:text-(--danger-text) text-xs disabled:opacity-50"
        data-testid="delete-profile"
      >
        <IconDelete className="h-3 w-3" />
      </button>
    </div>
  );
}
