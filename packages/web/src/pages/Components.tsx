import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router";
import css from "../styles.css?raw";
import { Button, VARIANTS, SOFT_VARIANTS } from "../components/Button.tsx";
import { PillToggle } from "../components/PillToggle.tsx";
import { StatusBadge, statusStyles } from "../components/StatusBadge.tsx";
import * as Icons from "../components/icons.tsx";
import { IconRefresh } from "../components/icons.tsx";

type IconComponent = ComponentType<{ className?: string; weight?: "regular" | "fill" }>;

// Read off the module rather than listed here, so an icon added there shows up without a second edit.
const ICONS = (Object.entries(Icons) as [string, IconComponent][])
  .filter(([name]) => name.startsWith("Icon") && name !== "IconDefaults")
  .sort(([a], [b]) => a.localeCompare(b));

type Token = { name: string; text?: boolean; on?: string };
type Group = { title: string; tokens: Token[] };

// Same regex scripts/check-tokens.mjs uses, so the page and the lint gate agree on what exists.
const DECLARED = [...new Set([...css.matchAll(/^\s*(--[a-z][a-z0-9-]*)\s*:/gm)].flatMap((m) => m[1] ?? []))].filter(
  (name) => !name.startsWith("--stack-") && !name.startsWith("--font-"),
);

const PALETTE_GROUPS: [title: string, families: string[]][] = [
  ["orange / ember", ["orange", "ember"]],
  ["brass", ["brass"]],
  ["warm neutrals", ["neutral", "ink", "white", "terminal"]],
  ["cream alphas", ["cream"]],
  ["red", ["red"]],
  ["green", ["green"]],
  ["categorical badge hues", ["gold", "blue", "brown"]],
];

// Semantic names do not encode their group, so the mapping is by hand. Longest prefix wins.
const SEMANTIC_PREFIXES: [prefix: string, title: string][] = [
  ["--bg-", "surfaces"],
  ["--border", "lines"],
  ["--divide", "lines"],
  ["--focus-ring", "lines"],
  ["--text-", "text"],
  ["--accent", "accent"],
  ["--on-accent", "accent"],
  ["--danger", "status"],
  ["--success", "status"],
  ["--warning", "status"],
  ["--on-danger", "status"],
  ["--on-success", "status"],
  ["--on-warning", "status"],
  ["--step-", "status"],
  ["--badge-", "badges"],
  ["--bg-terminal", "terminal"],
  ["--terminal-", "terminal"],
  ["--bg-reading", "reading"],
  ["--border-reading", "reading"],
  ["--bg-custom-text", "reading"],
  ["--border-custom-text", "reading"],
  ["--cue-", "cues"],
];

const SEMANTIC_TITLES = ["surfaces", "lines", "text", "accent", "status", "badges", "terminal", "reading", "cues"];
const PALETTE_TITLES = PALETTE_GROUPS.map(([title]) => title);

function groupOf(name: string): string | null {
  if (name.startsWith("--pal-")) {
    const family = name.slice("--pal-".length).split("-")[0] ?? "";
    return PALETTE_GROUPS.find(([, families]) => families.includes(family))?.[0] ?? null;
  }
  let best: string | null = null;
  let matched = 0;
  for (const [prefix, title] of SEMANTIC_PREFIXES) {
    if (name.startsWith(prefix) && prefix.length > matched) {
      best = title;
      matched = prefix.length;
    }
  }
  return best;
}

function tokenOf(name: string): Token {
  if (name.startsWith("--on-")) return { name, text: true, on: `--${name.slice("--on-".length)}` };
  if (name.startsWith("--badge-") && name.endsWith("-text")) {
    return { name, text: true, on: `${name.slice(0, -"-text".length)}-bg` };
  }
  if (name.startsWith("--terminal-") && name !== "--terminal-border") {
    return { name, text: true, on: "--bg-terminal" };
  }
  const text = name.startsWith("--text-") || (/-text(-hover)?$/.test(name) && !/^--(bg|border)-/.test(name));
  return text ? { name, text: true } : { name };
}

