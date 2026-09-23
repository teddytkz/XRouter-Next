// Guards the two ways normalizeParts could write a dishonest split: a zero
// split against a legacy (nonzero) day cost, and a corrupt negative cost.
// Both must drop the split rather than leave Σparts != cost or a negative part.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const PARTS = ["inputCost", "cachedCost", "outputCost", "reasoningCost", "cacheCreationCost"];
const hasParts = (o) => PARTS.some((p) => o[p] != null);

// The adapter is memoised per process, so each case gets its own DATA_DIR and
// its own dateKey — a shared DB would collide on the usageDaily primary key.
async function seed(dateKey, provider, dayCost, rowCost) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-"));
  process.env.DATA_DIR = dir;
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
    dateKey,
    JSON.stringify({
      requests: 1, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: dayCost,
      byProvider: { [provider]: { requests: 1, promptTokens: 10, completionTokens: 0, cachedTokens: 0, cost: dayCost } },
    }),
  ]);
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, tokens, cost, status, meta) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [`${dateKey}T01:00:00.000Z`, provider, `${provider}-1`, JSON.stringify({ prompt_tokens: 10 }), rowCost, "ok", JSON.stringify({})]
  );
  return db;
}

describe("normalizeParts edge cases", () => {
  it("a zero split against a nonzero legacy cost leaves NO split, not Σ0", async () => {
    // Free model → all parts 0; the legacy day cost is inflated to 7.50.
    const db = await seed("2026-09-07", "free-model", 7.5, 7.5);
    const { recalculateCosts } = await import("@/lib/db/index.js");
    await recalculateCosts();
    const b = JSON.parse(db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, ["2026-09-07"]).data).byProvider["free-model"];
    expect(hasParts(b)).toBe(false);
    expect(b.cost).toBe(7.5);
  });

  it("a corrupt negative legacy cost never writes a negative part", async () => {
    const db = await seed("2026-09-08", "neg-model", -5, -5);
    const { recalculateCosts } = await import("@/lib/db/index.js");
    await recalculateCosts();
    const day = JSON.parse(db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, ["2026-09-08"]).data);
    for (const b of Object.values(day.byProvider)) {
      for (const p of PARTS) if (b[p] != null) expect(b[p]).toBeGreaterThanOrEqual(0);
    }
  });
});
