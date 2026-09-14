/**
 * Freebuff features — strict-model-assignment routing gate
 *
 * Sibling of `freebuff-strict-model-assignment.test.js` (which pins the pure
 * `filterConnectionsForModel` contract). This file pins the engine wiring in
 * `getProviderCredentials`: when strict mode is on and the requested model is
 * not assigned to any account, selection must be refused LOCALLY — the request
 * must never reach the provider, because a forwarded call would come back as
 * `model_locked` (409) and burn a session round-trip.
 *
 * Contract:
 *  - requested model unassigned + strict on → `{ allRateLimited: true, strictBlocked: true, lastErrorCode: 403 }`
 *  - requested model assigned → that connection is selected
 *  - strict on for a non-freebuff provider → pass-through (no block)
 *  - assigned account already excluded (failed earlier) → `null` (let caller
 *    surface the real upstream error instead of masking it as a block)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const ASSIGNED = "deepseek/deepseek-v4-flash";
const OTHER = "z-ai/glm-5.3-flash";

const STRICT_SETTINGS = {
  providerStrategies: { freebuff: { strictModelAssignment: true } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.updateProviderConnection.mockResolvedValue(undefined);
});

describe("getProviderCredentials — freebuff strict model assignment", () => {
  it("refuses locally when the requested model is not assigned to any account", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "fb-a", provider: "freebuff", isActive: true, providerSpecificData: { assignedModel: ASSIGNED } },
    ]);
    mocks.getSettings.mockResolvedValue(STRICT_SETTINGS);

    const result = await getProviderCredentials("freebuff", null, OTHER);

    expect(result).toMatchObject({
      allRateLimited: true,
      strictBlocked: true,
      lastErrorCode: 403,
    });
    expect(result.lastError).toContain(OTHER);
  });

  it("selects the account assigned to the requested model", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "fb-a", provider: "freebuff", isActive: true, providerSpecificData: { assignedModel: ASSIGNED } },
      { id: "fb-b", provider: "freebuff", isActive: true, providerSpecificData: { assignedModel: OTHER } },
    ]);
    mocks.getSettings.mockResolvedValue(STRICT_SETTINGS);

    const result = await getProviderCredentials("freebuff", null, OTHER);

    expect(result).toMatchObject({ connectionId: "fb-b" });
    expect(result.strictBlocked).toBeUndefined();
  });

  it("honors the legacy freebuffModel field when selecting", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "fb-legacy", provider: "freebuff", isActive: true, providerSpecificData: { freebuffModel: ASSIGNED } },
    ]);
    mocks.getSettings.mockResolvedValue(STRICT_SETTINGS);

    const result = await getProviderCredentials("freebuff", null, ASSIGNED);

    expect(result).toMatchObject({ connectionId: "fb-legacy" });
  });

  it("does not block a non-freebuff provider even with the flag present", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "claude-a", provider: "claude", isActive: true, providerSpecificData: {} },
    ]);
    mocks.getSettings.mockResolvedValue(STRICT_SETTINGS);

    const result = await getProviderCredentials("claude", null, OTHER);

    expect(result).toMatchObject({ connectionId: "claude-a" });
    expect(result.strictBlocked).toBeUndefined();
  });

  it("returns null (not a block) when the assigned account was already excluded", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "fb-a", provider: "freebuff", isActive: true, providerSpecificData: { assignedModel: OTHER } },
    ]);
    mocks.getSettings.mockResolvedValue(STRICT_SETTINGS);

    // fb-a already failed this request → caller retries with it excluded. There
    // is no other account, so report "no more accounts" rather than a 403 that
    // would hide the real upstream failure.
    const result = await getProviderCredentials("freebuff", new Set(["fb-a"]), OTHER);

    expect(result).toBeNull();
  });

  it("passes through when strict mode is off", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "fb-a", provider: "freebuff", isActive: true, providerSpecificData: { assignedModel: ASSIGNED } },
    ]);
    mocks.getSettings.mockResolvedValue({});

    const result = await getProviderCredentials("freebuff", null, OTHER);

    expect(result).toMatchObject({ connectionId: "fb-a" });
    expect(result.strictBlocked).toBeUndefined();
  });

  it("reports the lock (not a 403) when the assigned account is model-locked", async () => {
    // The model IS assigned — the account just can't serve right now. This must
    // not be reported as "not assigned", or the user would go re-configure a
    // provider that is actually correct.
    const lockUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "fb-a",
        provider: "freebuff",
        isActive: true,
        providerSpecificData: { assignedModel: ASSIGNED },
        [`modelLock_${ASSIGNED}`]: lockUntil,
      },
    ]);
    mocks.getSettings.mockResolvedValue(STRICT_SETTINGS);

    const result = await getProviderCredentials("freebuff", null, ASSIGNED);

    expect(result.strictBlocked).toBeUndefined();
    expect(result.allRateLimited).toBe(true);
    expect(result.retryAfter).toBe(lockUntil);
  });
});
