import { trpc } from "../trpc.ts";
import { DownloadNotice } from "./DownloadNotice.tsx";

// Setup no longer downloads ~11 GB of models nobody asked for. Each optional bundle arrives at the
// one place its feature is requested, which is the same bargain PocketLanguageNotice already makes
// for voices — see that component for the shape this follows.
export function useModelBundle(id: string) {
  const { data: bundles, error } = trpc.models.list.useQuery(undefined, {
    // Only while something is downloading; otherwise this costs a Python start per poll
    // Matches the reporter's own 2s tick in models.py, so the number moves rather than jumping
    refetchInterval: (q) => (q.state.data?.some((b) => b.downloading) ? 2000 : false),
    // Nothing changes `installed` except models.download, which invalidates below
    staleTime: Infinity,
  });
  const bundle = bundles?.find((b) => b.id === id) ?? null;
  return {
    bundle,
    error,
    // Unknown means the status call has not answered yet; blocking on that would flicker every
    // gated button on every page load, so treat it as ready until told otherwise.
    ready: bundle?.installed !== false,
  };
}

export function ModelBundleNotice({ id, verb }: { id: string; verb: string }) {
  const utils = trpc.useUtils();
  const { bundle, error } = useModelBundle(id);
  const { data: capabilities } = trpc.models.capabilities.useQuery(undefined, { staleTime: Infinity });
  const download = trpc.models.download.useMutation({ onSuccess: () => void utils.models.list.invalidate() });

  // Buttons stay enabled when the probe itself is broken — but saying so beats letting the job
  // queue and die in a worker with a Python traceback nobody sees.
  if (error) {
    return (
      <p className="rounded-md border border-(--border) bg-(--bg-subtle) px-3 py-2 text-xs text-(--danger-text)" data-testid={`model-probe-error-${id}`}>
        Could not check which models are installed: {error.message}
      </p>
    );
  }
  if (!bundle || bundle.installed) return null;

  const gb = (bundle.approxMb / 1024).toFixed(1);
  // Offering a 1.2 GB download for models that need Metal, on a machine without it, is worse than
  // saying nothing — the voices it would unlock are already greyed out for the same reason.
  if (bundle.appleSiliconOnly && capabilities?.mlx === false) {
    return (
      <p className="rounded-md border border-(--border) bg-(--bg-subtle) px-3 py-2 text-xs text-(--text-muted)" data-testid={`model-notice-${id}`}>
        {verb} needs the <strong>{bundle.label}</strong> models, which run only on Apple Silicon.
      </p>
    );
  }

  return (
    <DownloadNotice
      testIdPrefix={`model-${id}`}
      settledLabel={bundle.label}
      buttonLabel={`Download (${gb} GB)`}
      downloading={bundle.downloading}
      progress={bundle.progress}
      disabled={download.isPending}
      error={bundle.error ?? download.error?.message ?? null}
      onDownload={() => download.mutate({ id })}
    >
      <p className="text-(--text-secondary)">
        {verb} needs the <strong>{bundle.label}</strong> models — about <strong>{gb} GB</strong>, once. {bundle.unlocks}.
      </p>
    </DownloadNotice>
  );
}
