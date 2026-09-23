// resetUsage must actually empty all three tables and the lifetime counter —
// a partial wipe would leave the dashboard showing totals nothing backs.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-"));
  process.env.DATA_DIR = dir;
  // Details are written through a buffered flush (batchSize, then a flush timer).
  // A batch size above what the test pushes leaves them sitting in the buffer,
  // which is exactly the state a reset has to account for. The settings values
  // win over the env vars.
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  // batchSize 10 keeps the pushed row buffered; the short flush interval then
  // lets the real timer drain it, so the test needs no test-only flush export.
  await updateSettings({
    enableObservability: true,
    observabilityBatchSize: 10,
    observabilityFlushIntervalMs: 50,
  });
  return { dir, db };
}

const detail = (id, ts) => ({ id, model: "m-1", provider: "p", timestamp: ts });
// Longer than the 50ms flush interval set in freshDb.
const settle = () => new Promise((r) => setTimeout(r, 250));

describe("resetUsage", () => {
  it("empties history, daily, details, and the lifetime counter", async () => {
    const { dir, db } = await freshDb();
    try {
      const { saveRequestUsage, saveRequestDetail, resetUsage, getUsageStats } =
        await import("@/lib/db/index.js");

      await saveRequestUsage({
        timestamp: "2026-09-09T01:00:00.000Z", provider: "p", model: "m-1",
        tokens: { prompt_tokens: 100, completion_tokens: 10 }, cost: 0.5, status: "ok",
      });
      // Left in the write buffer — a reset that only deleted rows would let the
      // next flush resurrect this one.
      await saveRequestDetail(detail("d1", "2026-09-09T01:00:00.000Z"));

      const res = await resetUsage();
      expect(res.history).toBe(1);
      expect(res.days).toBe(1);
      expect(res.details).toBe(1); // 0 in the table + 1 still buffered
      expect(res.detailsError).toBeNull();
      expect(res.backup).toBeTruthy();

      await settle();
      expect(db.get(`SELECT COUNT(*) as c FROM requestDetails`).c).toBe(0);

      expect(db.get(`SELECT COUNT(*) as c FROM usageHistory`).c).toBe(0);
      expect(db.get(`SELECT COUNT(*) as c FROM usageDaily`).c).toBe(0);
      expect(db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`)).toBeUndefined();

      // The dashboard reads through getUsageStats — it must come back empty, not
      // keep serving the in-memory ring of deleted rows.
      const stats = await getUsageStats("all");
      expect(stats.totalRequests).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("a detail pushed after the reset survives (the guard does not over-reach)", async () => {
    const { dir, db } = await freshDb();
    try {
      const { saveRequestDetail, resetUsage } = await import("@/lib/db/index.js");
      await resetUsage();
      await saveRequestDetail(detail("after", "2026-09-09T02:00:00.000Z"));
      await settle();
      expect(db.get(`SELECT COUNT(*) as c FROM requestDetails`).c).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
