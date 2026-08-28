import { describe, it, expect } from "vitest";
import { describeDownload } from "./update-progress.ts";

describe("describeDownload", () => {
  it("reads the bytes rather than the reported percent", () => {
    // electron-updater's own percent has been seen to overshoot on a differential download's last
    // chunk; the byte counts are the ones that have to agree with what Finder will show.
    const { percent, label } = describeDownload({ percent: 103.4, transferred: 95e6, total: 190e6 });
    expect(percent).toBe(50);
    expect(label).toBe("50% — 95 MB of 190 MB");
  });

  it("never draws a bar past its end", () => {
    const { fraction, percent } = describeDownload({ percent: 120, transferred: 300e6, total: 190e6 });
    expect(fraction).toBe(1);
    expect(percent).toBe(100);
  });

  it("says less rather than NaN when the feed carries no size", () => {
    const { label, fraction } = describeDownload({ percent: 0, transferred: 12e6, total: 0 });
    expect(label).toBe("12 MB downloaded");
    expect(fraction).toBe(0);
  });
});
