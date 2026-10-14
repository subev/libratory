import { describe, expect, it } from "vitest";
import { createThroughputMeter, estimateBookSynthesis, type QueuedSynthesis } from "./synthesis-eta.ts";

describe("throughput meter", () => {
  it("measures characters per second from chunks after each run's first", () => {
    const meter = createThroughputMeter();
    // 10-chunk chapter of 10,000 characters, a chunk every 10 s
    for (let chunk = 1; chunk <= 7; chunk++) meter.progress("chapter:a", chunk, 10, 10_000, chunk * 10_000);
    // Chunk 1 is the baseline at 10 s; chunks 2–7 produced 6,000 characters by 70 s
    expect(meter.rate(70_000)).toBeCloseTo(6_000 / 60);
  });

  it("ignores the burst of cached chunks a resumed run replays", () => {
    const meter = createThroughputMeter();
    for (let chunk = 1; chunk <= 50; chunk++) meter.progress("chapter:a", chunk, 100, 100_000, chunk);
    for (let chunk = 51; chunk <= 55; chunk++) meter.progress("chapter:a", chunk, 100, 100_000, 50 + (chunk - 50) * 10_000);
    // Only chunks 51–55 were spoken: 5,000 characters in the 50 s since the run started
    expect(meter.rate(50_050)).toBeCloseTo(5_000 / 50, 0);
  });

  it("adds concurrent chapters together", () => {
    const meter = createThroughputMeter();
    for (let step = 0; step <= 6; step++) {
      meter.progress("chapter:a", step + 1, 10, 10_000, step * 10_000);
      meter.progress("chapter:b", step + 1, 10, 10_000, step * 10_000 + 1);
    }
    expect(meter.rate(60_001)).toBeCloseTo(12_000 / 60, 0);
  });

  it("says nothing before enough has been measured, or after the pool went quiet", () => {
    const meter = createThroughputMeter();
    meter.progress("chapter:a", 1, 10, 10_000, 0);
    meter.progress("chapter:a", 2, 10, 10_000, 10_000);
    expect(meter.rate(10_000)).toBeNull();
    for (let chunk = 3; chunk <= 6; chunk++) meter.progress("chapter:a", chunk, 10, 10_000, (chunk - 1) * 10_000);
    expect(meter.rate(50_000)).not.toBeNull();
    expect(meter.rate(50_000 + 6 * 60_000)).toBeNull();
  });
});

describe("book estimate", () => {
  const item = (bookId: string, chars: number, id: number | null, extra: Partial<QueuedSynthesis> = {}): QueuedSynthesis => ({
    bookId, chars, progress: null, running: false, order: id === null ? null : [0, 0, id], ...extra,
  });

  it("waits for everything picked before the book's last chapter", () => {
    const queue = [
      item("other", 4_000, 1, { running: true, progress: "3/4" }),
      item("mine", 2_000, 2),
      item("other", 5_000, 3),
      item("mine", 3_000, 4),
      item("later", 9_000, 5),
    ];
    expect(estimateBookSynthesis(queue, "mine", 100)).toEqual({
      charsLeft: 5_000,
      charsAhead: 6_000,
      chaptersAhead: 2,
      charsPerSecond: 100,
      seconds: 110,
    });
  });

  it("puts running chapters first and chapters with no job yet last", () => {
    const queue = [item("mine", 1_000, null), item("other", 1_000, 7, { running: true }), item("mine", 1_000, 9)];
    expect(estimateBookSynthesis(queue, "mine", 10)?.seconds).toBe(300);
  });

  it("has no time without a rate, and no estimate for a book with nothing queued", () => {
    expect(estimateBookSynthesis([item("mine", 1_000, 1)], "mine", null)?.seconds).toBeNull();
    expect(estimateBookSynthesis([item("other", 1_000, 1)], "mine", 10)).toBeNull();
  });
});
