import { describe, it, expect, vi, beforeEach } from "vitest";

const connections = [];
const updateProviderConnection = vi.fn();

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(async () => connections),
  updateProviderConnection: (...args) => updateProviderConnection(...args),
}));

const { reactivateExpiredKimchiAccounts } = await import(
  "../../src/sse/services/kimchiQuotaReactivation.js"
);

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();

const conn = (over = {}) => ({
  id: "c1",
  name: "kimchi-1",
  testStatus: "quota_exhausted",
  rateLimitedUntil: past,
  ...over,
});

beforeEach(() => {
  connections.length = 0;
  updateProviderConnection.mockClear();
});

describe("reactivateExpiredKimchiAccounts", () => {
  it("reactivates an account whose cooldown has passed", async () => {
    connections.push(conn());
    expect(await reactivateExpiredKimchiAccounts()).toBe(1);
    expect(updateProviderConnection).toHaveBeenCalledWith("c1", {
      isActive: true,
      rateLimitedUntil: null,
      testStatus: "active",
      quotaExhaustedAt: null,
      quotaResetsAt: null,
    });
  });

  it("leaves an account still inside its cooldown alone", async () => {
    connections.push(conn({ rateLimitedUntil: future }));
    expect(await reactivateExpiredKimchiAccounts()).toBe(0);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("skips accounts that were not marked quota-exhausted", async () => {
    connections.push(conn({ testStatus: "rate_limit" }));
    connections.push(conn({ id: "c2", rateLimitedUntil: null }));
    expect(await reactivateExpiredKimchiAccounts()).toBe(0);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps sweeping after one account fails to update", async () => {
    connections.push(conn(), conn({ id: "c2" }));
    updateProviderConnection.mockRejectedValueOnce(new Error("db locked"));
    expect(await reactivateExpiredKimchiAccounts()).toBe(1);
    expect(updateProviderConnection).toHaveBeenCalledTimes(2);
  });
});
