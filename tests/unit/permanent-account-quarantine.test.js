/**
 * Permanent credential failures (suspended / revoked / invalid token) must be
 * quarantined account-wide, not model-locked for two minutes.
 *
 * Regression context: a pool of 240 Kiro connections where 122 were suspended
 * by AWS made every client request walk ~120 upstreams (≈4s each) before
 * reaching a healthy account. Because a 403 only locked the account for 2
 * minutes for ONE model, the dead prefix came back on every retry and clients
 * timed out with "rate limited"/"error".
 *
 * Contract:
 *  - permanent failures lock `modelLock___all` for PERMANENT_ACCOUNT_COOLDOWN_MS
 *  - a connection whose persisted lastError matches stays out of selection until
 *    the quarantine window ends, without any upstream call
 *  - when every account is quarantined, selection reports a retryAfter instead
 *    of "no credentials"
 *  - ordinary 401s / request-scoped 4xx are unaffected
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

const {
  isPermanentAccountError,
  isAccountQuarantined,
} = await import("open-sse/services/accountFallback.js");
const { PERMANENT_ACCOUNT_COOLDOWN_MS } = await import("open-sse/config/errorConfig.js");
const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");

const SUSPENDED = JSON.stringify({
  message: "Your User ID is temporarily suspended. We detected unusual user activity and locked it as a security precaution.",
  reason: "TEMPORARILY_SUSPENDED",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.updateProviderConnection.mockResolvedValue(undefined);
});

describe("isPermanentAccountError", () => {
  it("matches suspension and revoked-token failures", () => {
    expect(isPermanentAccountError(403, SUSPENDED)).toBe(true);
    expect(isPermanentAccountError(403, '{"message":"The bearer token included in the request is invalid."}')).toBe(true);
    expect(isPermanentAccountError("401", '{"error":"invalid_grant"}')).toBe(true);
    expect(isPermanentAccountError(403, "This account has been disabled")).toBe(true);
    // Persisted rows may not carry errorCode; the text alone is enough.
    expect(isPermanentAccountError(undefined, SUSPENDED)).toBe(true);
  });

  it("ignores transient and request-scoped failures", () => {
    expect(isPermanentAccountError(429, "rate limit exceeded")).toBe(false);
    expect(isPermanentAccountError(403, '{"message":"Image format is not supported."}')).toBe(false);
    expect(isPermanentAccountError(400, "maximum context length exceeded")).toBe(false);
    expect(isPermanentAccountError(401, "invalid api key")).toBe(false);
    expect(isPermanentAccountError(500, SUSPENDED)).toBe(false);
  });

  it("reports a persisted connection as quarantined while the window is open", () => {
    const now = Date.now();
    expect(isAccountQuarantined({
      lastError: SUSPENDED,
      errorCode: 403,
      lastErrorAt: new Date(now - 60_000).toISOString(),
    }, now)).toBe(true);

    expect(isAccountQuarantined({
      lastError: SUSPENDED,
      errorCode: 403,
      lastErrorAt: new Date(now - PERMANENT_ACCOUNT_COOLDOWN_MS - 1).toISOString(),
    }, now)).toBe(false);

    expect(isAccountQuarantined({
      lastError: '{"message":"Image format is not supported."}',
      errorCode: 400,
      lastErrorAt: new Date(now - 60_000).toISOString(),
    }, now)).toBe(false);
  });
});

describe("markAccountUnavailable — permanent credentials", () => {
  it("locks the whole account for the quarantine window", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", displayName: "Suspended", backoffLevel: 0 },
    ]);

    const before = Date.now();
    const result = await markAccountUnavailable("conn-1", 403, SUSPENDED, "kiro", "claude-sonnet-4.5");

    expect(result.shouldFallback).toBe(true);
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    expect(update["modelLock___all"]).toBeDefined();
    expect(update["modelLock_claude-sonnet-4.5"]).toBeUndefined();
    const lockMs = new Date(update["modelLock___all"]).getTime() - before;
    expect(lockMs).toBeGreaterThanOrEqual(PERMANENT_ACCOUNT_COOLDOWN_MS - 1_000);
    expect(lockMs).toBeLessThanOrEqual(PERMANENT_ACCOUNT_COOLDOWN_MS + 1_000);
  });

  it("keeps the short per-model lock for ordinary auth errors", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", displayName: "Bad key", backoffLevel: 0 },
    ]);

    await markAccountUnavailable("conn-1", 401, "invalid api key", "openai", "gpt-4o");

    const update = mocks.updateProviderConnection.mock.calls[0][1];
    expect(update["modelLock_gpt-4o"]).toBeDefined();
    expect(update["modelLock___all"]).toBeUndefined();
  });
});

describe("getProviderCredentials — quarantine filter", () => {
  const suspended = (id) => ({
    id,
    provider: "kiro",
    isActive: true,
    priority: 1,
    lastError: SUSPENDED,
    errorCode: 403,
    lastErrorAt: new Date().toISOString(),
  });

  it("skips quarantined accounts without an upstream call", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      suspended("dead-1"),
      suspended("dead-2"),
      { id: "alive", provider: "kiro", isActive: true, priority: 128 },
    ]);

    const result = await getProviderCredentials("kiro", null, "claude-sonnet-4.5");

    expect(result.connectionId).toBe("alive");
  });

  it("reports a retryAfter when every account is quarantined", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      suspended("dead-1"),
      suspended("dead-2"),
    ]);

    const result = await getProviderCredentials("kiro", null, "claude-sonnet-4.5");

    expect(result).toMatchObject({ allRateLimited: true });
    expect(result.retryAfter).toBeTruthy();
    expect(new Date(result.retryAfter).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not inherit a stale quarantine after the window", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        ...suspended("old"),
        lastErrorAt: new Date(Date.now() - PERMANENT_ACCOUNT_COOLDOWN_MS - 60_000).toISOString(),
      },
    ]);

    const result = await getProviderCredentials("kiro", null, "claude-sonnet-4.5");

    expect(result.connectionId).toBe("old");
  });
});
