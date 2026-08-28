// What happened just before a crash, kept so a report carries it. The error React catches is
// usually the least informative line on the screen: the loop that produced "Minified React error
// #185" was only identifiable from the failed tRPC request logged above it.
//
// Failed requests are the reason this wraps fetch rather than only console: a browser prints
// "POST /trpc/… 404" from its network stack, not through console.error, so patching the console
// alone would miss exactly the line worth having.
const MAX_ENTRIES = 40;
const MAX_LEN = 300;

const entries: string[] = [];

function push(kind: string, text: string) {
  entries.push(`${new Date().toISOString().slice(11, 23)}  ${kind}  ${text.slice(0, MAX_LEN)}`);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function breadcrumbs(): string {
  return entries.join("\n");
}

let installed = false;

// Tests only: the buffer and the patches are process-wide, so each case starts from nothing.
export function resetBreadcrumbs() {
  entries.length = 0;
  installed = false;
}

export function installBreadcrumbs() {
  if (installed) return; // HMR re-runs this module, and a second patch would log every line twice
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args.map(describe).join(" "));
      original(...args);
    };
  }

  // Errors thrown outside render never reach an error boundary — an event handler, a timer, a
  // rejected promise. They leave the page working and the failure invisible, so record them here.
  window.addEventListener("error", (event) => {
    push("uncaught", `${event.message} (${event.filename}:${event.lineno})`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    push("rejected", describe(event.reason));
  });

  const original = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const started = performance.now();
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    try {
      const response = await original(...args);
      // The body is never read here — a streamed tRPC response must reach its caller untouched.
      if (!response.ok) push("http", `${response.status} ${url} (${Math.round(performance.now() - started)}ms)`);
      return response;
    } catch (err) {
      push("http", `failed ${url} — ${describe(err)}`);
      throw err;
    }
  };
}
