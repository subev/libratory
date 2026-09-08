// Per IP and per route, before multipart bodies or subprocesses are handled. Uploads keep a
// generous burst for folder imports. Rejections are explicit HTTP 429s; the app never retries.
export const UPLOAD_RATE_LIMIT = { max: 600, timeWindow: 60_000 };
export const SCRIPT_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
export const PREVIEW_RATE_LIMIT = { max: 120, timeWindow: 60_000 };
