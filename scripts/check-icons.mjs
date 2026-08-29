// An emoji or a "✓" in JSX is an icon that ignores the palette and changes shape per OS, and an
// inline <svg> is an icon nobody can find to reuse. Neither is something a type or a lint rule sees.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULE = "packages/web/src/components/icons.tsx";
const SRC = "packages/web/src";
const HINT = `import { IconX } from ".../components/icons" — add a line to ${MODULE} if the one you need is missing`;

const GLYPHS = "✓✔✕✖✗×▶▲▼◀◂▸▾▴‹›«»←→↑↓↗↘↙↖↻↺⟳⋯⋮≡⚙✎✏＋❚⏸⏹⏭⏮⌄⌃★☆⤢";
const ENTITIES = /&(times|larr|rarr|uarr|darr|check|cross|hellip|#x?[0-9a-fA-F]{2,5});/g;

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) files.push(p);
  }
})(SRC);

const fail = [];
const add = (file, line, what, why) => fail.push({ file, line, what, why });

for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const at = i + 1;
    // "\u25B6" is a play triangle that no literal-character scan can see.
    const line = raw
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#x([0-9a-fA-F]{2,5});/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]{2,7});/g, (_, dec) => String.fromCodePoint(Number(dec)));
    // An arrow can be prose ("press ←") rather than an icon; spell it out where you can, mark it
    // where you cannot. It excuses the glyph scan only — an <svg>, an emoji or an entity still fails.
    // An arrow in a comment is prose by construction — nothing there is ever rendered.
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    const prose = line.includes("prose-glyph");
    if (line.includes("<svg")) add(f, at, "inline <svg>", `Use a shared icon: ${HINT}`);
    for (const ch of line) {
      if (!prose && GLYPHS.includes(ch)) add(f, at, `glyph ${ch}`, `A glyph is not an icon: ${HINT}`);
    }
    for (const m of line.matchAll(/\p{Extended_Pictographic}/gu)) {
      if (GLYPHS.includes(m[0])) continue;
      add(f, at, `emoji ${m[0]}`, `Emoji are full-colour OS artwork and ignore the palette: ${HINT}`);
    }
    // Against the raw line and never excused: prose needs an arrow, never "&#9654;".
    for (const m of raw.matchAll(ENTITIES)) {
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
