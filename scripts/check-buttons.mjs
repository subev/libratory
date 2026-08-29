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
  /\bpx-|\bpy-|\bp-[0-9]|\bw-[0-9]|\bsize-[0-9[]|\b[hw]-\[/.test(attrs) &&
  /\bbg-\(--|\bbg-[a-z]|\bborder\b|\bborder-\(--/.test(attrs);

const fail = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  // Hoisting a skin into `const CHIP = "…"` used to hide it completely, which is how the old
  // button-classes.ts would have sailed back in. Resolve simple local string consts.
  const consts = new Map(
    [...src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\n?\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
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
    let attrs = src.slice(m.index, open);
    for (const ref of attrs.matchAll(/\{\s*`?([A-Za-z_$][\w$]*)`?\s*\}|\$\{([A-Za-z_$][\w$]*)\}/g)) {
      const value = consts.get(ref[1] ?? ref[2]);
      if (value) attrs += " " + value;
    }
    // The opt-out may sit in a comment just above the element, which is where it reads best.
    // The opt-out has to be written directly above the element it excuses. A character window is
    // too loose — an incidental mention far above would cover everything below it — so this looks
    // only at the two non-blank lines immediately preceding the tag.
    // Verbatim, blanks included: a marker separated by empty lines is not "directly above".
    const above = src.slice(0, m.index).split("\n").slice(-4, -1);
    const marker = above.findIndex((l) => l.includes("button-ok"));
    const optedOut =
      attrs.includes("button-ok") ||
      (marker !== -1 && !above.slice(marker).some((l) => /<(button|a|Link|NavLink)[\s>]/.test(l)));
    if (optedOut || !skinned(attrs)) continue;
    fail.push({ file, line: src.slice(0, m.index).split("\n").length, tag: m[1] });
  }
}

for (const { file, line, tag } of fail) console.error(`  ${file}:${line} — hand-skinned <${tag}>. ${HINT}`);
if (fail.length) {
  console.error(`\n${fail.length} hand-skinned button${fail.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`buttons ok — every skinned control goes through ${MODULE}`);
