// Peak-rate (time-of-day) rules: zone-aware windows, weekday filters, and the
// registry-wide price table. A wrong zone here silently mis-bills every request.
import { describe, it, expect } from "vitest";
import { activeTimeRule, applyTimeRules, calculateCostFromTokens, getPricingForModel } from "open-sse/providers/pricing.js";

// DeepSeek peak = 01:00-04:00 & 06:00-10:00 UTC, Mon-Fri. 2026-01-05 is a Monday.
const at = (utcHour, utcMin = 0, day = 5) => new Date(Date.UTC(2026, 0, day, utcHour, utcMin));
const ds = () => getPricingForModel("deepseek", "deepseek-v4-pro");
const flash = () => getPricingForModel("deepseek", "deepseek-v4.1-flash");

describe("peak rules resolve in the rule's own timezone", () => {
  it("charges peak inside 01:00-04:00 UTC on a weekday", () => {
    const p = applyTimeRules(ds(), at(2));
    expect(p.input).toBeCloseTo(1.32, 6);
    expect(p.output).toBeCloseTo(3.96, 6);
  });

  it("charges peak inside the second window (06:00-10:00 UTC)", () => {
    expect(applyTimeRules(ds(), at(7)).input).toBeCloseTo(1.32, 6);
  });

  it("falls back to off-peak outside both windows", () => {
    const p = applyTimeRules(ds(), at(5)); // the 04:00-06:00 gap
    expect(p.input).toBeCloseTo(0.66, 6);
    expect(p.output).toBeCloseTo(1.98, 6);
  });

  it("treats the window as start-inclusive / end-exclusive", () => {
    expect(applyTimeRules(ds(), at(1, 0)).input).toBeCloseTo(1.32, 6); // 01:00 -> peak
    expect(applyTimeRules(ds(), at(4, 0)).input).toBeCloseTo(0.66, 6); // 04:00 -> off-peak
  });

  it("ignores the peak window on weekends", () => {
    // 2026-01-04 is a Sunday, 2026-01-03 a Saturday — same 02:00 UTC hour.
    expect(applyTimeRules(ds(), at(2, 0, 4)).input).toBeCloseTo(0.66, 6);
    expect(applyTimeRules(ds(), at(2, 0, 3)).input).toBeCloseTo(0.66, 6);
  });

  it("resolves each rule in its own zone, not the server's", () => {
    // Can't probe via process.env.TZ: Node caches the local zone at startup, so
    // getHours() would not move. Instead give two rules the SAME window in
    // different zones — at 02:00 UTC the UTC rule matches and the UTC+14 one
    // (16:00 there) cannot. If `tz` were ignored, both rules would resolve to
    // the same host-local hour and the two calls could not disagree.
    const twoZones = {
      input: 0.66, output: 1.98,
      rules: [
        { from: "01:00", to: "04:00", tz: "UTC", input: 1.32, output: 3.96 },
        { from: "01:00", to: "04:00", tz: "Pacific/Kiritimati", input: 9.99, output: 9.99 },
      ],
    };
    // 02:00 UTC → 02:00 there (rule 1 in-window), 16:00 in Kiritimati (rule 2 out).
    expect(applyTimeRules(twoZones, at(2)).input).toBeCloseTo(1.32, 6);
    // 12:00 UTC → 12:00 there (rule 1 out), 02:00 next day in Kiritimati (rule 2 in).
    expect(applyTimeRules(twoZones, at(12)).input).toBeCloseTo(9.99, 6);
  });
});

describe("models without rules stay on their normal rate", () => {
  it("deepseek-chat has no rules and no peak", () => {
    const p = getPricingForModel("deepseek", "deepseek-chat");
    expect(p.rules).toBeUndefined();
    expect(activeTimeRule(p, at(2))).toBeNull();
    expect(applyTimeRules(p, at(2)).input).toBeCloseTo(0.14, 6);
  });

  it("the flash model has its own peak schedule", () => {
    expect(applyTimeRules(flash(), at(2)).input).toBeCloseTo(0.30, 6);
    expect(applyTimeRules(flash(), at(12)).input).toBeCloseTo(0.15, 6);
  });
});

describe("cost follows the window end to end", () => {
  const tokens = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

  it("bills a peak-time request at peak rates", () => {
    // 1.32 + 3.96
    expect(calculateCostFromTokens(tokens, ds(), at(2))).toBeCloseTo(5.28, 6);
  });

  it("bills an off-peak request at base rates", () => {
    // 0.66 + 1.98
    expect(calculateCostFromTokens(tokens, ds(), at(12))).toBeCloseTo(2.64, 6);
  });
});

describe("rule validation at the API boundary", () => {
  it("rejects an unknown timezone and accepts a known one", async () => {
    const route = await import("@/app/api/pricing/route.js");
    const patch = (rule) => route.PATCH({
      url: "http://x/api/pricing",
      json: async () => ({ deepseek: { "deepseek-chat": { input: 1, rules: [rule] } } }),
    });
    expect((await patch({ from: "01:00", to: "02:00", tz: "Not/AZone" })).status).toBe(400);
    expect((await patch({ from: "01:00", to: "02:00", tz: "UTC" })).status).toBe(200);
    expect((await patch({ from: "01:00", to: "02:00", days: [1, 9] })).status).toBe(400);
    expect((await patch({ from: "01:00", to: "02:00", days: [1, 5] })).status).toBe(200);
  });
});
