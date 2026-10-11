import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("settings password policy", () => {
  it("uses the strong password validator for dashboard password updates", () => {
    const source = readFileSync(join(REPO_ROOT, "src/app/api/settings/route.js"), "utf8");
    expect(source).toContain("isStrongInitialPassword");
    expect(source).toContain("newPassword");
  });

  it("login resolves the initial password through the policy module, not the raw env var", () => {
    const source = readFileSync(join(REPO_ROOT, "src/app/api/auth/login/route.js"), "utf8");
    // Regression guard: reading process.env.INITIAL_PASSWORD directly lets a weak
    // production value be accepted and issue a full remote session.
    expect(source).toContain("getInitialPassword");
    expect(source).toContain("isPlaceholderPassword");
    expect(source).not.toContain('process.env.INITIAL_PASSWORD ||');
  });

  it("dashboard session re-auth resolves the initial password through the policy module", () => {
    const source = readFileSync(join(REPO_ROOT, "src/lib/auth/dashboardSession.js"), "utf8");
    expect(source).toContain("getInitialPassword");
    expect(source).not.toContain('process.env.INITIAL_PASSWORD ||');
  });
});
