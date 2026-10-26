// Combos gained an optional context_length column. It arrives through the
// additive schema sync, so a DB written before it opens fine, existing rows
// read null, and create/update persist it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function writeLegacyDb(dir) {
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '2'), ('backupSchemaVersion', '2')`);
  db.exec(`CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
  db.prepare(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("c1", "legacy", null, '["a/b"]', "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  db.close();
}

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { db, adapter: await getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-ctx-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("combos context_length", () => {
  it("adds the column to an existing DB and reads legacy rows as null", async () => {
    writeLegacyDb(tempDir);
    const { db, adapter } = await boot();

    const cols = adapter.all(`PRAGMA table_info(combos)`).map((c) => c.name);
    expect(cols).toContain("context_length");

    const combos = await db.getCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0]).toMatchObject({ name: "legacy", context_length: null });
  });

  it("persists context_length on create and update", async () => {
    const { db } = await boot();
    const created = await db.createCombo({ name: "big", models: ["a/b"], context_length: 200000 });
    expect(created.context_length).toBe(200000);
    expect((await db.getComboByName("big")).context_length).toBe(200000);

    const updated = await db.updateCombo(created.id, { context_length: 131072 });
    expect(updated.context_length).toBe(131072);
    expect((await db.getComboById(created.id)).context_length).toBe(131072);
  });
});
