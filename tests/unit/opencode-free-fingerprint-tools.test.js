import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

// Break caught: opencode/muse-spark-*-contributor-free returns HTTP 403
// FreeTierError ("OpenCode's free tier can only be used from within OpenCode")
// unless the request body declares a tool named "bash" AND a tool named "read",
// exact and lowercase. Clients such as Claude Code send capitalized Bash/Read,
// which do not satisfy the gate. Verified by A/B replay against
// https://opencode.ai/zen/v1/responses:
//
//   no tools / tools:[] / 1 tool / bash+edit / read+grep  -> 403
//   bash+read / bash+read+anything else                   -> 200
const FREE_13 = "muse-spark-1.3-contributor-free";
const CREDS = { connectionId: "opencode-free-fingerprint-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

const tool = (name) => ({
  type: "function",
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
});

function transform(model, tools) {
  const body = { model, input: structuredClone(INPUT) };
  if (tools !== undefined) body.tools = structuredClone(tools);
  return new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
}

const names = (out) => out.tools.map((t) => t.name);

describe("opencode Free tier fingerprint tools", () => {
  it("adds both stubs when the client sends no tools", () => {
    const out = transform(FREE_13, undefined);
    expect(names(out)).toEqual(["bash", "read"]);
  });

  it("adds both stubs when the client sends an empty tools array", () => {
    const out = transform(FREE_13, []);
    expect(names(out)).toEqual(["bash", "read"]);
  });

  it("keeps the client's capitalized tools and adds the lowercase stubs", () => {
    const out = transform(FREE_13, [tool("Bash"), tool("Read")]);
    expect(names(out)).toEqual(["Bash", "Read", "bash", "read"]);
  });

  it("adds both stubs for a non-matching real tool", () => {
    const out = transform(FREE_13, [tool("get_weather")]);
    expect(names(out)).toEqual(["get_weather", "bash", "read"]);
  });

  it("does not duplicate tools the client already sent lowercase", () => {
    const out = transform(FREE_13, [tool("bash"), tool("read"), tool("get_weather")]);
    expect(names(out)).toEqual(["bash", "read", "get_weather"]);
  });

  it("adds only the missing half of the pair", () => {
    expect(names(transform(FREE_13, [tool("bash")]))).toEqual(["bash", "read"]);
    expect(names(transform(FREE_13, [tool("read")]))).toEqual(["read", "bash"]);
  });

  it("emits stubs in the flat Responses shape with a valid object schema", () => {
    const [bash, read] = transform(FREE_13, undefined).tools;
    for (const stub of [bash, read]) {
      expect(stub.type).toBe("function");
      expect(stub.description).toMatch(/must never be invoked/);
      expect(stub.parameters).toEqual({ type: "object", properties: {} });
      expect("function" in stub).toBe(false);
    }
  });

  it("applies to the other free Muse Spark model too", () => {
    const out = transform("muse-spark-1.2-contributor-free", undefined);
    expect(names(out)).toEqual(["bash", "read"]);
  });

  it("leaves the paid opencode-go executor alone", async () => {
    const { OpenCodeGoExecutor } = await import("../../open-sse/executors/opencode-go.js");
    const out = new OpenCodeGoExecutor().transformRequest(
      "muse-spark-1.3-contributor",
      { model: "muse-spark-1.3-contributor", input: structuredClone(INPUT) },
      true,
      { connectionId: "opencode-go-fingerprint-test" },
    );
    expect(out.tools ?? []).toEqual([]);
  });
});

// The same gate guards the free Chat Completions models (big-pickle,
// nemotron-*-free, …) at /zen/v1/chat/completions. That endpoint takes the
// nested tool shape — a flat tool there is a 500 "Internal server error".
describe("opencode Free tier fingerprint tools on Chat Completions", () => {
  const chatTransform = (model, tools) => {
    const body = { model, messages: [{ role: "user", content: "hi" }] };
    if (tools !== undefined) body.tools = structuredClone(tools);
    return new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
  };
  const chatNames = (out) => out.tools.map((t) => t.function?.name);
  const CHAT_TOOL = (name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } });

  it("adds both nested stubs for a free chat model", () => {
    const out = chatTransform("big-pickle", undefined);
    expect(chatNames(out)).toEqual(["bash", "read"]);
    for (const stub of out.tools) {
      expect(stub.type).toBe("function");
      expect(stub.parameters).toBeUndefined();
      expect(stub.function.parameters).toEqual({ type: "object", properties: {} });
      expect(stub.function.description).toMatch(/must never be invoked/);
    }
  });

  it("keeps the client's chat tools and appends the stubs", () => {
    const out = chatTransform("nemotron-3-ultra-free", [CHAT_TOOL("get_weather")]);
    expect(chatNames(out)).toEqual(["get_weather", "bash", "read"]);
  });

  it("does not duplicate nested tools already named bash/read", () => {
    const out = chatTransform("big-pickle", [CHAT_TOOL("bash"), CHAT_TOOL("read")]);
    expect(chatNames(out)).toEqual(["bash", "read"]);
  });

  it("does not touch the Anthropic Messages model", () => {
    const out = chatTransform("union-alpha", undefined);
    expect(out.tools ?? []).toEqual([]);
  });

  it("forces stream:true — the gate 403s without it in the body", () => {
    for (const model of ["big-pickle", "nemotron-3-ultra-free"]) {
      expect(chatTransform(model, undefined).stream).toBe(true);
    }
  });
});
