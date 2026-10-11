// Durable proxy-pool fitness store + bulk connection create.
// Ported from VansRouter; exercises the SQLite-backed persistence end to end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ppf-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global.__9routerPoolFitness__;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("proxy pool fitness store", () => {
  it("persists an unfit mark and reports it via the snapshot", async () => {
    const { markPoolUnfit, poolFitnessSnapshot, clearAllPoolUnfit } =
      await import("open-sse/services/proxyPoolFitness.js");

    const until = Date.now() + 60_000;
    await markPoolUnfit("pool-1", "freebuff::model-x", until, "limited_ip");

    const snap = await poolFitnessSnapshot();
    expect(snap["pool-1"]["freebuff::model-x"].reason).toBe("limited_ip");
    expect(snap["pool-1"]["freebuff::model-x"].until).toBe(until);

    await clearAllPoolUnfit();
    expect(await poolFitnessSnapshot()).toEqual({});
  });

  it("survives a module reload (SQLite is the source of truth, not the cache)", async () => {
    const first = await import("open-sse/services/proxyPoolFitness.js");
    await first.markPoolUnfit("pool-2", "freebuff::*", Date.now() + 60_000, "quota");
    expect(first.isPoolUnfit("pool-2", "freebuff::anything")).toBe(true);

    // Fresh module instance + empty in-memory cache; load from DB must restore it.
    delete global.__9routerPoolFitness__;
    vi.resetModules();
    const second = await import("open-sse/services/proxyPoolFitness.js");
    await second.loadPoolFitness("pool-2");
    expect(second.isPoolUnfit("pool-2", "freebuff::anything")).toBe(true);
  });

  it("treats an expired row as fit and prunes it", async () => {
    const { markPoolUnfit, poolFitnessSnapshot } = await import("open-sse/services/proxyPoolFitness.js");
    await markPoolUnfit("pool-3", "freebuff::m", Date.now() - 1, "stale");
    expect(await poolFitnessSnapshot()).toEqual({});
  });

  it("provider-scoped clear-all leaves other providers untouched", async () => {
    const { markPoolUnfit, clearAllPoolUnfit, poolFitnessSnapshot } =
      await import("open-sse/services/proxyPoolFitness.js");
    const until = Date.now() + 60_000;
    await markPoolUnfit("p", "freebuff::m", until, "x");
    await markPoolUnfit("p", "other::m", until, "y");

    await clearAllPoolUnfit("freebuff");
    const snap = await poolFitnessSnapshot();
    expect(snap["p"]["freebuff::m"]).toBeUndefined();
    expect(snap["p"]["other::m"]).toBeDefined();
  });

  it("provider-scoped clear-all does not over-match '_' in provider ids", async () => {
    const { markPoolUnfit, clearAllPoolUnfit, poolFitnessSnapshot } =
      await import("open-sse/services/proxyPoolFitness.js");
    const until = Date.now() + 60_000;
    // "scribe_v1" vs "scribeXv1": LIKE would treat "_" as a single-char wildcard.
    await markPoolUnfit("p", "scribe_v1::m", until, "x");
    await markPoolUnfit("p", "scribeXv1::m", until, "y");

    await clearAllPoolUnfit("scribe_v1");
    const snap = await poolFitnessSnapshot();
    expect(snap["p"]["scribe_v1::m"]).toBeUndefined();
    expect(snap["p"]["scribeXv1::m"]).toBeDefined();
  });
});

describe("bulk provider connection create", () => {
  it("creates api-key connections and reports per-item results", async () => {
    const { createProviderConnectionsBulk } = await import("@/lib/db/index.js");
    const results = await createProviderConnectionsBulk([
      { provider: "openai", apiKey: "sk-1", name: "acct-1" },
      { provider: "openai", apiKey: "sk-2", name: "acct-2" },
      { provider: "", apiKey: "x", name: "bad" },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ name: "acct-1", ok: true, updated: false });
    expect(results[1]).toMatchObject({ name: "acct-2", ok: true, updated: false });
    expect(results[2].ok).toBe(false);
  });

  it("updates an existing connection with the same provider+name", async () => {
    const { createProviderConnectionsBulk, getProviderConnections } = await import("@/lib/db/index.js");
    await createProviderConnectionsBulk([{ provider: "openai", apiKey: "sk-1", name: "dup" }]);
    const second = await createProviderConnectionsBulk([{ provider: "openai", apiKey: "sk-2", name: "dup" }]);
    expect(second[0]).toMatchObject({ name: "dup", ok: true, updated: true });

    const conns = await getProviderConnections({ provider: "openai" });
    expect(conns).toHaveLength(1);
    expect(conns[0].apiKey).toBe("sk-2");
  });

  it("rejects an oversized batch", async () => {
    const { createProviderConnectionsBulk } = await import("@/lib/db/index.js");
    await expect(createProviderConnectionsBulk(Array.from({ length: 501 }, (_, i) => ({ provider: "openai", apiKey: "k", name: `n${i}` }))))
      .rejects.toThrow(/1-500/);
  });
});
