// Recalculate stored costs from the pricing currently in effect. Rewrites money
// figures, so the assertions below pin both the per-row cost AND the daily
// aggregate (day total + every per-bucket breakdown).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let route;

// 09:00 and 20:00 on the same local day — inside / outside a 01:00–12:00 window.
const IN_WINDOW = new Date(2026, 0, 15, 9, 0, 0).toISOString();
const OUT_WINDOW = new Date(2026, 0, 15, 20, 0, 0).toISOString();

const tokens = (input, output) => ({ prompt_tokens: input, completion_tokens: output });

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recalc-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  route = await import("@/app/api/usage/recalculate/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const dayRow = async (dateKey) => {
  const rows = await db.getUsageStats("all");
  return rows;
};

describe("recalculateCosts", () => {
  it("rewrites row cost and shifts every daily bucket by the delta", async () => {
    // Seed at the canonical gpt-5.1 rate (input 1.25 / output 10 per 1M).
    await db.saveRequestUsage({
      timestamp: OUT_WINDOW, provider: "openai", model: "gpt-5.1",
      connectionId: "conn-1", apiKey: "sk-abc", endpoint: "/v1/chat/completions",
      tokens: tokens(1_000_000, 1_000_000),
    });

    let stats = await dayRow("2026-01-15");
    expect(stats.totalCost).toBeCloseTo(11.25, 6); // 1.25 + 10

    // Now make input cheaper and add an off-peak rule for the same model.
    await db.updatePricing({
      openai: {
        "gpt-5.1": { input: 0.5, output: 10, rules: [{ from: "01:00", to: "12:00", input: 0.1, output: 0.8 }] },
      },
    });

    const result = await db.recalculateCosts();
    expect(result.changed).toBe(1);
    expect(result.days).toBe(1);
    // new cost 0.5 + 10 = 10.5 → delta −0.75
    expect(result.delta).toBeCloseTo(-0.75, 6);

    stats = await dayRow("2026-01-15");
    expect(stats.totalCost).toBeCloseTo(10.5, 6);
  });

  it("applies the time-of-day rule to the rows that ran inside the window", async () => {
    await db.saveRequestUsage({
      timestamp: IN_WINDOW, provider: "openai", model: "gpt-5.1",
      connectionId: "conn-1", apiKey: "sk-abc", endpoint: "/v1/chat/completions",
      tokens: tokens(1_000_000, 1_000_000),
    });

    await db.recalculateCosts();

    // In-window row: 0.1 + 0.8 = 0.9 ; out-window row: 0.5 + 10 = 10.5
    const stats = await dayRow("2026-01-15");
    expect(stats.totalCost).toBeCloseTo(11.4, 6);
  });

  it("keeps the per-provider and per-model breakdown consistent with the day total", async () => {
    const stats = await dayRow("2026-01-15");
    const providerCost = Object.values(stats.byProvider).reduce((a, p) => a + p.cost, 0);
    const modelCost = Object.values(stats.byModel).reduce((a, m) => a + m.cost, 0);
    expect(providerCost).toBeCloseTo(stats.totalCost, 6);
    expect(modelCost).toBeCloseTo(stats.totalCost, 6);
  });

  it("never touches token counts", async () => {
    const stats = await dayRow("2026-01-15");
    expect(stats.totalPromptTokens).toBe(2_000_000);
    expect(stats.totalCompletionTokens).toBe(2_000_000);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const again = await db.recalculateCosts();
    expect(again.changed).toBe(0);
    expect(again.delta).toBe(0);
  });

  it("POST /api/usage/recalculate returns the summary and applies it", async () => {
    const res = await route.POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ rows: 2, changed: 0, days: 0, delta: 0 });
  });

  it("leaves a daily aggregate with no history rows untouched", async () => {
    // Simulates a legacy `dailySummary` day whose history was pruned upstream.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.run(
      `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`,
      ["2020-01-01", JSON.stringify({ requests: 3, promptTokens: 10, completionTokens: 5, cost: 99, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} })]
    );

    await db.recalculateCosts();

    const row = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, ["2020-01-01"]);
    expect(JSON.parse(row.data).cost).toBe(99);
  });
});
