const KINDS = {
  digest: { label: "digest", title: "Digest — AI summary chapters from other books" },
  api: { label: "api", title: "Created through the external API by a script or another project" },
} as const;

// The library list and the search results describe the same book, so they say it the same way.
export function BookKindBadge({ kind }: { kind: string }) {
  const meta = KINDS[kind as keyof typeof KINDS];
  if (!meta) return null;
  return (
    <span
      className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-secondary) align-middle"
      data-testid={`${kind}-badge`}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
}
