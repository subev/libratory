// Worker and tRPC routes share one process (main.ts starts both), so a cancel
// route can abort an in-flight marker subprocess directly. Lost on dev-server
// restart — the extract worker's DB status guards are the fallback.
const controllers = new Map<string, AbortController>();

export function registerExtractAbort(key: string): AbortController {
  const controller = new AbortController();
  controllers.set(key, controller);
  return controller;
}

export function clearExtractAbort(key: string): void {
  controllers.delete(key);
}

export function abortExtract(key: string): boolean {
  const controller = controllers.get(key);
  if (!controller) return false;
  controller.abort();
  controllers.delete(key);
  return true;
}

export function extractRunning(keys: string[]): boolean {
  return keys.some((key) => controllers.has(key));
}
