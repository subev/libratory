#!/usr/bin/env node
// How many people downloaded the Mac app.
//
//   node scripts/download-stats.mjs               GitHub's per-release asset counters
//   node scripts/download-stats.mjs --cloudflare  the redirect's own log, by day and country
//
// The two measure different things and neither replaces the other. GitHub counts anything that
// pulls the asset — bots and mirrors included — and updates in batches rather than live. The
// redirect counts clicks on our own Download button, which is the number that answers "did the
// post work", but only exists for traffic that went through get.libratory.dev.
import { execFileSync } from "node:child_process";

const REPO = "subev/libratory";
const DATASET = "libratory_downloads";

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20 });

function github() {
  const releases = JSON.parse(
    gh("api", `repos/${REPO}/releases`, "--paginate", "--jq",
      "[.[] | select(.draft==false) | {tag: .tag_name, day: .published_at[0:10], assets: .assets}]"),
  );

  let dmg = 0;
  let zip = 0;
  const rows = [];
  for (const r of releases) {
    const count = (suffix) => r.assets
      .filter((a) => a.name.endsWith(suffix) && !a.name.endsWith(".blockmap"))
      .reduce((n, a) => n + a.download_count, 0);
    const [d, z] = [count(".dmg"), count(".zip")];
    dmg += d;
    zip += z;
    rows.push({ tag: r.tag, day: r.day, dmg: d, updates: z });
  }

  console.log(`\n  GitHub release assets — ${REPO}\n`);
  console.table(rows);
  console.log(`  ${dmg} DMG downloads (people), ${zip} zip downloads (the updater)\n`);
}

async function cloudflare() {
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!account || !token) {
    console.error("\n  Set CF_ACCOUNT_ID and CF_API_TOKEN (Account Analytics: Read).\n");
    process.exit(1);
  }

  const sql = async (query) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: query },
    );
    if (!res.ok) {
      console.error(`\n  Cloudflare said ${res.status}: ${await res.text()}\n`);
      process.exit(1);
    }
    return (await res.json()).data ?? [];
  };

  const byDay = await sql(`
    SELECT toDate(timestamp) AS day, count() AS downloads
    FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY day ORDER BY day DESC`);

  const bySource = await sql(`
    SELECT blob1 AS country, blob2 AS source, count() AS downloads
    FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY country, source ORDER BY downloads DESC`);

  console.log("\n  Download button clicks — last 30 days\n");
  if (!byDay.length) return console.log("  Nothing yet. Either nobody clicked, or /mac is not live.\n");
  console.table(byDay);
  console.table(bySource);
  console.log();
}

if (process.argv.includes("--cloudflare")) await cloudflare();
else github();
