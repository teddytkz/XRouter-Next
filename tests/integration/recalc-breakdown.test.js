import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Money-path check on a COPY of the real DB (skipped when there is none).
// recalculateCosts must backfill the per-component breakdown, and every figure
// the UI reads must satisfy Σ parts == cost — otherwise the usage table shows
// per-column costs that don't add up to the total in the next column over.
const SRC = path.join(os.homedir(), ".9router/db/data.sqlite");
const PARTS = ["inputCost", "cachedCost", "outputCost", "reasoningCost", "cacheCreationCost"];
const FAMILIES = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"];

const sumParts = (o) => PARTS.reduce((s, p) => s + (o[p] || 0), 0);
const hasParts = (o) => PARTS.some((p) => o[p] != null);
// calculateCostBreakdown keys the parts differently (input/cached/…) than the
// stored fields (inputCost/…), so rows need their own summer.
const sumBd = (b) => ["input", "cached", "output", "reasoning", "cacheCreation"].reduce((s, k) => s + (b[k] || 0), 0);

describe.skipIf(!fs.existsSync(SRC))("cost breakdown integrity", () => {
  it("Σ parts == cost at row, day, and bucket level", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    process.env.DATA_DIR = dir;
    fs.mkdirSync(path.join(dir, "db"), { recursive: true });
    fs.copyFileSync(SRC, path.join(dir, "db/data.sqlite"));

    const { recalculateCosts, getUsageStats } = await import("@/lib/db/index.js");
    const res = await recalculateCosts();
    expect(res.rows).toBeGreaterThan(0);
    console.log("recalculate:", JSON.stringify(res));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    // 1. Every priced row carries a breakdown that sums to its stored cost.
    const rows = db.all(`SELECT cost, meta FROM usageHistory`);
    let withBd = 0, worstRow = 0;
    for (const r of rows) {
      const m = typeof r.meta === "string" ? JSON.parse(r.meta || "{}") : (r.meta || {});
      if (!m.costBreakdown) continue;
      withBd++;
      worstRow = Math.max(worstRow, Math.abs(sumBd(m.costBreakdown) - (r.cost || 0)));
    }
    expect(withBd).toBeGreaterThan(0);
    expect(worstRow).toBeLessThan(1e-9);
    console.log("rows with breakdown:", withBd, "/", rows.length, "worst row delta:", worstRow);

    // 2. Every day's stored bucket splits sum to their bucket's cost — including
    //    legacy-imported days, whose cost no history can reproduce (normalizeParts
    //    scales or drops the split rather than leave Σ≠cost).
    let worstDay = 0, checkedBuckets = 0;
    for (const d of db.all(`SELECT dateKey, data FROM usageDaily`)) {
      const j = JSON.parse(d.data || "{}");
      for (const fam of FAMILIES) {
        for (const b of Object.values(j[fam] || {})) {
          if (!hasParts(b)) continue;
          checkedBuckets++;
          worstDay = Math.max(worstDay, Math.abs(sumParts(b) - (b.cost || 0)));
        }
      }
    }
    expect(checkedBuckets).toBeGreaterThan(0);
    expect(worstDay).toBeLessThan(1e-6);
    console.log("day buckets with split:", checkedBuckets, "worst day delta:", worstDay);

    // 3. Both read paths: the daily-summary aggregate and the live today window.
    //    The displayed columns are Input / Cached / Output / Total, so the three
    //    cost-bearing columns MUST sum to the total — that is the whole point.
    for (const period of ["30d", "today"]) {
      const stats = await getUsageStats(period);
      let worstBucket = 0, checked = 0;
      for (const fam of FAMILIES) {
        for (const [key, b] of Object.entries(stats[fam] || {})) {
          if (!hasParts(b)) continue; // legacy bucket → client token-share fallback
          checked++;
          const displayed = b.inputCost + b.cachedCost + b.outputCost
            + (b.reasoningCost || 0) + (b.cacheCreationCost || 0);
          const delta = Math.abs(displayed - (b.cost || 0));
          if (delta > 1e-6) console.log(`  ${period} ${fam}[${key}] delta=${delta}`);
          worstBucket = Math.max(worstBucket, delta);
        }
      }
      console.log(`${period}: ${checked} split buckets, worst delta: ${worstBucket}`);
      expect(worstBucket).toBeLessThan(1e-6);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }, 300000);
});
