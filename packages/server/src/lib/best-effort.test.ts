import { afterEach, describe, expect, it, vi } from "vitest";
import { bestEffort } from "./best-effort.ts";

describe("bestEffort", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves and logs when the side write fails, so an unawaited caller never sees a rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(bestEffort("progress write", async () => { throw new Error("write CONNECT_TIMEOUT localhost:5433"); })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("progress write failed (ignored): write CONNECT_TIMEOUT localhost:5433");
  });

  it("runs the write when it succeeds", async () => {
    let ran = false;
    await bestEffort("x", async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
