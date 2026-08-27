// Safari 26 does not have Map.prototype.getOrInsertComputed yet, and pdf.js v6 calls it in the
// middle of rendering a page — every page arrived correctly sized, correctly cropped, and blank.
// Spec-shaped fill for the TC39 "upsert" pair; where the real methods exist it does nothing.
// Deliberately self-contained (no imports, no captures): PdfCanvas stringifies this function into
// the worker's bootstrap blob, because the worker bundle calls the method too.
export function installMapGetOrInsert(): void {
  for (const proto of [Map.prototype, WeakMap.prototype]) {
    const p = proto as unknown as Record<string, unknown>;
    if (typeof p.getOrInsert !== "function") {
      p.getOrInsert = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      };
    }
    if (typeof p.getOrInsertComputed !== "function") {
      p.getOrInsertComputed = function (this: Map<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      };
    }
  }
}

// pdf.js calls the method from its worker, which is its own realm — nothing the page installs
// reaches it. So where the pair is missing the worker entry becomes a blob that installs it and
// then imports the real worker, the same wrapper shape pdf.js uses for cross-origin workers.
// Everywhere else the real URL goes through untouched: the object URL has to outlive every worker
// pdf.js spawns and so is never revoked, which is a fair trade only on the browser that needs it.
// Patching this realm is part of the same call because the answer depends on asking first.
export function preparePdfWorker(workerUrl: string): string {
  const missing = typeof (Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed !== "function";
  installMapGetOrInsert();
  if (!missing) return workerUrl;
  const source = `(${installMapGetOrInsert.toString()})();\nawait import(${JSON.stringify(workerUrl)});`;
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}
