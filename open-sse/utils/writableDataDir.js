// Resolve a writable data directory: DATA_DIR first, then ~/.9router, then
// tmpdir. Some installs point DATA_DIR at a root-owned path the server cannot
// write runtime installs into.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

export function getWritableDataDir() {
  if (cached) return cached;
  for (const base of [process.env.DATA_DIR, path.join(os.homedir(), ".9router"), path.join(os.tmpdir(), "9router")].filter(Boolean)) {
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.accessSync(base, fs.constants.W_OK);
      cached = base;
      return base;
    } catch {
      // Not writable — try the next candidate.
    }
  }
  cached = process.cwd();
  return cached;
}
