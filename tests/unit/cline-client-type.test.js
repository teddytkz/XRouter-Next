import { describe, expect, it } from "vitest";

import { buildClineHeaders } from "../../open-sse/shared/clineAuth.js";

describe("cline headers", () => {
  it("identifies as the Cline client, never as the router", () => {
    // Upstream 403s cline-free/* ("only available via Cline product surfaces")
    // for any other X-CLIENT-TYPE. Regression guard for that gate.
    expect(buildClineHeaders("tok")["X-CLIENT-TYPE"]).toBe("cline");
  });

  it("prefixes workos: once", () => {
    expect(buildClineHeaders("tok").Authorization).toBe("Bearer workos:tok");
    expect(buildClineHeaders("workos:tok").Authorization).toBe("Bearer workos:tok");
  });

  it("omits Authorization without a token", () => {
    expect(buildClineHeaders("")).not.toHaveProperty("Authorization");
  });
});
