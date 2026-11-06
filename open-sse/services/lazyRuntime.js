// Lazy loader for optional runtime deps (wreq-js). Resolution order:
// app node_modules → <DATA_DIR>/runtime → pinned npm install into that dir.
// Never throws at import time; failures surface from loadRuntimeDep().

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json optionalDependencies. Pinned, never "latest".
const LAZY_DEP_VERSIONS = {
  "wreq-js": "3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

// A static node:module import gets stubbed by the server bundler, so
// createRequire must be fetched at runtime for published builds to work.
let createRequirePromise;
function getCreateRequire() {
  createRequirePromise ??= import(/* webpackIgnore: true */ "node:module").then((mod) => mod.createRequire);
  return createRequirePromise;
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  // Anchor npm to the runtime dir so it can't adopt a parent package.json as install root.
  const manifest = path.join(cwd, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: "9router-runtime", private: true }, null, 2));
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

async function installIntoRuntime(pkg, version) {
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
}

const inflight = new Map();

async function load(pkg) {
  // An unknown package must never trigger an npm install from a caller-controlled name.
  const version = LAZY_DEP_VERSIONS[pkg];
  if (!version) throw new Error(`Unsupported runtime dependency: ${pkg}`);

  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  const createRequire = await getCreateRequire();
  const runtimeRequire = createRequire(path.join(getRuntimeDir(), "package.json"));
  try {
    return await import(/* webpackIgnore: true */ pathToFileURL(runtimeRequire.resolve(pkg)).href);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then import from the runtime dir.
  const runtimeImport = () => import(/* webpackIgnore: true */ pathToFileURL(runtimeRequire.resolve(pkg)).href);
  await installIntoRuntime(pkg, version);
  try {
    return await runtimeImport();
  } catch (error) {
    // npm exits 0 even on partially-extracted installs; wipe and retry once.
    if (!isModuleMissing(error)) throw error;
    fs.rmSync(path.join(getRuntimeDir(), "node_modules", pkg), { recursive: true, force: true });
    await installIntoRuntime(pkg, version);
    return runtimeImport();
  }
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
