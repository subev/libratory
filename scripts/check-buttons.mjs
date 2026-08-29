// A hand-skinned <button> is a Button that nobody can restyle from one place. Tailwind sees valid
// classes and TypeScript sees a valid element, so only a scan like this notices the duplication.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULE = "packages/web/src/components/Button.tsx";
const SRC = "packages/web/src";
const HINT = `use <Button variant=… size=…> from ".../components/Button" (with to= for in-app routes) — add a variant to ${MODULE} if none fits`;

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx") && p !== MODULE) files.push(p);
  }
})(SRC);

// A skin is padding or a fixed box, plus a shape, plus a fill or an edge.
const skinned = (attrs) =>
  /\brounded\b|\brounded-/.test(attrs) &&
  /\bpx-|\bpy-|\bp-[0-9]|\bw-[0-9]/.test(attrs) &&
  /\bbg-\(--|\bborder\b|\bborder-\(--/.test(attrs);

const fail = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/<(button|a|Link|NavLink)[\s>]/g)) {
    // `onClick={() => …}` contains a ">", so the tag ends at the first ">" outside braces and quotes.
    let depth = 0;
    let quote = "";
    let open = -1;
    for (let i = m.index; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        open = i;
        break;
      }
    }
    if (open === -1) continue;
    const attrs = src.slice(m.index, open);
    // The opt-out may sit in a comment just above the element, which is where it reads best.
    const preceding = src.slice(Math.max(0, m.index - 240), m.index);
    if (attrs.includes("button-ok") || preceding.includes("button-ok") || !skinned(attrs)) continue;
    fail.push({ file, line: src.slice(0, m.index).split("\n").length, tag: m[1] });
  }
}

for (const { file, line, tag } of fail) console.error(`  ${file}:${line} — hand-skinned <${tag}>. ${HINT}`);
if (fail.length) {
  console.error(`\n${fail.length} hand-skinned button${fail.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`buttons ok — every skinned control goes through ${MODULE}`);
