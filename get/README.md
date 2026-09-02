# get.libratory.dev

One Cloudflare Pages project whose only job is the Download button, so that its request count *is*
the download count. Keep it that way: a second Function here blends into the same metrics chart and
the number stops meaning anything.

`/mac` → 302 → `github.com/subev/libratory/releases/latest/download/Libratory-arm64.dmg`

## Deploy

```sh
npx wrangler login
npx wrangler pages deploy          # from this directory
```

Then in the dashboard: **Workers & Pages → libratory-get → Custom domains → `get.libratory.dev`**.

## Where the numbers are

**Downloads over time**, free, no query: **Workers & Pages → libratory-get → Functions Metrics.**
Because `/mac` is the only Function, its request count is the number of people who clicked Download.

**Country, source and referrer** come from the Analytics Engine dataset:

```sh
node scripts/download-stats.mjs --cloudflare
```

Tag a link with `?from=` to see where a click came from — `get.libratory.dev/mac?from=hn` — and it
lands in the `source` column instead of the referrer.

## Why not the other options

- **Cloudflare Web Analytics** is a JS beacon that fires on page load. A 302 renders no page, so it
  never fires. It cannot see this.
- **Zone Traffic analytics** does see it — it is edge-side — but has no per-path breakdown on the
  free plan, and libratory.dev already serves ~1.7k requests a day. A download would be invisible.
- **GitHub's `download_count`** still works as a slow cross-check (`node scripts/download-stats.mjs`),
  but it is batched: a verified full 190 MB download did not move it within several minutes.
