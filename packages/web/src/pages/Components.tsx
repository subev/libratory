import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { PRIMARY_BUTTON, SECONDARY_BUTTON, DANGER_BUTTON, TOOLBAR_BUTTON } from "../lib/button-classes.ts";
import { StatusBadge, statusStyles } from "../components/StatusBadge.tsx";

type Token = { name: string; kind?: "text"; on?: string };
type Group = { title: string; tokens: Token[] };

const PALETTE: Group[] = [
  {
    title: "orange / ember",
    tokens: [
      "--pal-orange-300",
      "--pal-orange-400",
      "--pal-orange-500",
      "--pal-orange-550",
      "--pal-orange-600",
      "--pal-orange-700",
      "--pal-orange-800",
      "--pal-orange-a10",
      "--pal-orange-a12",
      "--pal-orange-a15",
      "--pal-ember-a14",
      "--pal-ember-a16",
      "--pal-ember-a20",
    ].map((name) => ({ name })),
  },
  {
    title: "brass",
    tokens: [
      "--pal-brass-300",
      "--pal-brass-400",
      "--pal-brass-500",
      "--pal-brass-700",
      "--pal-brass-a08",
      "--pal-brass-a10",
      "--pal-brass-a15",
      "--pal-brass-a35",
      "--pal-brass-a40",
    ].map((name) => ({ name })),
  },
  {
    title: "warm neutrals",
    tokens: [
      "--pal-neutral-0",
      "--pal-neutral-25",
      "--pal-neutral-50",
      "--pal-neutral-100",
      "--pal-neutral-150",
      "--pal-neutral-200",
      "--pal-neutral-300",
      "--pal-neutral-400",
      "--pal-neutral-500",
      "--pal-neutral-600",
      "--pal-neutral-650",
      "--pal-neutral-700",
      "--pal-neutral-800",
      "--pal-neutral-900",
      "--pal-neutral-950",
      "--pal-neutral-975",
      "--pal-neutral-990",
      "--pal-ink",
      "--pal-white",
      "--pal-terminal-hover",
    ].map((name) => ({ name })),
  },
  {
    title: "cream alphas",
    tokens: [
      "--pal-cream-a04",
      "--pal-cream-a06",
      "--pal-cream-a08",
      "--pal-cream-a12",
      "--pal-cream-a15",
      "--pal-cream-a25",
      "--pal-cream-a26",
      "--pal-cream-a42",
      "--pal-cream-a50",
      "--pal-cream-a62",
      "--pal-cream-a72",
      "--pal-cream-a82",
    ].map((name) => ({ name })),
  },
  {
    title: "red",
    tokens: [
      "--pal-red-400",
      "--pal-red-500",
      "--pal-red-600",
      "--pal-red-700",
      "--pal-red-800",
      "--pal-red-a10",
      "--pal-red-a20",
    ].map((name) => ({ name })),
  },
  {
    title: "green",
    tokens: [
      "--pal-green-400",
      "--pal-green-450",
      "--pal-green-500",
      "--pal-green-600",
      "--pal-green-700",
      "--pal-green-750",
      "--pal-green-a12",
      "--pal-green-a18",
    ].map((name) => ({ name })),
  },
  {
    title: "categorical badge hues",
    tokens: [
      "--pal-gold-300",
      "--pal-gold-700",
      "--pal-gold-a20",
      "--pal-gold-a22",
      "--pal-blue-300",
      "--pal-blue-700",
      "--pal-blue-a18",
      "--pal-blue-a20",
      "--pal-brown-300",
      "--pal-brown-700",
      "--pal-brown-a18",
      "--pal-brown-a24",
    ].map((name) => ({ name })),
  },
];

