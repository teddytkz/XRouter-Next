import pkg from "../../../../package.json" with { type: "json" };
import { checkForUpdate, fetchNpmLatest, clearPluginUpdateCache } from "@/lib/updateCheck.js";
import { UPDATER_CONFIG } from "@/shared/constants/config.js";

// This fork is published to npm as `xrouter-next`, and that registry entry is
// the single source of truth for "is there a newer XRouter Next?".
//
// Do NOT compare against an upstream GitHub repo such as
// thunderkex/9router-extended: that repo tracks the *9Router Extended* line
// (0.5.65-extended, …), which sorts above this fork's 0.1.x versions forever.
// The result was a permanent phantom "↑ Update v0.5.65-extended" banner that
// no install could ever clear.
const PKG_NAME = UPDATER_CONFIG.npmPackageName || "xrouter-next";
const CACHE_KEY = `app:${PKG_NAME}`;

function buildPackageManagers(pkgName) {
  return {
    bun: `bun add -g ${pkgName}@latest`,
    npm: `npm i -g ${pkgName}@latest --prefer-online`,
    pnpm: `pnpm add -g ${pkgName}@latest`,
    yarn: `yarn global add ${pkgName}@latest`,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "true" || searchParams.get("force") === "1";
  if (force) {
    clearPluginUpdateCache(CACHE_KEY);
  }

  const currentVersion = pkg.version;
  const isBun = typeof process !== "undefined" && Boolean(process.versions?.bun);

  const packageManagers = buildPackageManagers(PKG_NAME);
  const defaultPkgManager = isBun ? "bun" : "npm";

  const result = await checkForUpdate(
    CACHE_KEY,
    currentVersion,
    () => fetchNpmLatest(PKG_NAME),
    force ? 0 : 3600000
  );

  return Response.json({
    ...result,
    packageName: PKG_NAME,
    updateCmd: packageManagers[defaultPkgManager],
    packageManagers,
    defaultPkgManager,
    detectedRuntime: isBun ? "bun" : "node",
  });
}


