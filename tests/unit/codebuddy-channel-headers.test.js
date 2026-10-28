import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";

// The CodeBuddy gateways (CN + intl) run a per-request channel check. Without
// the official plugin's request/conversation identifiers upstream rejects the
// call with 400 / 11128 "request illegal" ("failed channel verification").
// These tests lock the header wiring so the ids cannot silently disappear.
const REQUIRED = [
  "X-Request-ID",
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
];

const CREDS = { accessToken: "TESTTOKEN", apiKey: null };

function buildHeaders(id, body = {}) {
  const executor = getExecutor(id);
  return executor.buildHeaders(CREDS, true, PROVIDERS[id].baseUrl, "deepseek-v4.1-flash", body);
}

describe("codebuddy channel headers", () => {
  for (const id of ["codebuddy-intl", "codebuddy-cn"]) {
    describe(id, () => {
      it("registers the codebuddyHeaders hook", () => {
        expect(PROVIDERS[id]?.auth?.hooks).toContain("codebuddyHeaders");
      });

      it("sends the plugin request/conversation ids", () => {
        const headers = buildHeaders(id);
        for (const key of REQUIRED) {
          expect(typeof headers[key], `${id} must send ${key}`).toBe("string");
          expect(headers[key].length).toBeGreaterThan(0);
        }
      });

      it("still applies the bearer token after the hook runs", () => {
        expect(buildHeaders(id).Authorization).toBe("Bearer TESTTOKEN");
      });

      it("issues fresh request ids per call", () => {
        const a = buildHeaders(id);
        const b = buildHeaders(id);
        expect(a["X-Request-ID"]).not.toBe(b["X-Request-ID"]);
        expect(a["X-Conversation-Request-ID"]).not.toBe(b["X-Conversation-Request-ID"]);
      });
    });
  }

  it("ties all three conversation ids to one request on the CN hook", () => {
    const h = buildHeaders("codebuddy-cn");
    expect(h["X-Conversation-Request-ID"]).toBe(h["X-Request-ID"]);
    expect(h["X-Conversation-Message-ID"]).toBe(h["X-Request-ID"]);
    expect(h["X-Conversation-ID"]).not.toBe(h["X-Request-ID"]);
  });

  // The intl executor deliberately derives a STABLE conversation id from the
  // session key so retries and account rotation keep one turn; the CN hook's
  // one-request-id-for-everything shape must not replace it.
  it("keeps the fork's stable intl conversation id while still sending X-Request-ID", () => {
    const body = { session_id: "turn-42" };
    const a = buildHeaders("codebuddy-intl", body);
    const b = buildHeaders("codebuddy-intl", body);
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    expect(a["X-Request-ID"]).not.toBe(b["X-Request-ID"]);
    expect(a["X-Conversation-ID"]).not.toBe(a["X-Request-ID"]);
  });
});