const SEMANTIC: Group[] = [
  {
    title: "surfaces",
    tokens: [
      { name: "--bg-page" },
      { name: "--bg-card" },
      { name: "--bg-card-hover" },
      { name: "--bg-subtle" },
      { name: "--bg-input" },
      { name: "--bg-drag" },
      { name: "--bg-selected" },
    ],
  },
  {
    title: "lines",
    tokens: [{ name: "--border" }, { name: "--border-input" }, { name: "--divide" }, { name: "--focus-ring" }],
  },
  {
    title: "text",
    tokens: [
      { name: "--text-primary", kind: "text" },
      { name: "--text-secondary", kind: "text" },
      { name: "--text-tertiary", kind: "text" },
      { name: "--text-muted", kind: "text" },
      { name: "--text-faint", kind: "text" },
    ],
  },
  {
    title: "accent",
    tokens: [
      { name: "--accent" },
      { name: "--accent-hover" },
      { name: "--accent-subtle" },
      { name: "--accent-text", kind: "text" },
      { name: "--accent-text-hover", kind: "text" },
      { name: "--on-accent", kind: "text", on: "--accent" },
    ],
  },
  {
    title: "status",
    tokens: [
      { name: "--danger" },
      { name: "--danger-hover" },
      { name: "--danger-bg" },
      { name: "--danger-text", kind: "text" },
      { name: "--on-danger", kind: "text", on: "--danger" },
      { name: "--success" },
      { name: "--success-hover" },
      { name: "--success-bg" },
      { name: "--success-text", kind: "text" },
      { name: "--on-success", kind: "text", on: "--success" },
      { name: "--warning" },
      { name: "--warning-hover" },
      { name: "--warning-bg" },
      { name: "--warning-text", kind: "text" },
      { name: "--on-warning", kind: "text", on: "--warning" },
      { name: "--step-input" },
      { name: "--step-work" },
      { name: "--step-output" },
    ],
  },
  {
    title: "badges",
    tokens: [
      { name: "--badge-pending-bg" },
      { name: "--badge-pending-text", kind: "text", on: "--badge-pending-bg" },
      { name: "--badge-extracting-bg" },
      { name: "--badge-extracting-text", kind: "text", on: "--badge-extracting-bg" },
      { name: "--badge-synthesizing-bg" },
      { name: "--badge-synthesizing-text", kind: "text", on: "--badge-synthesizing-bg" },
      { name: "--badge-normalizing-bg" },
      { name: "--badge-normalizing-text", kind: "text", on: "--badge-normalizing-bg" },
      { name: "--badge-assembling-bg" },
      { name: "--badge-assembling-text", kind: "text", on: "--badge-assembling-bg" },
      { name: "--badge-done-bg" },
      { name: "--badge-done-text", kind: "text", on: "--badge-done-bg" },
      { name: "--badge-failed-bg" },
      { name: "--badge-failed-text", kind: "text", on: "--badge-failed-bg" },
      { name: "--badge-suspended-bg" },
      { name: "--badge-suspended-text", kind: "text", on: "--badge-suspended-bg" },
      { name: "--badge-cancelled-bg" },
      { name: "--badge-cancelled-text", kind: "text", on: "--badge-cancelled-bg" },
    ],
  },
  {
    title: "terminal",
    tokens: [
      { name: "--bg-terminal" },
      { name: "--bg-terminal-hover" },
      { name: "--terminal-border" },
      { name: "--terminal-text", kind: "text", on: "--bg-terminal" },
      { name: "--terminal-dim", kind: "text", on: "--bg-terminal" },
    ],
  },
  {
    title: "reading",
    tokens: [
      { name: "--bg-reading" },
      { name: "--border-reading" },
      { name: "--bg-custom-text" },
      { name: "--border-custom-text" },
    ],
  },
];

const PROSE =
  "Hard by a great forest dwelt a poor wood-cutter with his wife and his two children. The boy was called Hansel and the girl Gretel. He had little to bite and to break, and once when great dearth fell on the land, he could no longer procure even daily bread. Now when he thought over this by night in his bed, and tossed about in his anxiety, he groaned and said to his wife: what is to become of us? How are we to feed our poor children, when we no longer have anything even for ourselves?";

const READING_PANE =
  "mx-auto w-full max-w-prose rounded bg-(--bg-reading) border border-(--border-reading) px-7 py-6 font-reading text-[17px] leading-relaxed text-(--text-primary)";

// Lint bans --pal-* in classNames and Tailwind cannot build a class from a variable, so swatch fills go through inline style.
function Swatch({ token }: { token: Token }) {
  const label = <span className="block truncate font-mono text-[10px] text-(--text-muted)">{token.name}</span>;
  if (token.kind === "text") {
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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="space-y-4">
      <h2 className="text-xl text-(--text-primary)">{title}</h2>
      {children}
    </section>
  );
}

function TokenGroups({ groups }: { groups: Group[] }) {
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.title}>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-(--text-faint)">{group.title}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {group.tokens.map((token) => (
              <Swatch key={token.name} token={token} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ButtonRow({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 font-mono text-xs text-(--text-muted)">{name}</span>
      <button type="button" className={className}>
        Resting
      </button>
      <button type="button" className={className} disabled>
        Disabled
      </button>
    </div>
  );
}

