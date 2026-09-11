import { describe, expect, it } from "vitest";

import { buildClineHeaders } from "../../open-sse/shared/clineAuth.js";

describe("cline headers", () => {
  it("identifies as the Cline client, never as the router", () => {
    // Upstream 403s cline-free/* ("only available via Cline product surfaces")
    // for any other X-CLIENT-TYPE. Regression guard for that gate.
    expect(buildClineHeaders("tok")["X-CLIENT-TYPE"]).toBe("cline");
  });

  it("prefixes workos: once", () => {
    // Only WorkOS JWTs (base64url `eyJ…` header) get the prefix — ClinePass
    // API keys (clp_…) must go verbatim or api.cline.bot answers 401 (#2333).
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJwYXAiJ9";
    expect(buildClineHeaders(jwt).Authorization).toBe(`Bearer workos:${jwt}`);
    expect(buildClineHeaders(`workos:${jwt}`).Authorization).toBe(`Bearer workos:${jwt}`);
    expect(buildClineHeaders("clp_1234567890").Authorization).toBe("Bearer clp_1234567890");
  });

  it("omits Authorization without a token", () => {
    expect(buildClineHeaders("")).not.toHaveProperty("Authorization");
  });
});
