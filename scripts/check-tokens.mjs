// bg-(--typo) compiles to background-color: var(--typo) — valid CSS that paints nothing. Tailwind
// cannot catch it and neither can its linter, so this does: every (--token) in the source must be
// declared in styles.css, and every declared token must be used.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CSS = "packages/web/src/styles.css";
const SRC = "packages/web/src";

const css = readFileSync(CSS, "utf8");
const declared = new Set([...css.matchAll(/^\s*(--[a-z][a-z0-9-]*)\s*:/gm)].map((m) => m[1]));

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
})(SRC);

const used = new Map();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/\((--[a-z][a-z0-9-]*)\)/g)) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
}

const undeclared = [...used].filter(([t]) => !declared.has(t));
// Palette entries are consumed by the semantic layer inside the stylesheet, not from components.
const unused = [...declared].filter((t) => !used.has(t) && !t.startsWith("--pal-") && !t.startsWith("--stack-") && !t.startsWith("--font-") && !css.includes(`var(${t})`));

for (const [t, f] of undeclared) console.error(`  undeclared token ${t} — used in ${f}`);
for (const t of unused) console.error(`  unused token ${t} — declared in ${CSS}`);
if (undeclared.length || unused.length) {
  console.error(`\n${undeclared.length} undeclared, ${unused.length} unused`);
  process.exit(1);
}
console.log(`tokens ok — ${used.size} referenced, all declared; no dead declarations`);
