import type { ReactNode } from "react";

import { trpc } from "../../trpc.ts";
import { DownloadNotice } from "../DownloadNotice.tsx";

type InstallState = { installing: boolean; progress: string | null; error: string | null };
type InstallableEngine = "bgtts" | "loudkit";

// These engines run in a Python environment of their own (BgTTS's codec needs an older torch than
// the rest of the app, loudkit an older numpy), so they are built on request rather than by every
// install. The voices unlock as soon as it finishes: the server checks the environment on every
// request, so nothing needs a restart.
const COPY: Record<InstallableEngine, { label: string; button: string; body: ReactNode }> = {
  bgtts: {
    label: "BgTTS",
    button: "Download and set up BgTTS (about 1.5 GB)",
    body: (
      <>
        The three <strong>BgTTS-38M</strong> narrators need their own Python environment — PyTorch, the
        MioCodec codec and the voice model, about <strong>1.5 GB</strong>, once. They run on the CPU at
        roughly 11x realtime.
      </>
    ),
  },
  loudkit: {
    label: "loudkit",
    button: "Download and set up loudkit (about 1.3 GB)",
    body: (
      <>
        The <strong>loudkit</strong> voices need their own Python environment — PyTorch and the loudr-1
        model, about <strong>1.3 GB</strong>, once. They run at roughly 3x realtime on Apple silicon, with
        every word timed for read-along. loudkit is Apache-2.0 by LoudReader, its model derived from
        Resemble AI&apos;s Chatterbox (MIT); the voices are CC0 donations.
      </>
    ),
  },
};

export function EngineInstallNotice({ engine, state }: { engine: InstallableEngine; state: InstallState }) {
  const utils = trpc.useUtils();
  const install = trpc.models.installEngine.useMutation({
    onSettled: () => void utils.models.engines.invalidate(),
  });
  const copy = COPY[engine];

  return (
    <DownloadNotice
      className="mx-1 mb-3"
      testIdPrefix={`${engine}-install`}
      settledLabel={copy.label}
      buttonLabel={copy.button}
      downloading={state.installing}
      progress={state.progress}
      disabled={install.isPending}
      error={install.error?.message ?? state.error}
      onDownload={() => install.mutate({ engine })}
    >
      <p className="text-(--text-secondary)">{copy.body}</p>
    </DownloadNotice>
  );
}
