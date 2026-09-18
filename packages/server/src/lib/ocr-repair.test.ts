import { NoOutputGeneratedError } from "ai";
import { expect, it, vi } from "vitest";
import { createRepairBudget, validatedStage, type StageEvidence } from "./ocr-repair.ts";

const signal = new AbortController().signal;
const validate = (output: unknown) => { if (output !== "valid") throw new Error("Missing line 22"); return output; };
const rejected: StageEvidence = { response: '"missing"', output: "missing", message: "Missing line 22", inputTokens: 12, outputTokens: 4, repair: false };

it("repairs a saved rejection directly with its evidence instead of buying another initial attempt", async () => {
  const request = vi.fn(async (_hint: string) => ({ output: "valid", usage: { inputTokens: 7, outputTokens: 3 } }));
  const record = vi.fn();
  const budget = createRepairBudget(1);
  const result = await validatedStage({ stage: "ordering", signal, budget, validate, request,
    checkpoint: { load: async () => null, save: vi.fn(), loadRejected: async () => rejected, record },
  });
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[0]).toContain("Missing line 22");
  expect(request.mock.calls[0]?.[0]).toContain('"missing"');
  expect(budget.used).toBe(1);
  expect(result).toMatchObject({ value: "valid", inputTokens: 7, outputTokens: 3 });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ repair: true, inputTokens: 7 }));
});

it("revalidates saved text locally, including a JSON fence, without spending the repair budget", async () => {
  const request = vi.fn();
  const save = vi.fn();
  const budget = createRepairBudget(0);
  const result = await validatedStage({ stage: "transcription", signal, budget, validate, request,
    checkpoint: { load: async () => null, save, loadRejected: async () => ({ ...rejected, output: undefined, response: '```json\n"valid"\n```' }) },
  });
  expect(result.value).toBe("valid");
  expect(save).toHaveBeenCalledWith("valid");
  expect(request).not.toHaveBeenCalled();
  expect(budget.used).toBe(0);
});

it("limits repair across concurrently processed pages and never retries a failed repair", async () => {
  const budget = createRepairBudget(2);
  const request = vi.fn(async () => ({ output: "still missing", usage: {} }));
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => validatedStage({ stage: "ordering", signal, budget, request, validate,
    checkpoint: { load: async () => null, save: vi.fn(), loadRejected: async () => rejected },
  })));
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(budget.used).toBe(2);
});

it("does not retry provider failures and records unknown usage without inventing a zero charge", async () => {
  const budget = createRepairBudget(10);
  const request = vi.fn(async () => { throw new Error("Connection timeout"); });
  const record = vi.fn();
  await expect(validatedStage({ stage: "transcription", signal, budget, request, validate,
    checkpoint: { load: async () => null, save: vi.fn(), record },
  })).rejects.toThrow("Connection timeout");
  expect(request).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: null, outputTokens: null, repair: false }));
  expect(budget.used).toBe(0);
});

it("does not turn a checkpoint write failure or cancellation into a paid repair", async () => {
  const request = vi.fn();
  const budget = createRepairBudget(10);
  await expect(validatedStage({ stage: "ordering", signal, budget, request, validate,
    checkpoint: { load: async () => "valid", save: async () => { throw new Error("Disk full"); } },
  })).rejects.toThrow("Disk full");
  await expect(validatedStage({ stage: "ordering", signal: AbortSignal.abort(), budget, request, validate })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(budget.used).toBe(0);
});

it("checks older compatible responses before paying to repair the latest rejection", async () => {
  const request = vi.fn();
  const save = vi.fn();
  const result = await validatedStage({ stage: "ordering", signal, budget: createRepairBudget(0), request, validate,
    checkpoint: { load: async () => null, save, loadCandidates: async () => [rejected,
      { ...rejected, output: "valid", response: '"valid"' }] },
  });
  expect(result.value).toBe("valid");
  expect(save).toHaveBeenCalledWith("valid");
  expect(request).not.toHaveBeenCalled();
});


it("records raw text and usage when the SDK structured-output accessor throws", async () => {
  const record = vi.fn();
  const request = vi.fn(async () => ({ get output(): unknown { throw new NoOutputGeneratedError(); },
    text: "", usage: { inputTokens: 100, outputTokens: 8192 } }));
  await expect(validatedStage({ stage: "ordering", signal, budget: createRepairBudget(0), request, validate,
    checkpoint: { load: async () => null, save: vi.fn(), record },
  })).rejects.toMatchObject({ inputTokens: 100, outputTokens: 8192, response: "" });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ response: "", inputTokens: 100, outputTokens: 8192 }));
  expect(request).toHaveBeenCalledOnce();
});

it("tries older evidence when the main checkpoint fails current validation", async () => {
  const request = vi.fn();
  const loadCandidates = vi.fn(async () => [{ ...rejected, output:"valid", response:'"valid"' }]);
  const result = await validatedStage({stage:"ordering",signal,budget:createRepairBudget(0),request,validate,
    checkpoint:{load:async()=>"invalid",save:vi.fn(),loadCandidates}});
  expect(result.value).toBe("valid");
  expect(loadCandidates).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});
it("does not read older evidence after a valid main checkpoint", async () => {
  const loadCandidates = vi.fn();
  await validatedStage({stage:"ordering",signal,request:vi.fn(),validate,
    checkpoint:{load:async()=>"valid",save:vi.fn(),loadCandidates}});
  expect(loadCandidates).not.toHaveBeenCalled();
});
