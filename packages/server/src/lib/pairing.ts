import { randomBytes } from "node:crypto";

// A pairing token is the whole handshake: the Phone page mints one for the profile it is on, the
// QR carries it to the phone, and POST /shelf/pair trades it for a device key. Ten minutes and one
// use, and bound to the profile it was minted in, so a code photographed off a screen is worth
// nothing a moment later. In memory like the extract registry — a restart invalidating a code that
// was on screen costs one re-scan, and the page mints a fresh one on every load anyway.

export const PAIRING_TTL_MS = 10 * 60_000;

type Token = { profileId: string; expiresAt: number; spent: boolean };

export type PairingTokens = {
  mint(profileId: string): { token: string; expiresAt: Date };
  // What the phone shows before the person taps Add: the profile, or why the code is no good
  peek(token: string): { profileId: string; expiresAt: Date } | "unknown" | "gone";
  spend(token: string): { profileId: string } | "unknown" | "gone";
};

export function createPairingTokens(now: () => number = Date.now): PairingTokens {
  const tokens = new Map<string, Token>();

  const sweep = () => {
    const t = now();
    for (const [token, entry] of tokens) {
      if (entry.spent || entry.expiresAt <= t) tokens.delete(token);
    }
  };

  const lookup = (token: string): Token | "unknown" | "gone" => {
    const entry = tokens.get(token);
    if (!entry) return "unknown";
    if (entry.spent || entry.expiresAt <= now()) return "gone";
    return entry;
  };

  return {
    mint(profileId) {
      sweep();
      const token = randomBytes(24).toString("base64url");
      const expiresAt = now() + PAIRING_TTL_MS;
      tokens.set(token, { profileId, expiresAt, spent: false });
      return { token, expiresAt: new Date(expiresAt) };
    },
    peek(token) {
      const entry = lookup(token);
      if (typeof entry === "string") return entry;
      return { profileId: entry.profileId, expiresAt: new Date(entry.expiresAt) };
    },
    spend(token) {
      const entry = lookup(token);
      if (typeof entry === "string") return entry;
      entry.spent = true;
      return { profileId: entry.profileId };
    },
  };
}

export const pairingTokens = createPairingTokens();

// The fragment keeps the token out of the site's logs: a universal link hands the whole URL to the
// app, and a fallback page on the site can read it client-side.
// `s` is the address to try first; each `a` is one to try when it does not answer — the LAN
// address for a device on the same Wi-Fi but not on the tailnet. A reader that knows only `s`
// still pairs the way it did.
export function pairLink(base: string, serverOrigin: string, token: string, alternatives: string[] = []): string {
  const params = new URLSearchParams({ s: serverOrigin });
  for (const origin of alternatives) params.append("a", origin);
  params.set("t", token);
  return `${base}#${params.toString()}`;
}
