// The free-tier catalogue is derived from the registry, so a typo in an
// annotation must fail loudly (listFreeTiers throws) rather than ship quietly.
import { describe, it, expect } from "vitest";
import { listFreeTiers, FREE_REFRESH_VALUES } from "../../open-sse/providers/freeTiers.js";

describe("listFreeTiers", () => {
  const rows = listFreeTiers();

  it("emits one provider-level row per free provider", () => {
    const providerRows = rows.filter((r) => r.modelId === null);
    const ids = providerRows.map((r) => r.providerId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never emits a model row without kind or name", () => {
    for (const row of rows.filter((r) => r.modelId !== null)) {
      expect(row.kind).toBeTruthy();
      expect(row.modelName).toBeTruthy();
    }
  });

  it("uses only documented refresh cadences", () => {
    for (const row of rows) {
      if (row.freeRefresh === null) continue;
      expect(FREE_REFRESH_VALUES).toContain(row.freeRefresh);
    }
  });

  it("is deterministic", () => {
    expect(listFreeTiers().map((r) => `${r.providerId}/${r.modelId}`))
      .toEqual(listFreeTiers().map((r) => `${r.providerId}/${r.modelId}`));
  });
});
