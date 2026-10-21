#!/usr/bin/env node
// Root and cli/ are versioned independently but always released in lockstep.
import { readFileSync, writeFileSync } from "node:fs";

const PKGS = ["package.json", "cli/package.json"];

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/bump-version.mjs <x.y.z|patch|minor|major>");
  process.exit(1);
}

const [maj, min, pat] = read("package.json").version.split(".").map(Number);
const bumped = { patch: [maj, min, pat + 1], minor: [maj, min + 1, 0], major: [maj + 1, 0, 0] };
const next = (bumped[arg] ?? [arg]).join(".");

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`invalid version: ${next}`);
  process.exit(1);
}

for (const p of PKGS) {
  const pkg = read(p);
  if (pkg.version === next) continue;
  pkg.version = next;
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${p} -> ${next}`);
}
