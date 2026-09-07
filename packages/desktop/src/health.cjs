// Anything can be listening on the port, and a checkout's `pnpm dev` server usually is: it answers
// /health exactly like ours, serves its own web bundle — stale as often as not — and the launcher
// then adopts it and shows an old UI with nothing in the log to say so. A token the launcher hands
// to the server it spawned is the only thing that tells the two apart.
const POLL_MS = 700;

async function probe(url, instance) {
  const body = await fetch(url, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? /** @type {Promise<{ instance?: string | null }>} */ (r.json()) : null))
    .catch(() => null);
  if (!body) return "down";
  return body.instance === instance ? "ours" : "foreign";
}

async function waitForServer(url, instance, timeoutMs, abandoned = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Probed before `abandoned` is consulted: a taken port kills our server within milliseconds, and
    // checking that first reports "address already in use" for the very case this exists to name.
    const state = await probe(url, instance);
    if (state !== "down") return state;
    if (abandoned()) return "abandoned";
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return "timeout";
}

module.exports = { probe, waitForServer };
