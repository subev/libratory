import { trpc } from "../../trpc.ts";
import { DownloadNotice } from "../DownloadNotice.tsx";

type InstallState = { installing: boolean; progress: string | null; error: string | null };

// BgTTS runs in a Python environment of its own (its codec needs an older torch than the rest of
// the app), so it is built on request rather than by every install. The voices unlock as soon as
// it finishes: the server checks the environment on every request, so nothing needs a restart.
export function BgttsInstallNotice({ state }: { state: InstallState }) {
  const utils = trpc.useUtils();
  const install = trpc.models.installEngine.useMutation({
    onSettled: () => void utils.models.engines.invalidate(),
  });

  return (
    <DownloadNotice
      className="mx-1 mb-3"
      testIdPrefix="bgtts-install"
      settledLabel="BgTTS"
      buttonLabel="Download and set up BgTTS (about 1.5 GB)"
      downloading={state.installing}
      progress={state.progress}
      disabled={install.isPending}
      error={install.error?.message ?? state.error}
      onDownload={() => install.mutate({ engine: "bgtts" })}
    >
      <p className="text-(--text-secondary)">
        The three <strong>BgTTS-38M</strong> narrators need their own Python environment — PyTorch, the
        MioCodec codec and the voice model, about <strong>1.5 GB</strong>, once. They run on the CPU at
        roughly 11x realtime.
      </p>
    </DownloadNotice>
  );
}
