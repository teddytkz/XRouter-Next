/**
 * GITHUB_CONFIG / UPDATER_CONFIG — repo wiring regression guard.
 *
 * This fork lives at teddytkz/XRouter-Next and ships from the `development`
 * branch. The default `master` branch still tracks the stale upstream
 * `9router-app` tree, and the old changelog URL pointed at `decolua/9router`
 * (the original project). Both would send users to the wrong place, so pin the
 * correct repo/branch here.
 */

import { describe, it, expect } from "vitest";
import { GITHUB_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config.js";

describe("GITHUB_CONFIG", () => {
  it("points the changelog at this fork on the development branch", () => {
    expect(GITHUB_CONFIG.repo).toBe("teddytkz/XRouter-Next");
    expect(GITHUB_CONFIG.branch).toBe("development");
    expect(GITHUB_CONFIG.changelogUrl).toBe(
      "https://raw.githubusercontent.com/teddytkz/XRouter-Next/refs/heads/development/CHANGELOG.md"
    );
  });

  it("no longer references the upstream decolua/9router repo", () => {
    expect(GITHUB_CONFIG.changelogUrl).not.toContain("decolua/9router");
    expect(GITHUB_CONFIG.changelogUrl).toContain("teddytkz/XRouter-Next");
  });
});

describe("UPDATER_CONFIG", () => {
  it("ships the xrouter-next npm package", () => {
    expect(UPDATER_CONFIG.npmPackageName).toBe("xrouter-next");
    expect(UPDATER_CONFIG.installCmd).toBe("npm i -g xrouter-next");
    expect(UPDATER_CONFIG.installCmdLatest).toContain("xrouter-next@latest");
  });

  it("records the GitHub repo/branch for reference only", () => {
    expect(UPDATER_CONFIG.githubRepo).toBe("teddytkz/XRouter-Next");
    expect(UPDATER_CONFIG.githubBranch).toBe("development");
  });

  it("never builds an install command from a missing tarballUrl", () => {
    expect(UPDATER_CONFIG).not.toHaveProperty("tarballUrl");
    expect(UPDATER_CONFIG.installCmd).not.toContain("undefined");
  });
});
