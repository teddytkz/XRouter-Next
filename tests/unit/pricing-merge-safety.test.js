// Regression guard for the money-path defects: a rate must never be undefined
// (NaN cost), recalc must never zero an unpriceable row, and the daily bucket
// identity (day.cost == Σ buckets) must survive a downward recalc.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const tokens = (input, output) => ({ prompt_tokens: input, completion_tokens: output });
const STAMP = new Date(2026, 0, 15, 20, 0, 0).toISOString();

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-safety-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("override merge never leaves a rate undefined", () => {
  it("fills missing rate fields with 0 when there is no base entry either", async () => {
    // A model the pricing tables do not know at all, with a partial override.
    await db.updatePricing({ madeup: { "mystery-model": { input: 2 } } });
    const resolved = await db.getPricingForModel("madeup", "mystery-model");
    for (const field of ["input", "output", "cached", "reasoning", "cache_creation"]) {
      expect(typeof resolved[field]).toBe("number");
    }
    expect(resolved.input).toBe(2);

    // And the resulting cost is a finite number, not NaN.
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    const cost = calculateCostFromTokens(tokens(1_000_000, 1_000_000), resolved, new Date(STAMP));
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeCloseTo(2, 6);
  });

  it("keeps an explicit 0 cached rate instead of falling back to the input rate", async () => {
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    const pricing = { input: 3, output: 15, cached: 0, reasoning: 0, cache_creation: 0 };
    const cost = calculateCostFromTokens(
      { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 100 },
      pricing
    );
    expect(cost).toBe(0);
  });

  it("preserves the base schedule when the override omits rules", async () => {
    await db.updatePricing({ deepseek: { "deepseek-v4-pro": { input: 0.5 } } });
    const resolved = await db.getPricingForModel("deepseek", "deepseek-v4-pro");
    expect(resolved.rules).toHaveLength(2);
    await db.resetPricing("deepseek", "deepseek-v4-pro");
  });
});

describe("recalculateCosts never erases spend it cannot price", () => {
  it("skips rows whose model has no pricing and reports the count", async () => {
    // Unpriceable model (no table entry) with a real stored cost.
    await db.saveRequestUsage({
      timestamp: STAMP, provider: "ghostvendor", model: "ghost-model",
      tokens: tokens(1_000_000, 1_000_000),
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.run(`UPDATE usageHistory SET cost = 7.5 WHERE model = 'ghost-model'`);

    const result = await db.recalculateCosts();
    expect(result.skipped).toBe(1);
    expect(result.changed).toBe(0);

    const row = adapter.get(`SELECT cost FROM usageHistory WHERE model = 'ghost-model'`);
    expect(row.cost).toBe(7.5); // untouched, not zeroed
  });

  it("keeps day.cost equal to the sum of its buckets after a downward recalc", async () => {
    // Two priced rows on one day at the full gpt-5.1 rate (1.25 / 10 per 1M).
    for (let i = 0; i < 2; i++) {
      await db.saveRequestUsage({
        timestamp: STAMP, provider: "openai", model: "gpt-5.1",
        connectionId: "conn-1", apiKey: "sk-abc", endpoint: "/v1/chat/completions",
        tokens: tokens(1_000_000, 1_000_000),
      });
    }

    // Halve the rate so the day's cost drops.
    await db.updatePricing({ openai: { "gpt-5.1": { input: 0.625, output: 5 } } });
    const result = await db.recalculateCosts();
    expect(result.delta).toBeLessThan(0);

    const stats = await db.getUsageStats("all");
    const bucketSum = Object.values(stats.byProvider).reduce((a, p) => a + p.cost, 0);
    expect(bucketSum).toBeCloseTo(stats.totalCost, 9);
    expect(stats.totalCost).toBeGreaterThan(0);
  });
});
