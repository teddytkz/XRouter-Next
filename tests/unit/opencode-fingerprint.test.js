import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  ensureReservedToolSchemas,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
  OPENCODE_RESERVED_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));
const propsOf = (tool) => (tool.function ?? tool).parameters?.properties ?? {};
const names = (tools) => tools.map((tool) => (tool.function?.name ?? tool.name));

describe("opencodeFingerprint — request side", () => {
  it("appends the fingerprint pair when the body carries no tools", () => {
    const body = { tools: [] };
    applyFingerprintTools(body, true);

    expect(names(body.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(body.tool_choice).toBe("auto");
  });

  it("gives the appended pair a non-empty properties map", () => {
    const body = {};
    applyFingerprintTools(body, true);

    for (const tool of body.tools) {
      expect(Object.keys(propsOf(tool)).length).toBeGreaterThan(0);
    }
  });

  it("never defaults a chat tool_choice to none (the gate reads it as not-from-CLI)", () => {
    const body = {};
    applyFingerprintTools(body, false);
    expect(body.tool_choice).toBeUndefined();
  });

  it("does not invent a chat tool_choice when the caller already supplied tools", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);
    expect(body.tool_choice).toBeUndefined();
  });

  it("appends only the missing fingerprint member", () => {
    const body = { tools: flat(["read", "terminal"]) };
    applyFingerprintTools(body, true);
    expect(names(body.tools)).toEqual(["read", "terminal", "shell"]);
  });

  it("preserves the caller's capitalized tools verbatim", () => {
    const body = { tools: flat(["Bash", "Read", "Glob", "Grep", "Edit"]) };
    applyFingerprintTools(body, true);

    // `Read` is not the reserved lowercase `read`, so the pair is appended and
    // the caller's casing is untouched (upstream accepts it alongside `read`).
    expect(names(body.tools)).toEqual(["Bash", "Read", "Glob", "Grep", "Edit", "read", "shell"]);
  });

  it("records an empty rename map (no renames happen any more)", () => {
    const body = { tools: flat(["Bash"]) };
    const map = applyFingerprintTools(body, true);
    expect(map.size).toBe(0);
    expect(takeRenamedToolNames(body)).toBeNull();
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => ensureReservedToolSchemas(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
      expect(() => applyFingerprintTools({ tools }, true)).not.toThrow();
    }
  });
});

describe("ensureReservedToolSchemas", () => {
  it("fills an empty properties map on a reserved lowercase name", () => {
    const out = ensureReservedToolSchemas(flat(["read"]));
    expect(Object.keys(propsOf(out[0])).length).toBeGreaterThan(0);
  });

  it("fills every reserved name in the set", () => {
    const out = ensureReservedToolSchemas(flat(OPENCODE_RESERVED_TOOLS));
    for (const tool of out) {
      expect(Object.keys(propsOf(tool)).length).toBeGreaterThan(0);
    }
  });

  it("leaves a non-reserved name with an empty schema alone", () => {
    const out = ensureReservedToolSchemas(flat(["get_weather"]));
    expect(propsOf(out[0])).toEqual({});
  });

  it("leaves a reserved name with a real schema untouched", () => {
    const tool = { type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } };
    const out = ensureReservedToolSchemas([tool]);
    expect(out[0]).toBe(tool);
  });

  it("does not treat capitalized variants as reserved", () => {
    const out = ensureReservedToolSchemas(flat(["Read", "Bash"]));
    expect(propsOf(out[0])).toEqual({});
    expect(propsOf(out[1])).toEqual({});
  });

  it("drops duplicate declarations of one name", () => {
    const out = ensureReservedToolSchemas(flat(["get_weather", "get_weather", "read", "read"]));
    expect(names(out)).toEqual(["get_weather", "read"]);
  });

  it("handles the nested chat shape", () => {
    const out = ensureReservedToolSchemas(chat(["read"]));
    expect(Object.keys(propsOf(out[0])).length).toBeGreaterThan(0);
    expect(out[0].function.name).toBe("read");
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("matches reserved names case-sensitively and rejects everything else", () => {
    expect(fingerprintToolKey("read")).toBe("read");
    expect(fingerprintToolKey(" read ")).toBe("read");
    expect(fingerprintToolKey("bash")).toBe("bash");
    expect(fingerprintToolKey("shell")).toBe("shell");
    expect(fingerprintToolKey("Read")).toBe("");
    expect(fingerprintToolKey("Bash")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});
