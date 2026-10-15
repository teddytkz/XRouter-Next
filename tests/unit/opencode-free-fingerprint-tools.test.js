import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

// Break caught: opencode/*-free returns HTTP 403 FreeTierError ("OpenCode's free
// tier can only be used from within OpenCode") unless the request body declares
// a lowercase `read` tool whose `parameters.properties` map is non-empty.
//
// Live upstream probes (OpenCode v2, /inference/v1) isolated the exact rules:
//   - `read` (lowercase, exact) is mandatory; `Read`/`READ` do not satisfy it.
//   - Every declaration named one of the reserved lowercase set
//     (read/write/edit/glob/grep/bash/shell) must carry a non-empty properties
//     map. `properties: {}` answers 403; `properties: {x:{}}` passes.
//   - Case variants such as `Bash` are NOT reserved, so they travel untouched.
//     The old code lowercased them, which turned a passing `Bash` into a
//     reserved `bash` that then failed the schema check.
//   - Duplicate declarations of one name answer 400.
//
// The free Chat Completions models (big-pickle, nemotron-*-free, …) hit the same
// gate at /inference/v1/chat/completions and take the nested tool shape.
const FREE_13 = "muse-spark-1.3-contributor-free";
const CREDS = { connectionId: "opencode-free-fingerprint-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
const FINGERPRINT = ["read", "shell"];

const tool = (name, properties = {}) => ({
  type: "function",
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties },
});

function transform(model, tools) {
  const body = { model, input: structuredClone(INPUT) };
  if (tools !== undefined) body.tools = structuredClone(tools);
  return new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
}

const names = (out) => out.tools.map((t) => t.name);
const find = (out, name) => out.tools.find((t) => t.name === name);
const hasProps = (t) => Object.keys(t.parameters.properties).length > 0;

describe("opencode Free tier fingerprint tools", () => {
  it("adds the fingerprint pair when the client sends no tools", () => {
    const out = transform(FREE_13, undefined);
    expect(names(out)).toEqual(FINGERPRINT);
  });

  it("adds the fingerprint pair when the client sends an empty tools array", () => {
    const out = transform(FREE_13, []);
    expect(names(out)).toEqual(FINGERPRINT);
  });

  it("appends the pair without touching the client's own tools", () => {
    const out = transform(FREE_13, [tool("get_weather")]);
    expect(names(out)).toEqual(["get_weather", ...FINGERPRINT]);
  });

  it("does not duplicate tools the client already declared", () => {
    const out = transform(FREE_13, [tool("read", { path: { type: "string" } }), tool("shell", { command: { type: "string" } }), tool("get_weather")]);
    expect(names(out)).toEqual(["read", "shell", "get_weather"]);
  });

  it("adds only the missing fingerprint member", () => {
    expect(names(transform(FREE_13, [tool("read", { path: { type: "string" } })]))).toEqual(["read", "shell"]);
    expect(names(transform(FREE_13, [tool("shell", { command: { type: "string" } })]))).toEqual(["shell", "read"]);
  });

  it("leaves the caller's capitalized tools alone (they are not reserved)", () => {
    const out = transform(FREE_13, [tool("Bash"), tool("Read"), tool("Glob")]);
    expect(names(out)).toEqual(["Bash", "Read", "Glob", ...FINGERPRINT]);
  });

  it("fills a non-empty properties map on a reserved name that arrived empty", () => {
    const out = transform(FREE_13, [tool("read")]);
    const read = find(out, "read");
    expect(hasProps(read)).toBe(true);
  });

  it("fills every reserved name that arrived with an empty schema", () => {
    const out = transform(FREE_13, [tool("bash"), tool("glob"), tool("grep"), tool("edit"), tool("write")]);
    for (const name of ["bash", "glob", "grep", "edit", "write"]) {
      expect(hasProps(find(out, name))).toBe(true);
    }
  });

  it("drops duplicate declarations of one name (upstream answers 400)", () => {
    const out = transform(FREE_13, [tool("get_weather"), tool("get_weather")]);
    expect(names(out).filter((n) => n === "get_weather")).toHaveLength(1);
  });

  it("emits the appended pair in the flat Responses shape with real schemas", () => {
    const out = transform(FREE_13, undefined);
    for (const stub of out.tools) {
      expect(stub.type).toBe("function");
      expect("function" in stub).toBe(false);
      expect(stub.strict).toBe(false);
      expect(stub.parameters.type).toBe("object");
      expect(hasProps(stub)).toBe(true);
    }
  });

  it("marks the appended pair as inert in the Responses instructions", () => {
    const out = transform(FREE_13, [tool("get_weather")]);
    expect(out.instructions).toMatch(/placeholder/i);
  });

  it("applies to the other free Muse Spark model too", () => {
    const out = transform("muse-spark-1.2-contributor-free", undefined);
    expect(names(out)).toEqual(FINGERPRINT);
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
// nemotron-*-free, …) at /inference/v1/chat/completions. That endpoint takes the
// nested tool shape — a flat tool there is a 500 "Internal server error".
describe("opencode Free tier fingerprint tools on Chat Completions", () => {
  const chatTransform = (model, tools) => {
    const body = { model, messages: [{ role: "user", content: "hi" }] };
    if (tools !== undefined) body.tools = structuredClone(tools);
    return new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
  };
  const chatNames = (out) => out.tools.map((t) => t.function?.name);
  const chatHasProps = (t) => Object.keys(t.function.parameters.properties).length > 0;
  const CHAT_TOOL = (name, properties = {}) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties } } });

  it("adds the nested fingerprint pair for a free chat model", () => {
    const out = chatTransform("big-pickle", undefined);
    expect(chatNames(out)).toEqual(FINGERPRINT);
    for (const stub of out.tools) {
      expect(stub.type).toBe("function");
      expect(stub.parameters).toBeUndefined();
      expect(chatHasProps(stub)).toBe(true);
      expect(stub.function.description).toMatch(/read|shell/i);
    }
  });

  it("keeps the client's chat tools and appends the pair", () => {
    const out = chatTransform("nemotron-3-ultra-free", [CHAT_TOOL("get_weather")]);
    expect(chatNames(out)).toEqual(["get_weather", ...FINGERPRINT]);
  });

  it("does not duplicate nested tools the client already declared", () => {
    const out = chatTransform("big-pickle", [CHAT_TOOL("read", { path: { type: "string" } }), CHAT_TOOL("shell", { command: { type: "string" } })]);
    expect(chatNames(out)).toEqual(FINGERPRINT);
  });

  it("fills an empty properties map on a nested reserved name", () => {
    const out = chatTransform("big-pickle", [CHAT_TOOL("read")]);
    const read = out.tools.find((t) => t.function?.name === "read");
    expect(chatHasProps(read)).toBe(true);
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
