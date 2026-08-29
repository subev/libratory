import { Component, type ReactNode } from "react";
import { breadcrumbs } from "../lib/breadcrumbs.ts";
import { Button } from "./Button.tsx";

// A render error unmounts the whole tree, and what is left is a white page that says nothing —
// in the browser you can at least open the console, but in the desktop app there is no hint that
// a console exists. This keeps the failure on screen and makes it reportable.
//
// Inside the app it hands the report to the shell's own crash reporter, so a crash in the page is
// written to crash.log and offered the same dialog as a crash in the shell. In a browser there is
// no shell, so it falls back to opening the issue itself.
const REPO = "https://github.com/subev/libratory";
const MAX_BODY = 4000;

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string | null };

// A path is only true on the machine that wrote it, and an issue is public.
function redact(text: string) {
  return text.replace(/\/(?:Users|home)\/[^/\s"')]+/g, "~");
}

function details(error: Error, componentStack: string | null) {
  const recent = breadcrumbs();
  return [
    "Libratory — page crash",
    `${location.pathname}${location.search}`,
    new Date().toISOString(),
    navigator.userAgent,
    "",
    error.stack || error.message,
    componentStack ? `\ncomponent stack:${componentStack}` : "",
    recent ? `\nbefore it:\n${recent}` : "",
  ].join("\n");
}

function issueUrl(body: string, message: string) {
  const title = `Crash: ${redact((message || "render error").split("\n")[0] ?? "").slice(0, 90)}`;
  const filled = [
    "<!-- What were you doing when this happened? -->",
    "",
    "",
    "---",
    "```",
    redact(body).slice(-MAX_BODY),
    "```",
  ].join("\n");
  return `${REPO}/issues/new?labels=crash&title=${encodeURIComponent(title)}&body=${encodeURIComponent(filled)}`;
}

// Production React replaces messages with a number, which is unreadable on its own but does have a
// page explaining it — so link it rather than leaving "#185" sitting there.
function decoded(error: Error) {
  const code = /Minified React error #(\d+)/.exec(error.message)?.[1];
  return code ? `https://react.dev/errors/${code}` : null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error("Page crashed:", error, info.componentStack);
  }

  report = () => {
    const text = details(this.state.error!, this.state.componentStack);
    // The shell writes it to crash.log before offering the issue, so the evidence survives even if
    // the report is never sent. A browser has nowhere to write, so it goes straight to GitHub.
    if (window.setup?.report) window.setup.report(text);
    else window.open(issueUrl(text, this.state.error!.message), "_blank", "noreferrer");
  };

  override render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const help = decoded(error);
    const text = details(error, componentStack);

    return (
      <div className="min-h-screen bg-(--bg-page) px-4 py-16" data-testid="page-crash">
        <div className="mx-auto max-w-2xl rounded-xl border border-(--border) bg-(--bg-card) p-6">
          <h1 className="text-lg font-semibold text-(--text-primary)">This page stopped working</h1>
          <p className="mt-2 text-sm text-(--text-secondary)">
            Your library is safe — nothing was lost, and no book was changed. Something in the page
            itself failed to draw.
          </p>

          {/* Reloading lands on the same crash when the page is what broke, which is the usual case
              and the first thing anyone tries. Leaving is the action that actually works. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" href="/" data-testid="crash-home">
              Back to the library
            </Button>
            <Button onClick={() => location.reload()}>
              Reload this page
            </Button>
            <Button onClick={this.report} data-testid="crash-report">
              Report it
            </Button>
            <Button onClick={() => void navigator.clipboard.writeText(text)}>
              Copy details
            </Button>
          </div>

          <p className="mt-4 font-mono text-xs wrap-break-word text-(--danger-text)">{error.message}</p>
          {help && (
            <p className="mt-2 text-xs text-(--text-muted)">
              React shortens its messages in a release build.{" "}
              <a href={help} target="_blank" rel="noreferrer" className="text-(--accent-text) hover:text-(--accent-text-hover)">
                What this one means
              </a>
            </p>
          )}

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-(--text-faint)">
              Technical details — the error, the component tree, and what was logged before it
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-(--bg-subtle) p-3 text-[11px] leading-relaxed text-(--text-muted)">
              {text}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
