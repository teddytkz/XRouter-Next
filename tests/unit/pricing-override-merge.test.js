// Per-model pricing overrides: a user override may be partial (only `input`, or
// only `rules`), so it must be merged OVER the resolved base rates — returning it
// raw left the other fields undefined and turned the computed cost into NaN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const URL_BASE = "http://localhost/api/pricing";
let tempDir;
let db;
let route;

const req = (url, body) => ({ url, json: async () => body });

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-merge-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  route = await import("@/app/api/pricing/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("pricing override merge", () => {
  it("keeps base rates for fields the override omits", async () => {
    // gpt-5.1 has a canonical MODEL_PRICING entry (input 1.25 / output 10).
    await db.updatePricing({ openai: { "gpt-5.1": { input: 0.1 } } });

    const resolved = await db.getPricingForModel("openai", "gpt-5.1");
    expect(resolved.input).toBe(0.1);      // override wins
    expect(resolved.output).toBe(10);      // base preserved, not undefined
    expect(resolved.cached).toBeDefined();
  });

  it("returns base rates when there is no override", async () => {
    const resolved = await db.getPricingForModel("openai", "gpt-5-mini");
    expect(resolved.input).toBe(0.25);
    expect(resolved.output).toBe(2);
  });

  it("carries time-of-day rules through the override", async () => {
    await db.updatePricing({
      openai: { "gpt-5.1": { input: 1.25, output: 10, rules: [{ from: "01:00", to: "12:00", input: 0.1 }] } },
    });
    const resolved = await db.getPricingForModel("openai", "gpt-5.1");
    expect(resolved.rules).toHaveLength(1);

    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    const tokens = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    expect(calculateCostFromTokens(tokens, resolved, new Date(2026, 0, 15, 9))).toBeCloseTo(0.1, 6);
    expect(calculateCostFromTokens(tokens, resolved, new Date(2026, 0, 15, 20))).toBeCloseTo(1.25, 6);
  });

  it("reset removes the override and restores the base rate", async () => {
    await db.resetPricing("openai", "gpt-5.1");
    const resolved = await db.getPricingForModel("openai", "gpt-5.1");
    expect(resolved.input).toBe(1.25);
  });
});

describe("/api/pricing route", () => {
  it("GET ?provider&model resolves the rates the editor pre-fills", async () => {
    const data = await (await route.GET(req(`${URL_BASE}?provider=openai&model=gpt-5.1`))).json();
    expect(data.pricing.input).toBe(1.25);
  });

  it("PATCH accepts a time rule and GET reflects it", async () => {
    const res = await route.PATCH(req(URL_BASE, {
      openai: { "gpt-5.1": { input: 0.1, output: 0.8, rules: [{ from: "01:00", to: "12:00", input: 0.01 }] } },
    }));
    expect(res.status).toBe(200);

    const got = await (await route.GET(req(`${URL_BASE}?provider=openai&model=gpt-5.1`))).json();
    expect(got.pricing.rules[0].from).toBe("01:00");
    expect(got.pricing.cached).toBe(0.625); // base field survived the partial override
  });

  it("PATCH rejects a malformed time window", async () => {
    const res = await route.PATCH(req(URL_BASE, {
      openai: { "gpt-5.1": { input: 1, output: 1, rules: [{ from: "25:99", to: "12:00" }] } },
    }));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects a non-numeric rule rate", async () => {
    const res = await route.PATCH(req(URL_BASE, {
      openai: { "gpt-5.1": { input: 1, output: 1, rules: [{ from: "01:00", to: "12:00", input: "cheap" }] } },
    }));
    expect(res.status).toBe(400);
  });

  it("DELETE ?provider&model resets to the base rate", async () => {
    await route.DELETE(req(`${URL_BASE}?provider=openai&model=gpt-5.1`));
    const got = await (await route.GET(req(`${URL_BASE}?provider=openai&model=gpt-5.1`))).json();
    expect(got.pricing.input).toBe(1.25);
    expect(got.pricing.rules).toBeUndefined();
  });
});
