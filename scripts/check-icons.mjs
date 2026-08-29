// An emoji or a "✓" in JSX is an icon that ignores the palette and changes shape per OS, and an
// inline <svg> is an icon nobody can find to reuse. Neither is something a type or a lint rule sees.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MODULE = "packages/web/src/components/icons.tsx";
const SRC = "packages/web/src";
const HINT = `import { IconX } from ".../components/icons" — add a line to ${MODULE} if the one you need is missing`;

const GLYPHS = "✓✔✕✖✗×▶▲▼◀◂▸▾▴‹›«»←→↑↓↗↘↙↖↻↺⟳⋯⋮≡⚙✎✏＋❚⏸⏹⏭⏮⌄⌃★☆⤢";
const ENTITIES = /&(times|larr|rarr|uarr|darr|check|cross|hellip|#x?[0-9a-fA-F]{2,7});/g;

const files = readdirSync(SRC, { recursive: true })
  .map((entry) => join(SRC, entry))
  .filter((p) => p.endsWith(".tsx") || p.endsWith(".ts"));

const fail = [];
const add = (file, line, what, why) => fail.push({ file, line, what, why });
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

for (const f of files) {
  const lines = source.get(f).split("\n");
  lines.forEach((raw, i) => {
    const at = i + 1;
    // An arrow in a comment is prose by construction — nothing there is ever rendered, so skip
    // before doing any decoding. There is no per-line escape hatch: one existed and went unused.
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    if (raw.includes("<svg")) add(f, at, "inline <svg>", `Use a shared icon: ${HINT}`);
    // Entities are matched on the raw line rather than decoded, so each reports once as an entity.
    for (const m of raw.matchAll(ENTITIES)) {
      add(f, at, `entity ${m[0]}`, `An entity is a glyph in disguise: ${HINT}`);
    }

    // "\u25B6" is a play triangle that no literal-character scan can see.
    const line = raw
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
    for (const ch of line) {
      if (GLYPHS.includes(ch)) add(f, at, `glyph ${ch}`, `A glyph is not an icon: ${HINT}`);
    }
    for (const m of line.matchAll(/\p{Extended_Pictographic}/gu)) {
      if (GLYPHS.includes(m[0])) continue;
      add(f, at, `emoji ${m[0]}`, `Emoji are full-colour OS artwork and ignore the palette: ${HINT}`);
    }
  });
}

const exported = [...source.get(MODULE).matchAll(/as (Icon[A-Za-z]+)/g)].map((m) => m[1]);
// One pass collecting every IconX mentioned anywhere, rather than 35 regexes over the whole tree
const rendered = new Set();
for (const [f, text] of source) {
  if (f === MODULE) continue;
  for (const m of text.matchAll(/\bIcon[A-Za-z]+\b/g)) rendered.add(m[0]);
}
const unused = exported.filter((n) => !rendered.has(n));

for (const { file, line, what, why } of fail) console.error(`  ${file}:${line} — ${what}. ${why}`);
for (const n of unused) console.error(`  unused icon ${n} — exported from ${MODULE}, rendered nowhere`);

if (fail.length || unused.length) {
  console.error(`\n${fail.length} hand-rolled icon${fail.length === 1 ? "" : "s"}, ${unused.length} unused export${unused.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`icons ok — ${exported.length} shared, all used; no hand-rolled icons`);
