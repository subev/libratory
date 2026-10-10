// Per IP and per route, before multipart bodies or subprocesses are handled. Uploads keep a
// generous burst for folder imports. Rejections are explicit HTTP 429s; the app never retries.
export const UPLOAD_RATE_LIMIT = { max: 600, timeWindow: 60_000 };
export const SCRIPT_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
export const PREVIEW_RATE_LIMIT = { max: 120, timeWindow: 60_000 };
// A pairing token is 24 random bytes; the limit is against a phone stuck in a retry loop, not a guess
export const PAIR_RATE_LIMIT = { max: 60, timeWindow: 60_000 };