const BUCKETS = new Map<string, Token[]>();
const UNGROUPED: Token[] = [];
for (const name of DECLARED) {
  const title = groupOf(name);
  if (title === null) {
    UNGROUPED.push(tokenOf(name));
    continue;
  }
  const bucket = BUCKETS.get(title);
  if (bucket) bucket.push(tokenOf(name));
  else BUCKETS.set(title, [tokenOf(name)]);
}

const groupsFor = (titles: string[]): Group[] =>
  titles.flatMap((title) => {
    const tokens = BUCKETS.get(title);
    return tokens ? [{ title, tokens }] : [];
  });

const SEMANTIC = groupsFor(SEMANTIC_TITLES);
const PALETTE = groupsFor(PALETTE_TITLES);
const count = (groups: Group[]) => groups.reduce((n, group) => n + group.tokens.length, 0);

const PROSE =
  "Hard by a great forest dwelt a poor wood-cutter with his wife and his two children. The boy was called Hansel and the girl Gretel. He had little to bite and to break, and once when great dearth fell on the land, he could no longer procure even daily bread. Now when he thought over this by night in his bed, and tossed about in his anxiety, he groaned and said to his wife: what is to become of us? How are we to feed our poor children, when we no longer have anything even for ourselves?";

const READING_PANE =
  "mx-auto w-full max-w-prose rounded bg-(--bg-reading) border border-(--border-reading) px-7 py-6 font-reading text-[17px] leading-relaxed text-(--text-primary)";

const CARD = "rounded-lg border border-(--border) bg-(--bg-card) p-4";

// Lint bans --pal-* in classNames and Tailwind cannot build a class from a variable, so fills go inline.
function Swatch({ token }: { token: Token }) {
  const label = <span className="block truncate font-mono text-[10px] text-(--text-muted)">{token.name}</span>;
  if (token.text) {
    return (
      <div>
        <div
          className="flex h-10 items-center justify-center rounded border border-(--border) text-sm font-medium"
          style={{ background: `var(${token.on ?? "--bg-card"})`, color: `var(${token.name})` }}
        >
          Aa
        </div>
        {label}
      </div>
    );
  }
  return (
    <div>
      <div className="h-10 rounded border border-(--border)" style={{ background: `var(${token.name})` }} />
      {label}
    </div>
  );
}

function IconGallery() {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = ICONS.filter(([name]) => name.toLowerCase().includes(needle));

  return (
    <div className={`space-y-4 ${CARD}`}>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name"
          aria-label="Filter icons"
          className="w-56 rounded-md border border-(--border) bg-(--bg-input) px-3 py-1.5 text-sm text-(--text-primary) placeholder:text-(--text-faint)"
        />
        <span className="font-mono text-xs text-(--text-muted)">
          {shown.length} of {ICONS.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-(--text-muted)">
          Nothing matches. Find one at phosphoricons.com and add a line to components/icons.tsx.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-2">
          {shown.map(([name, Icon]) => (
            <li
              key={name}
              className="flex flex-col items-center gap-2 rounded-md border border-(--border) px-2 py-3"
            >
              <Icon className="h-5 w-5 text-(--text-primary)" />
              <span className="w-full truncate text-center font-mono text-[10px] text-(--text-muted)">{name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GallerySection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="space-y-4">
      <h2 className="text-xl text-(--text-primary)">{title}</h2>
      {children}
    </section>
  );
}

function TokenGrid({ tokens }: { tokens: Token[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {tokens.map((token) => (
        <Swatch key={token.name} token={token} />
      ))}
    </div>
  );
}

function TokenGroups({ groups }: { groups: Group[] }) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.title}>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-(--text-faint)">{group.title}</div>
          <TokenGrid tokens={group.tokens} />
        </div>
      ))}
    </div>
  );
}

