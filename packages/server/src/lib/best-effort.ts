// For writes a job makes on the side — progress, cancel polls — that the engines fire without
// awaiting. Before this, one Postgres timeout inside such a callback surfaced as an unhandled
// rejection and took the whole server down mid-narration; the job's own result path is unaffected.
export async function bestEffort(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`${label} failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
