import { describe, it, expect } from "vitest";
import { applyEnvFingerprint } from "../../open-sse/utils/opencodeFingerprint.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const CREDS = { connectionId: "opencode-env-test" };

describe("OpenCode free-tier <env> marker", () => {
  it("appends the marker to a Responses instructions string without replacing it", () => {
    const body = { instructions: "caller prompt" };
    expect(applyEnvFingerprint(body, true)).toBe(true);
    expect(body.instructions).toContain("caller prompt");
    expect(body.instructions).toContain("<env>");
    expect(body.instructions).toContain("</env>");
  });

  it("appends once, and leaves a genuine opencode client passthrough", () => {
    const body = { instructions: "" };
    expect(applyEnvFingerprint(body, true)).toBe(true);
    const once = body.instructions;
    expect(applyEnvFingerprint(body, true)).toBe(false);
    expect(body.instructions).toBe(once);
    expect((once.match(/<env>/g) || []).length).toBe(1);
  });

  it("appends to chat system messages and never injects role:system on claude shape", () => {
    const chat = { messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(chat, false)).toBe(true);
    expect(chat.messages[0].role).toBe("system");
    expect(chat.messages[0].content).toContain("<env>");

    const claude = { messages: [{ role: "user", content: "hi" }], system: "caller" };
    expect(applyEnvFingerprint(claude, false, { claude: true })).toBe(true);
    expect(claude.system).toContain("caller");
    expect(claude.system).toContain("<env>");
    expect(claude.messages[0].role).toBe("user");
  });

  it("fails open on a surprising body", () => {
    expect(applyEnvFingerprint(null, false)).toBe(false);
    expect(applyEnvFingerprint({ instructions: { not: "a string" } }, true)).toBe(false);
    expect(applyEnvFingerprint({}, false)).toBe(false);
  });

  it("lands on all three request shapes through transformRequest", () => {
    const executor = new OpenCodeExecutor();

    const responses = executor.transformRequest("muse-spark-1.3-contributor-free", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }, true, CREDS);
    expect(responses.instructions).toContain("<env>");
    expect(responses.tools.map((t) => t.name)).toEqual(["read", "shell"]);

    const chat = executor.transformRequest("big-pickle", {
      messages: [{ role: "user", content: "hi" }],
    }, true, CREDS);
    expect(chat.messages[0].content).toContain("<env>");
    expect(chat.tools.map((t) => t.function?.name)).toEqual(["read", "shell"]);

    const messages = executor.transformRequest("union-alpha", {
      messages: [{ role: "user", content: "hi" }],
      system: "caller",
    }, true, CREDS);
    expect(messages.system).toContain("<env>");
    // /messages rejects the chat fingerprint stubs.
    expect(messages.tools ?? []).toEqual([]);
  });
});
