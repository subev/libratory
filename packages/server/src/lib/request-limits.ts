// Per IP and per route, before multipart bodies or subprocesses are handled. Uploads keep a
// generous burst for folder imports. Rejections are explicit HTTP 429s; the app never retries.
export const UPLOAD_RATE_LIMIT = { max: 600, timeWindow: 60_000 };
export const SCRIPT_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
export const PREVIEW_RATE_LIMIT = { max: 120, timeWindow: 60_000 };
// A pairing token is 24 random bytes; the limit is against a phone stuck in a retry loop, not a guess
export const PAIR_RATE_LIMIT = { max: 60, timeWindow: 60_000 };
// A public shelf answers the world: a listing a second is a reader stuck in a loop, not a person
export const SHELF_RATE_LIMIT = { max: 120, timeWindow: 60_000 };

// Whose bucket a request counts against. Behind a proxy every socket is the proxy's, and one busy
// reader would 429 the world, so a server with a public origin keys on the client address the
// proxy reports; a server reached directly trusts no such header, as the guard does not.
export function clientKey(headers: Record<string, string | string[] | undefined>, socketAddress: string, proxied: boolean): string {
  if (!proxied) return socketAddress;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  return first(headers["cf-connecting-ip"]) || first(headers["x-forwarded-for"]) || socketAddress;
}