export function Components() {
  const paneRef = useRef<HTMLParagraphElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [charsPerLine, setCharsPerLine] = useState<number | null>(null);

  useEffect(() => {
    const measure = () => {
      const pane = paneRef.current;
      const probe = probeRef.current;
      if (!pane || !probe) return;
      const style = window.getComputedStyle(pane);
      const content = pane.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const perChar = probe.getBoundingClientRect().width / PROSE.length;
      if (perChar > 0) setCharsPerLine(Math.round(content / perChar));
    };
    measure();
    document.fonts.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div className="min-h-screen bg-(--bg-page) text-(--text-primary)">
      <div className="mx-auto max-w-6xl space-y-12 px-6 py-10">
        <header className="space-y-2">
          <h1 className="text-3xl">Component gallery</h1>
          <p className="text-sm text-(--text-secondary)">
            Every token and primitive on one screen. Static — it renders with the server down.{" "}
            <Link to="/" className="text-(--accent-text) hover:text-(--accent-text-hover)">
              Back to library
            </Link>
          </p>
        </header>

        <Section id="reading" title="Reading surface">
          <p className="text-sm text-(--text-secondary)">
            Measured line length:{" "}
            <span className="font-mono text-(--text-primary)">
              {charsPerLine === null ? "measuring..." : `${charsPerLine} characters per line`}
            </span>{" "}
            <span className="text-(--text-faint)">(comfortable is 55-75; over 90 is a regression)</span>
          </p>
          <p ref={paneRef} className={READING_PANE}>
            {PROSE}
            <span aria-hidden className="block h-0 overflow-hidden">
              <span ref={probeRef} className="inline-block whitespace-pre">
                {PROSE}
              </span>
            </span>
          </p>
        </Section>

        <Section id="buttons" title="Buttons">
          <div className="space-y-3 rounded-lg border border-(--border) bg-(--bg-card) p-5">
            <ButtonRow name="PRIMARY_BUTTON" className={PRIMARY_BUTTON} />
            <ButtonRow name="SECONDARY_BUTTON" className={SECONDARY_BUTTON} />
            <ButtonRow name="DANGER_BUTTON" className={DANGER_BUTTON} />
            <ButtonRow name="TOOLBAR_BUTTON" className={TOOLBAR_BUTTON} />
          </div>
        </Section>

        <Section id="badges" title="StatusBadge">
          <div className="flex flex-wrap gap-2 rounded-lg border border-(--border) bg-(--bg-card) p-5">
            {Object.keys(statusStyles).map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
            <StatusBadge status="synthesizing" chaptersCompleted={3} totalChapters={12} />
            <StatusBadge status="failed" error="Cancelled by user" />
          </div>
        </Section>

        <Section id="typography" title="Typography">
          <div className="space-y-4 rounded-lg border border-(--border) bg-(--bg-card) p-5">
            <div>
              <div className="mb-1 font-mono text-[10px] text-(--text-muted)">h1 — Fraunces, display</div>
              <h1 className="text-3xl">The queen of the golden bird</h1>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] text-(--text-muted)">h2 — Fraunces, display</div>
              <h2 className="text-xl">The queen of the golden bird</h2>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] text-(--text-muted)">font-reading — Source Serif 4</div>
              <p className="font-reading text-[17px] leading-relaxed">
                In olden times, when wishing still helped one, there lived a king whose daughters were all beautiful.
              </p>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] text-(--text-muted)">sans — UI default</div>
              <p className="text-sm">
                In olden times, when wishing still helped one, there lived a king whose daughters were all beautiful.
              </p>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] text-(--text-muted)">font-mono</div>
              <p className="font-mono text-xs">chapter_03.m4a — 00:14:22 — 3.1 MB</p>
            </div>
          </div>
        </Section>

        <Section id="semantic" title={`Semantic tokens (${SEMANTIC.reduce((n, g) => n + g.tokens.length, 0)})`}>
          <TokenGroups groups={SEMANTIC} />
        </Section>

        <Section id="palette" title={`Palette (${PALETTE.reduce((n, g) => n + g.tokens.length, 0)})`}>
          <p className="text-sm text-(--text-secondary)">
            Raw colour. Never legal in a className — the semantic layer above is what components use.
          </p>
          <TokenGroups groups={PALETTE} />
        </Section>
      </div>
    </div>
  );
}
