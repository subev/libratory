import { describe, expect, it } from "vitest";
import { createPairingTokens, PAIRING_TTL_MS, pairLink } from "./pairing.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("pairing tokens", () => {
  it("is one use: peek never spends, spend answers once", () => {
    const tokens = createPairingTokens(clock().now);
    const { token } = tokens.mint("profile-a");
    expect(tokens.peek(token)).toMatchObject({ profileId: "profile-a" });
    expect(tokens.peek(token)).toMatchObject({ profileId: "profile-a" });
    expect(tokens.spend(token)).toEqual({ profileId: "profile-a" });
    expect(tokens.spend(token)).toBe("gone");
    expect(tokens.peek(token)).toBe("gone");
  });

  it("dies after ten minutes whether or not it was looked at", () => {
    const c = clock();
    const tokens = createPairingTokens(c.now);
    const { token, expiresAt } = tokens.mint("profile-a");
    expect(expiresAt.getTime()).toBe(c.now() + PAIRING_TTL_MS);
    c.advance(PAIRING_TTL_MS - 1);
    expect(tokens.peek(token)).toMatchObject({ profileId: "profile-a" });
    c.advance(1);
    expect(tokens.spend(token)).toBe("gone");
  });

  it("tells a token it never minted from one that is gone", () => {
    const tokens = createPairingTokens(clock().now);
    expect(tokens.peek("nope")).toBe("unknown");
    expect(tokens.spend("nope")).toBe("unknown");
  });

  it("mints distinct tokens bound to their own profile", () => {
    const tokens = createPairingTokens(clock().now);
    const a = tokens.mint("profile-a").token;
    const b = tokens.mint("profile-b").token;
    expect(a).not.toBe(b);
    expect(tokens.spend(b)).toEqual({ profileId: "profile-b" });
    expect(tokens.spend(a)).toEqual({ profileId: "profile-a" });
  });
});

describe("pairLink", () => {
  it("carries the server and the token in the fragment", () => {
    const link = pairLink("https://libratory.dev/pair", "http://mini.tail4a2f.ts.net:3034", "abc+/=");
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://libratory.dev/pair");
    expect(url.search).toBe("");
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get("s")).toBe("http://mini.tail4a2f.ts.net:3034");
    expect(params.get("t")).toBe("abc+/=");
    expect(params.getAll("a")).toEqual([]);
  });

  it("carries each fallback address as its own a, after s and before t", () => {
    const link = pairLink("https://libratory.dev/pair", "http://mini.tail4a2f.ts.net:3034", "tok", ["http://192.168.4.12:3034", "http://10.0.0.7:3034"]);
    const params = new URLSearchParams(new URL(link).hash.slice(1));
    expect(params.get("s")).toBe("http://mini.tail4a2f.ts.net:3034");
    expect(params.getAll("a")).toEqual(["http://192.168.4.12:3034", "http://10.0.0.7:3034"]);
    expect(params.get("t")).toBe("tok");
  });
});
