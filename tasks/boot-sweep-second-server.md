# The boot sweep must not run before the port is ours

Seen 2026-10-11 00:04: the desktop app was launched while `pnpm dev` was serving on 3034. The
app's server ran migrations and `startWorker` — whose first act is `sweepStrandedWork` — against
the same Postgres, **then** failed on `EADDRINUSE`. Its log reads
`Startup sweep: purged 5 dead job(s), requeued 3 stranded job(s)` followed by the port error. The
sweep assumes every locked job belongs to a dead process, so it deleted the dev server's three
running translations and two running sentence pairings, re-queued the translations, and marked the
pairings "Interrupted by server restart — retry explicitly to continue". Nothing had restarted.

Fix: take the port before touching the job queue. Either `fastify.listen` before `startWorker`
(nothing between them needs the workers), or probe the port and refuse — the desktop shell already
has the friendly message for that case, it just arrives after the damage. Also worth a thought: a
server that loses the port race should not have run migrations either, though those are idempotent.

Not done in the session that found it because editing `main.ts` restarts the dev server, which
would have interrupted hours of narration in flight.
