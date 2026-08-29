// bg-(--typo) compiles to valid CSS that paints nothing, which Tailwind cannot catch.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CSS = "packages/web/src/styles.css";
const SRC = "packages/web/src";

const css = readFileSync(CSS, "utf8");
const declared = new Set([...css.matchAll(/^\s*(--[a-z][a-z0-9-]*)\s*:/gm)].map((m) => m[1]));

const files = readdirSync(SRC, { recursive: true })
  .map((entry) => join(SRC, entry))
  .filter((p) => /\.tsx?$/.test(p));

const used = new Map();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/\((--[a-z][a-z0-9-]*)\)/g)) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
}

const undeclared = [...used].filter(([t]) => !declared.has(t));
// A palette entry counts as used only if the semantic layer references it — that tier is the one
// most likely to accumulate dead colour, so exempting it defeats the check.
const unused = [...declared].filter((t) => !used.has(t) && !t.startsWith("--font-") && !css.includes(`var(${t})`));

for (const [t, f] of undeclared) console.error(`  undeclared token ${t} — used in ${f}`);
for (const t of unused) console.error(`  unused token ${t} — declared in ${CSS}`);
if (undeclared.length || unused.length) {
  console.error(`\n${undeclared.length} undeclared, ${unused.length} unused`);
  process.exit(1);
}
console.log(`tokens ok — ${used.size} referenced, all declared; no dead declarations`);
