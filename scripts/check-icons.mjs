// An emoji or a "✓" in JSX is an icon that ignores the palette and changes shape per OS, and an
// inline <svg> is an icon nobody can find to reuse. Neither is something a type or a lint rule sees.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULE = "packages/web/src/components/icons.tsx";
const SRC = "packages/web/src";
const HINT = `import { IconX } from ".../components/icons" — add a line to ${MODULE} if the one you need is missing`;

const GLYPHS = "✓✔✕✖✗×▶▲▼◀◂▸▾▴‹›«»←→↑↓↗↘↙↖↻↺⟳⋯⋮≡⚙✎✏＋❚⏸⏹⏭⏮⌄⌃★☆⤢";
const ENTITIES = /&(times|larr|rarr|uarr|darr|check|cross|hellip|#10005|#9654|#9650|#9660|#9664|#8592|#8594);/g;

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
})(SRC);

const fail = [];
const add = (file, line, what, why) => fail.push({ file, line, what, why });

for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = i + 1;
    // An arrow can be prose ("press ←") rather than an icon; spell it out where you can, mark it where you cannot.
    if (line.includes("prose-glyph")) return;
    if (line.includes("<svg")) add(f, at, "inline <svg>", `Use a shared icon: ${HINT}`);
    for (const ch of line) {
      if (GLYPHS.includes(ch)) add(f, at, `glyph ${ch}`, `A glyph is not an icon: ${HINT}`);
    }
    for (const m of line.matchAll(/\p{Extended_Pictographic}/gu)) {
      add(f, at, `emoji ${m[0]}`, `Emoji are full-colour OS artwork and ignore the palette: ${HINT}`);
    }
    for (const m of line.matchAll(ENTITIES)) {
      add(f, at, `entity ${m[0]}`, `An entity is a glyph in disguise: ${HINT}`);
    }
  });
}

const exported = [...readFileSync(MODULE, "utf8").matchAll(/as (Icon[A-Za-z]+)/g)].map((m) => m[1]);
const body = files.filter((f) => f !== MODULE).map((f) => readFileSync(f, "utf8")).join("\n");
const unused = exported.filter((n) => !new RegExp(`\\b${n}\\b`).test(body));

for (const { file, line, what, why } of fail) console.error(`  ${file}:${line} — ${what}. ${why}`);
for (const n of unused) console.error(`  unused icon ${n} — exported from ${MODULE}, rendered nowhere`);

if (fail.length || unused.length) {
  console.error(`\n${fail.length} hand-rolled icon${fail.length === 1 ? "" : "s"}, ${unused.length} unused export${unused.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`icons ok — ${exported.length} shared, all used; no hand-rolled icons`);
