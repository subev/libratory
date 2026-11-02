import { trpc } from "../../trpc.ts";
import { DownloadNotice } from "../DownloadNotice.tsx";

type PocketCloningState = {
  tokenSet: boolean;
  downloading: boolean;
  error: string | null;
  envFile: string;
};

const TERMS_URL = "https://huggingface.co/kyutai/pocket-tts";

export function PocketCloningNotice({ cloning }: { cloning: PocketCloningState }) {
  const utils = trpc.useUtils();
  const download = trpc.pocketVoices.downloadCloning.useMutation({
    onSuccess: () => void utils.pocketVoices.list.invalidate(),
  });

  if (!cloning.tokenSet) {
    return (
      <p className="px-3 py-2 text-xs text-(--text-muted)" data-testid="pocket-cloning-token-needed">
        Voice cloning needs Kyutai's model terms accepted on a free HuggingFace account: accept them at{" "}
        <a href={TERMS_URL} target="_blank" rel="noreferrer" className="underline">
          huggingface.co/kyutai/pocket-tts
        </a>
        , add <code>HF_TOKEN=</code> with a read token to <code>{cloning.envFile}</code> (or the container's
        environment), and restart Libratory. A download button then appears here.
      </p>
    );
  }

  return (
    <DownloadNotice
      className="mx-1 my-2"
      testIdPrefix="pocket-cloning"
      settledLabel="Voice cloning"
      buttonLabel="Download cloning weights (370 MB)"
      downloading={cloning.downloading}
      disabled={download.isPending}
      error={cloning.error ?? download.error?.message ?? null}
      onDownload={() => download.mutate()}
    >
      <p className="text-(--text-secondary)">
        <strong>Voice cloning</strong> needs Pocket TTS's gated English model — about <strong>370 MB</strong>, once.
        The recording you clone from stays on this machine.
      </p>
    </DownloadNotice>
  );
}
