import { describe, it, expect } from "vitest";
import { applyLoopGuard, needsTerminationPrompt } from "../../open-sse/handlers/chatCore.js";
import { injectTerminationPrompt, TERMINATION_PROMPT } from "../../open-sse/rtk/terminationPrompt.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function makeLoopingBody() {
  const call = { function: { name: "bash", arguments: '{"cmd":"ls"}' } };
  return {
    messages: [
      { role: "user", content: "list" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "file1" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "file1" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "file1" },
    ],
  };
}

describe("applyLoopGuard", () => {
  it("detects a repeated tool call and appends a hint to the last tool message", () => {
    const body = makeLoopingBody();
    expect(applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6")).toBe(true);
    const last = body.messages[body.messages.length - 1];
    expect(last.role).toBe("tool");
    expect(last.content).toContain("[ROUTER NOTE:");
    expect(last.content).toContain("STOP repeating");
  });

  it("injects the termination prompt into the system message", () => {
    const body = makeLoopingBody();
    applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6");
    const sys = body.messages.find((m) => m.role === "system");
    expect(sys.content).toContain("STOP calling tools");
  });

  it("is idempotent", () => {
    const body = makeLoopingBody();
    applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6");
    const afterFirst = body.messages[body.messages.length - 1].content;
    applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6");
    expect(body.messages[body.messages.length - 1].content).toBe(afterFirst);
  });

  it("does not fire on a clean conversation", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    expect(applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6")).toBe(false);
    expect(JSON.stringify(body.messages)).not.toContain("[ROUTER NOTE:");
  });

  it("fires on a repeated assistant message", () => {
    const repeated = "Subagent gagal. Saya cek langsung.";
    const body = {
      messages: [
        { role: "user", content: "cek ros2 project" },
        { role: "assistant", content: repeated },
        { role: "assistant", content: repeated },
        { role: "assistant", content: repeated },
      ],
    };
    expect(applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6")).toBe(true);
    expect(body.messages[body.messages.length - 1].content).toContain("[ROUTER NOTE:");
  });

  it("does not fire on varied assistant messages", () => {
    const body = {
      messages: [
        { role: "user", content: "explore" },
        { role: "assistant", content: "I will check the package.xml file first." },
        { role: "assistant", content: "The package is a ROS2 navigation stack." },
        { role: "assistant", content: "It uses nav2 and tf2 libraries." },
      ],
    };
    expect(applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6")).toBe(false);
  });
});

describe("injectTerminationPrompt", () => {
  it("OpenAI: appends to the existing system message", () => {
    const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
    injectTerminationPrompt(body, FORMATS.OPENAI);
    expect(body.messages[0].content).toContain(TERMINATION_PROMPT);
    expect(body.messages[0].content).toContain("You are helpful.");
  });

  it("OpenAI: creates a system message when none exists", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectTerminationPrompt(body, FORMATS.OPENAI);
    expect(body.messages[0]).toEqual({ role: "system", content: TERMINATION_PROMPT });
  });

  it("Claude: appends to a system string and pushes to a block array", () => {
    const asString = { system: "Be concise.", messages: [] };
    injectTerminationPrompt(asString, FORMATS.CLAUDE);
    expect(asString.system).toContain("Be concise.");
    expect(asString.system).toContain(TERMINATION_PROMPT);

    const asBlocks = { system: [{ type: "text", text: "existing" }], messages: [] };
    injectTerminationPrompt(asBlocks, FORMATS.CLAUDE);
    expect(asBlocks.system).toHaveLength(2);
  });

  it("Gemini: pushes into system_instruction.parts", () => {
    const body = { system_instruction: { parts: [{ text: "existing" }] }, contents: [] };
    injectTerminationPrompt(body, FORMATS.GEMINI);
    expect(body.system_instruction.parts).toHaveLength(2);
  });

  it("is idempotent", () => {
    const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
    injectTerminationPrompt(body, FORMATS.OPENAI);
    injectTerminationPrompt(body, FORMATS.OPENAI);
    expect(body.messages[0].content.split(TERMINATION_PROMPT).length - 1).toBe(1);
  });

  it("cursor bodies are left alone", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectTerminationPrompt(body, FORMATS.CURSOR);
    expect(JSON.stringify(body)).not.toContain("STOP calling tools");
  });
});

describe("needsTerminationPrompt", () => {
  it("gates on Kimi models only", () => {
    expect(needsTerminationPrompt("kimi", "kimi-k2.6")).toBe(true);
    expect(needsTerminationPrompt("nvidia", "moonshotai/kimi-k2.7")).toBe(true);
    expect(needsTerminationPrompt("openai", "gpt-5.5")).toBe(false);
  });
});
