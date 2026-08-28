import { Component, type ReactNode } from "react";

// A render error unmounts the whole tree, and what is left is a white page that says nothing —
// in the browser you can at least open the console, but in the desktop app there is no hint that
// a console exists. This keeps the failure on screen and makes it reportable.
//
// The issue it opens matches packages/desktop/src/crash.cjs, so a crash reported from the page and
// one reported from the shell arrive with the same label and the same shape.
const REPO = "https://github.com/subev/libratory";
const MAX_BODY = 4000;

type Props = { children: ReactNode };
type State = { error: Error | null };

function details(error: Error) {
  return [
    `Libratory — page crash`,
    `${location.pathname}${location.search}`,
    new Date().toISOString(),
    navigator.userAgent,
    "",
    error.stack || error.message,
  ].join("\n");
}

function issueUrl(error: Error) {
  const title = `Crash: ${(error.message || "render error").split("\n")[0].slice(0, 90)}`;
  const body = [
    "<!-- What were you doing when this happened? -->",
    "",
    "",
    "---",
    "```",
    details(error).slice(-MAX_BODY),
    "```",
  ].join("\n");
  return `${REPO}/issues/new?labels=crash&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// Production React replaces messages with a number, which is unreadable on its own but does have a
// page explaining it — so link it rather than leaving "#185" sitting there.
function decoded(error: Error) {
  const code = /Minified React error #(\d+)/.exec(error.message)?.[1];
  return code ? `https://react.dev/errors/${code}` : null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Page crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const help = decoded(error);

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
          <div className="mt-5 flex flex-wrap gap-2">
            <a
              href="/"
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              data-testid="crash-home"
            >
              Back to the library
            </a>
            <button
              onClick={() => location.reload()}
              className="rounded border border-(--border) px-4 py-2 text-sm text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"
            >
              Reload this page
            </button>
            <a
              href={issueUrl(error)}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-(--border) px-4 py-2 text-sm text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"
            >
              Report it
            </a>
            <button
              onClick={() => void navigator.clipboard.writeText(details(error))}
              className="rounded border border-(--border) px-4 py-2 text-sm text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"
            >
              Copy details
            </button>
          </div>

          <p className="mt-5 font-mono text-xs break-words text-red-600">{error.message}</p>
          {help && (
            <p className="mt-2 text-xs text-(--text-muted)">
              React shortens its messages in a release build.{" "}
              <a href={help} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800">
                What this one means
              </a>
            </p>
          )}

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-(--text-faint)">Technical details</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-(--bg-subtle) p-3 text-[11px] leading-relaxed text-(--text-muted)">
              {details(error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
