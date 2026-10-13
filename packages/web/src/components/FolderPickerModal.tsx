import { useMemo, useState } from "react";
import { trpc } from "../trpc.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { Button } from "./Button.tsx";
import { IconFolder, IconProfile } from "./icons.tsx";
import { getStoredProfileId } from "../lib/profile.ts";

type FolderNode = { id: string; name: string; depth: number };

// A folder (null = unfiled) in this profile, or the home of another profile
type Target = { kind: "folder"; id: string | null } | { kind: "profile"; id: string; name: string };

export function FolderPickerModal({
  bookIds,
  folderIds,
  onClose,
  onMoved,
}: {
  bookIds: string[];
  folderIds: string[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: allFolders = [] } = trpc.folders.list.useQuery();
  const { data: profiles = [] } = trpc.profiles.list.useQuery();
  const [target, setTarget] = useState<Target>({ kind: "folder", id: null });
  const targetId = target.kind === "folder" ? target.id : null;
  const [newName, setNewName] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Moving a folder into itself or its own subtree is invalid — hide those targets
  const tree = useMemo(() => {
    const childrenOf = new Map<string | null, typeof allFolders>();
    for (const f of allFolders) {
      const key = f.parentId ?? null;
      childrenOf.set(key, [...(childrenOf.get(key) ?? []), f]);
    }
    const excluded = new Set<string>();
    const excludeWalk = (id: string) => {
      excluded.add(id);
      for (const child of childrenOf.get(id) ?? []) excludeWalk(child.id);
    };
    for (const id of folderIds) excludeWalk(id);

    const nodes: FolderNode[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of childrenOf.get(parentId) ?? []) {
        if (excluded.has(f.id)) continue;
        nodes.push({ id: f.id, name: f.name, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return nodes;
  }, [allFolders, folderIds]);

  // A stale stored id falls back to the default on the server, so it does here too
  const stored = getStoredProfileId();
  const currentProfileId = profiles.some((p) => p.id === stored) ? stored : profiles.find((p) => p.isDefault)?.id;
  const otherProfiles = profiles.filter((p) => p.id !== currentProfileId);

  const moveBooksMutation = trpc.books.moveToFolder.useMutation();
  const moveToProfileMutation = trpc.books.moveToProfile.useMutation();
  const moveFolderMutation = trpc.folders.move.useMutation();
  const createMutation = trpc.folders.create.useMutation({
    onSuccess: (folder) => {
      setNewName(null);
      setTarget({ kind: "folder", id: folder.id });
      utils.folders.list.invalidate();
    },
  });

  const itemCount = bookIds.length + folderIds.length;
  const itemLabel = [
    bookIds.length > 0 ? `${bookIds.length} book${bookIds.length === 1 ? "" : "s"}` : null,
    folderIds.length > 0 ? `${folderIds.length} folder${folderIds.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" and ");

  async function move() {
    if (moving) return;
    setMoving(true);
    setMoveError(null);
    try {
      if (target.kind === "profile") {
        await moveToProfileMutation.mutateAsync({ ids: bookIds, profileId: target.id });
        utils.profiles.list.invalidate();
      } else {
        if (bookIds.length > 0) await moveBooksMutation.mutateAsync({ ids: bookIds, folderId: target.id });
        for (const id of folderIds) {
          await moveFolderMutation.mutateAsync({ id, parentId: target.id });
        }
      }
      utils.books.list.invalidate();
      utils.folders.list.invalidate();
      onMoved();
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err));
      utils.books.list.invalidate();
      utils.folders.list.invalidate();
    } finally {
      setMoving(false);
    }
  }

  const row = (next: Target, label: string, depth: number, icon?: "folder" | "profile", disabledReason?: string) => {
    const selected = target.kind === next.kind && target.id === next.id;
    return (
      // button-ok: a radio row picking the move destination, not an action — the move button below acts
      <button
        key={`${next.kind}:${next.id ?? "root"}`}
        onClick={() => setTarget(next)}
        disabled={!!disabledReason}
        title={disabledReason}
        className={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2 disabled:opacity-50 ${
          selected ? "bg-(--bg-selected) text-(--text-primary)" : "text-(--text-secondary) enabled:hover:bg-(--bg-subtle)"
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        data-testid={next.kind === "profile" ? "folder-picker-profile-row" : "folder-picker-row"}
      >
        <span className={`w-3 h-3 rounded-full border shrink-0 ${selected ? "bg-(--accent) border-(--accent)" : "border-(--border)"}`} />
        {icon === "folder" && <IconFolder className="h-4 w-4 shrink-0" />}
        {icon === "profile" && <IconProfile className="h-4 w-4 shrink-0" />}
        <span className="truncate">{label}</span>
      </button>
    );
  };
  const profileDisabled = folderIds.length > 0
    ? "A folder stays in its profile — select only books to move them to another profile"
    : undefined;

  return (
    <Modal size="sm" onClose={onClose} testId="folder-picker-modal">
      <ModalHeader title={`Move ${itemLabel} to…`} onClose={onClose} />

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {row({ kind: "folder", id: null }, "Unfiled (home)", 0)}
        {tree.map((n) => row({ kind: "folder", id: n.id }, n.name, n.depth, "folder"))}
        {otherProfiles.length > 0 && (
          <>
            <p className="px-3 pt-3 pb-1 text-xs text-(--text-muted)">Another profile — arrives unfiled</p>
            {otherProfiles.map((p) =>
              row({ kind: "profile", id: p.id, name: p.name }, p.name, 0, "profile", profileDisabled))}
          </>
        )}
      </div>

      <div className="border-t border-(--border) px-4 py-3 shrink-0 space-y-2">
        {newName !== null ? (
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) {
                createMutation.mutate({ name: newName.trim(), parentId: targetId });
              }
              if (e.key === "Escape") setNewName(null);
            }}
            placeholder="New folder name — created inside the selection, Enter to create"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-(--border-input) bg-(--bg-input) text-(--text-primary) outline-none"
            data-testid="folder-picker-new-name"
          />
        ) : (
          <button
            onClick={() => setNewName("")}
            className="text-sm text-(--accent-text) hover:text-(--accent-text-hover)"
            data-testid="folder-picker-new"
          >
            + New folder…
          </button>
        )}
        {(moveError || createMutation.error) && (
          <p className="text-sm text-(--danger-text)">{moveError ?? createMutation.error!.message}</p>
        )}
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={move}
            disabled={moving || itemCount === 0}
            data-testid="folder-picker-move"
          >
            {moving ? "Moving..." : `Move ${itemLabel}${target.kind === "profile" ? ` to ${target.name}` : ""}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
