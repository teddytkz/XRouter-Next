/**
 * GET /api/version — update banner source of truth.
 *
 * Regression guard for the phantom "↑ Update v0.5.65-extended" banner: the
 * route used to compare this fork's 0.1.x version against the upstream
 * `thunderkex/9router-extended` GitHub repo (which publishes 0.5.65-extended),
 * so `hasUpdate` was permanently true no matter what was installed. The route
 * must now compare against the published npm package for THIS fork, and the
 * install commands must be real npm commands (never `npm i -g undefined`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const mocks = vi.hoisted(() => ({
  fetchNpmLatest: vi.fn(),
  checkForUpdate: vi.fn(),
  clearPluginUpdateCache: vi.fn(),
}));

vi.mock("@/lib/updateCheck.js", () => ({
  fetchNpmLatest: mocks.fetchNpmLatest,
  checkForUpdate: mocks.checkForUpdate,
  clearPluginUpdateCache: mocks.clearPluginUpdateCache,
}));

const { GET } = await import("../../src/app/api/version/route.js");

function makeRequest(query = "") {
  return { url: `http://localhost:20128/api/version${query}` };
}

// The route returns a native Response via Response.json(); parse it back.
async function getJson(query = "") {
  const res = await GET(makeRequest(query));
  return res.json();
}

describe("GET /api/version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkForUpdate.mockResolvedValue({
      currentVersion: pkg.version,
      latestVersion: pkg.version,
      currentMd5: null,
      latestMd5: null,
      hasUpdate: false,
      isRebuild: false,
    });
  });

  it("resolves the latest version from the fork's own npm package", async () => {
    await GET(makeRequest());

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    const [cacheKey, currentVersion, resolver] = mocks.checkForUpdate.mock.calls[0];

    expect(cacheKey).toContain("xrouter-next");
    expect(currentVersion).toBe(pkg.version);
    expect(typeof resolver).toBe("function");
  });

  it("does not fall back to the upstream extended GitHub repo", async () => {
    const response = await getJson();

    // `isExtended` / `repo` / `tarballUrl` were the upstream-comparison surface.
    expect(response).not.toHaveProperty("isExtended");
    expect(response).not.toHaveProperty("repo");
    expect(response).not.toHaveProperty("tarballUrl");
  });

  it("never emits an install command containing `undefined`", async () => {
    const response = await getJson();

    for (const cmd of Object.values(response.packageManagers)) {
      expect(cmd).not.toMatch(/undefined/);
      expect(cmd).toContain("xrouter-next@latest");
    }
    expect(response.updateCmd).not.toMatch(/undefined/);
  });

  it("reports no update when installed version equals the published version", async () => {
    const response = await getJson();

    expect(response.hasUpdate).toBe(false);
    expect(response.latestVersion).toBe(pkg.version);
  });

  it("bypasses the cache when force=true", async () => {
    await GET(makeRequest("?force=true"));

    expect(mocks.clearPluginUpdateCache).toHaveBeenCalledTimes(1);
    const ttl = mocks.checkForUpdate.mock.calls[0][3];
    expect(ttl).toBe(0);
  });
});
