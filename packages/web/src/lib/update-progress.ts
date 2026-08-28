import type { UpdateProgress } from "./shell.ts";

// Decimal, because that is what Finder and the GitHub release page both say.
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

// Derived from the byte counts rather than electron-updater's own `percent`, which is a float that
// has been seen to overshoot 100 on the last chunk of a differential download.
export function describeDownload({ percent, transferred, total }: UpdateProgress) {
  const size = Number.isFinite(total) && total > 0 ? total : 0;
  const done = clamp(transferred, 0, size || Number.MAX_SAFE_INTEGER);
  const fraction = size ? clamp(done / size, 0, 1) : clamp(percent / 100, 0, 1);
  return {
    fraction,
    percent: Math.round(fraction * 100),
    // A feed without a size is rare but not impossible, and "NaN MB" is worse than saying less.
    label: size ? `${Math.round(fraction * 100)}% — ${mb(done)} of ${mb(size)}` : `${mb(done)} downloaded`,
  };
}
