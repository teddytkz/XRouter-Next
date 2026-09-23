import { describe, it, expect } from "vitest";
import { applyTimeRules, activeTimeRule, calculateCostFromTokens } from "open-sse/providers/pricing.js";

// Windows are UTC by default, so the instants below are built in UTC — a
// host-local `new Date(y, m, d, h)` would only pass on a UTC machine.
const at = (h, m = 0) => new Date(Date.UTC(2026, 0, 15, h, m));

const base = { input: 1.25, output: 10.0, cached: 0.625 };
const withRule = { ...base, rules: [{ from: "01:00", to: "12:00", input: 0.1, output: 0.8 }] };

describe("time-of-day pricing rules", () => {
  it("evaluates a rule with no tz in UTC, not the host's timezone", () => {
    // Sweep all 24 UTC hours of one day. The window must land on UTC 01,02,03
    // regardless of where this test runs — under a host-local default the match
    // set would shift by the host's offset (e.g. 18,19,20 on a UTC+7 box).
    const rule = { ...base, rules: [{ from: "01:00", to: "04:00", input: 0.1 }] };
    const matched = [];
    for (let h = 0; h < 24; h++) {
      if (activeTimeRule(rule, at(h)) !== null) matched.push(h);
    }
    expect(matched).toEqual([1, 2, 3]);
  });

  it("uses the rule rate inside the window", () => {
    const p = applyTimeRules(withRule, at(9, 14));
    expect(p.input).toBe(0.1);
    expect(p.output).toBe(0.8);
    expect(p.cached).toBe(0.625); // untouched field falls back to base
  });

  it("uses the base rate outside the window", () => {
    expect(applyTimeRules(withRule, at(20, 30))).toBe(withRule);
  });

  it("window is start-inclusive, end-exclusive", () => {
    expect(activeTimeRule(withRule, at(1, 0))).not.toBeNull();
    expect(activeTimeRule(withRule, at(12, 0))).toBeNull();
  });

  it("wraps past midnight when from > to", () => {
    const wrap = { ...base, rules: [{ from: "22:00", to: "06:00", input: 0.05 }] };
    expect(activeTimeRule(wrap, at(23, 30))).not.toBeNull();
    expect(activeTimeRule(wrap, at(5, 59))).not.toBeNull();
    expect(activeTimeRule(wrap, at(6, 0))).toBeNull();
    expect(activeTimeRule(wrap, at(12, 0))).toBeNull();
  });

  it("ignores malformed windows instead of throwing", () => {
    const bad = { ...base, rules: [{ from: "nope", to: "12:00", input: 0.1 }] };
    expect(activeTimeRule(bad, at(9))).toBeNull();
  });

  it("restricts a rule to its listed weekdays", () => {
    // What the modal's day checkboxes produce. 2026-01-05 is a Monday, 01-04 a Sunday.
    const weekdays = { ...base, rules: [{ from: "01:00", to: "04:00", days: [1, 2, 3, 4, 5], input: 0.1 }] };
    const mon = new Date(Date.UTC(2026, 0, 5, 2));
    const sun = new Date(Date.UTC(2026, 0, 4, 2));
    expect(activeTimeRule(weekdays, mon)).not.toBeNull();
    expect(activeTimeRule(weekdays, sun)).toBeNull();
  });

  it("treats an absent or empty days list as every day", () => {
    // The modal drops `days` when all seven are on, so absent must mean "always".
    const everyDay = { ...base, rules: [{ from: "01:00", to: "04:00", input: 0.1 }] };
    expect(activeTimeRule(everyDay, at(2))).not.toBeNull();
    const empty = { ...base, rules: [{ from: "01:00", to: "04:00", days: [], input: 0.1 }] };
    expect(activeTimeRule(empty, at(2))).not.toBeNull();
  });

  it("prices a request with the rule rate at the request time", () => {
    const tokens = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
    // rule active: 0.1 + 0.8
    expect(calculateCostFromTokens(tokens, withRule, at(9))).toBeCloseTo(0.9, 6);
    // base: 1.25 + 10
    expect(calculateCostFromTokens(tokens, withRule, at(20))).toBeCloseTo(11.25, 6);
  });
});