function ButtonRow({ variant }: { variant: (typeof VARIANTS)[number] }) {
  const isIcon = variant === "icon";
  const common = isIcon ? ({ variant, "aria-label": "Re-run" } as const) : ({ variant } as const);
  const body = isIcon ? <IconRefresh className="h-4 w-4" /> : "Action";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 shrink-0 font-mono text-xs text-(--text-muted)">{variant}</span>
      <Button {...common} size="md">
        {body}
      </Button>
      <Button {...common} size="sm">
        {body}
      </Button>
      <Button {...common} size="sm" disabled title="Nothing to do">
        {isIcon ? body : "Disabled"}
      </Button>
      {!isIcon && (
        <>
          <Button variant={variant} size="sm" href="#buttons">
            As a link
          </Button>
          <Button variant={variant} size="sm" href="#buttons" disabled title="Nothing to download yet">
            Disabled link
          </Button>
        </>
      )}
    </div>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] text-(--text-muted)">{label}</div>
      {children}
    </div>
  );
}

const noop = () => {};

export function Components() {
  const paneRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [charsPerLine, setCharsPerLine] = useState<number | null>(null);

  useEffect(() => {
    const measure = () => {
      const pane = paneRef.current;
      const probe = probeRef.current;
      if (!pane || !probe) return;
      const perChar = probe.getBoundingClientRect().width / PROSE.length;
      if (perChar > 0) setCharsPerLine(Math.round(pane.clientWidth / perChar));
    };
    measure();
    document.fonts.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div className="min-h-screen bg-(--bg-page) text-(--text-primary)">
      <div className="mx-auto max-w-6xl space-y-12 px-6 py-8">
        <header className="space-y-2">
          <h1 className="text-3xl">Component gallery</h1>
          <p className="text-sm text-(--text-secondary)">
            Every token and primitive on one screen — the token lists are read out of styles.css, so the page cannot
            drift from it. Static: it renders with the server down.{" "}
            <Link to="/" className="text-(--accent-text) hover:text-(--accent-text-hover)">
              Back to library
            </Link>
          </p>
        </header>

        <GallerySection id="reading" title="Reading surface">
          <p className="text-sm text-(--text-secondary)">
            Measured line length:{" "}
            <span className="font-mono text-(--text-primary)">
              {charsPerLine === null ? "measuring..." : `${charsPerLine} characters per line`}
            </span>{" "}
            <span className="text-(--text-faint)">(comfortable is 55-75; over 90 is a regression)</span>
          </p>
          <p className={READING_PANE}>
            <span ref={paneRef} className="block">
              {PROSE}
            </span>
            <span aria-hidden className="block h-0 overflow-hidden">
              <span ref={probeRef} className="inline-block whitespace-pre">
                {PROSE}
              </span>
            </span>
          </p>
        </GallerySection>

        <GallerySection id="buttons" title="Buttons">
          <p className="text-sm text-(--text-secondary)">
            Every variant at both sizes, resting and disabled, plus the link form. A disabled link renders as a
            real disabled button, because a disabled anchor still navigates.
          </p>
          <div className={`space-y-3 ${CARD}`}>
            {VARIANTS.map((variant) => (
              <ButtonRow key={variant} variant={variant} />
            ))}
            <div className="flex flex-wrap items-center gap-3 border-t border-(--border) pt-3">
              <span className="w-24 shrink-0 font-mono text-xs text-(--text-muted)">soft</span>
              {SOFT_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} soft size="sm">
                  {variant}
                </Button>
              ))}
              <span className="text-xs text-(--text-muted)">
                status colour without the weight of a fill — for a control that must warn, not shout
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-(--border) pt-3">
              <span className="w-24 shrink-0 font-mono text-xs text-(--text-muted)">square</span>
              <Button variant="icon" size="sm" aria-label="Refresh">
                <IconRefresh className="h-4 w-4" />
              </Button>
              {SOFT_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} soft square size="sm" aria-label={variant}>
                  <IconRefresh className="h-4 w-4" />
                </Button>
              ))}
              <span className="text-xs text-(--text-muted)">
                the variant="icon" box on any skin, so a coloured icon lines up in a row of plain ones
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-40 shrink-0 font-mono text-xs text-(--text-muted)">PillToggle</span>
              <PillToggle selected onClick={noop}>
                Selected
              </PillToggle>
              <PillToggle selected={false} onClick={noop}>
                Unselected
              </PillToggle>
              <PillToggle selected={false} onClick={noop} disabled>
                Disabled
              </PillToggle>
            </div>
          </div>
        </GallerySection>

        <GallerySection id="icons" title={`Icons (${ICONS.length})`}>
          <p className="text-sm text-(--text-secondary)">
            The whole set, read off components/icons.tsx. Nothing else in the app may draw an SVG or use an emoji —
            scripts/check-icons.mjs fails the build on either. Weight carries state: regular for idle, fill for active.
          </p>
          <div className={`flex flex-wrap gap-8 ${CARD}`}>
            {([["IconPlay", Icons.IconPlay], ["IconChat", Icons.IconChat], ["IconMicrophone", Icons.IconMicrophone]] as [string, IconComponent][]).map(
              ([name, Icon]) => (
                <div key={name} className="flex items-center gap-4">
                  <div className="flex flex-col items-center gap-1.5">
                    <Icon className="h-6 w-6 text-(--text-muted)" />
                    <span className="font-mono text-[10px] text-(--text-faint)">idle</span>
                  </div>
                  <div className="flex flex-col items-center gap-1.5">
                    <Icon weight="fill" className="h-6 w-6 text-(--accent-text)" />
                    <span className="font-mono text-[10px] text-(--text-faint)">active</span>
                  </div>
                  <span className="font-mono text-xs text-(--text-muted)">{name}</span>
                </div>
              ),
            )}
          </div>
          <IconGallery />
        </GallerySection>

        <GallerySection id="badges" title="StatusBadge">
          <div className={`flex flex-wrap gap-2 ${CARD}`}>
            {Object.keys(statusStyles).map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
            <StatusBadge status="synthesizing" chaptersCompleted={3} totalChapters={12} />
            <StatusBadge status="failed" error="Cancelled by user" />
          </div>
        </GallerySection>

        <GallerySection id="typography" title="Typography">
          <div className={`space-y-4 ${CARD}`}>
            <Specimen label="h1 — Fraunces, display">
              <h1 className="text-3xl">The queen of the golden bird</h1>
            </Specimen>
            <Specimen label="h2 — Fraunces, display">
              <h2 className="text-xl">The queen of the golden bird</h2>
            </Specimen>
            <Specimen label="font-reading — Source Serif 4">
              <p className="font-reading text-[17px] leading-relaxed">
                In olden times, when wishing still helped one, there lived a king whose daughters were all beautiful.
              </p>
            </Specimen>
            <Specimen label="sans — UI default">
              <p className="text-sm">
                In olden times, when wishing still helped one, there lived a king whose daughters were all beautiful.
              </p>
            </Specimen>
            <Specimen label="font-mono">
              <p className="font-mono text-xs">chapter_03.m4a — 00:14:22 — 3.1 MB</p>
            </Specimen>
          </div>
        </GallerySection>

        <GallerySection id="semantic" title={`Semantic tokens (${count(SEMANTIC)})`}>
          <TokenGroups groups={SEMANTIC} />
        </GallerySection>

        <GallerySection id="palette" title={`Palette (${count(PALETTE)})`}>
          <p className="text-sm text-(--text-secondary)">
            Raw colour. Never legal in a className — the semantic layer above is what components use.
          </p>
          <TokenGroups groups={PALETTE} />
        </GallerySection>

        <GallerySection id="ungrouped" title={`Ungrouped (${UNGROUPED.length})`}>
          <p className="text-sm text-(--text-secondary)">
            Declared in styles.css but claimed by no group above. A new token lands here rather than vanishing.
          </p>
          {UNGROUPED.length === 0 ? (
            <p className="text-sm text-(--text-faint)">None — every declared token has a home.</p>
          ) : (
            <TokenGrid tokens={UNGROUPED} />
          )}
        </GallerySection>
      </div>
    </div>
  );
}
