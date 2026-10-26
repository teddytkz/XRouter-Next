import { describe, expect, it } from "vitest";
import {
  neutralizeCodeBuddyChannelIdentity,
  compactOversizedTools,
  captureRotatedToken,
} from "../../open-sse/executors/codebuddyShared.js";

describe("codebuddy channel neutralization", () => {
  it("rewrites rival identity lines in assistant history but not user text", () => {
    const messages = [
      { role: "user", content: "You are Claude Code, Anthropic's official CLI for Claude" },
      { role: "assistant", content: "You are Claude Code, Anthropic's official CLI for Claude" },
      { role: "assistant", content: [{ type: "text", text: "You are Cursor, an IDE." }] },
    ];
    const out = neutralizeCodeBuddyChannelIdentity(messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[1].content).toContain("CodeBuddy Code");
    expect(out[1].content).not.toContain("Claude Code");
    expect(out[2].content[0].text).toContain("CodeBuddy Code");
  });

  it("leaves non-matching content and tool messages untouched", () => {
    const messages = [
      { role: "system", content: "plain instructions" },
      { role: "tool", content: "You are Cursor, an IDE." },
    ];
    expect(neutralizeCodeBuddyChannelIdentity(messages)).toEqual(messages);
    expect(neutralizeCodeBuddyChannelIdentity(null)).toBe(null);
  });
});

describe("codebuddy tool compaction", () => {
  it("drops descriptions only when the metadata crosses 64KB", () => {
    const tool = (n) => ({
      type: "function",
      function: { name: `t${n}`, description: "x".repeat(1000), parameters: { type: "object" } },
    });
    const small = [tool(0)];
    expect(compactOversizedTools(small)).toBe(small);

    const big = Array.from({ length: 70 }, (_, i) => tool(i));
    const out = compactOversizedTools(big);
    expect(out.every((t) => t.function.description === undefined)).toBe(true);
    expect(out.every((t) => t.function.name.startsWith("t"))).toBe(true);
  });
});

describe("codebuddy rotated token capture", () => {
  it("adopts a new Bearer token from response headers", () => {
    const credentials = { accessToken: "old" };
    captureRotatedToken({ headers: new Headers({ authorization: "Bearer new-token" }) }, credentials);
    expect(credentials.accessToken).toBe("new-token");
  });

  it("ignores a missing or unchanged token", () => {
    const credentials = { accessToken: "same" };
    captureRotatedToken({ headers: new Headers({ authorization: "Bearer same" }) }, credentials);
    captureRotatedToken({ headers: new Headers() }, credentials);
    expect(credentials.accessToken).toBe("same");
  });
});
