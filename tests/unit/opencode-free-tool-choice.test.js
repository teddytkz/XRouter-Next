import { describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "" } })),
}));

// Break caught: opencode/muse-spark-1.3-contributor-free returns HTTP 400 because
// upstream only accepts tool_choice "auto"; named function / "required" / "none"
// must be demoted at the Responses boundary (decolua/9router PR #4062).
const FREE_13 = "muse-spark-1.3-contributor-free";
const CREDS = { connectionId: "opencode-free-tool-choice-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
const TOOLS = [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: {} } }];

// The free tier also requires the fingerprint pair (read/shell) with non-empty
// schemas, appended after the client's own tools (see opencodeFingerprint.js).
// Assert structurally rather than duplicating the verbatim schema text.
const expectFingerprintPair = (tools) => {
  expect(tools.map((t) => t.name)).toEqual(["get_weather", "read", "shell"]);
  for (const name of ["read", "shell"]) {
    const t = tools.find((x) => x.name === name);
    expect(Object.keys(t.parameters.properties).length).toBeGreaterThan(0);
  }
};

function responsesBody(model, toolChoice) {
  const body = { model, input: structuredClone(INPUT), tools: structuredClone(TOOLS) };
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  return body;
}

describe("opencode Free 1.3 tool_choice auto-only", () => {
  it("declares the quirk for exactly the 1.3-Free model in the registry", () => {
    expect(PROVIDERS.opencode.quirks?.forceAutoToolChoiceModels).toEqual([FREE_13]);
  });

  it.each([
    ["Responses named", { type: "function", name: "get_weather" }],
    ["Chat function named", { type: "function", function: { name: "get_weather" } }],
    ["Claude tool named", { type: "tool", name: "get_weather" }],
    ["required", "required"],
    ["none", "none"],
  ])("demotes %s to auto (plain and (max) suffix)", (_label, choice) => {
    for (const model of [FREE_13, `${FREE_13}(max)`]) {
      const body = responsesBody(model, structuredClone(choice));
      const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
      expect(out.tool_choice).toBe("auto");
      expectFingerprintPair(out.tools);
      expect(out.input).toEqual(INPUT);
    }
  });

  it("keeps auto and absent untouched; tools/input intact", () => {
    const autoOut = new OpenCodeExecutor().transformRequest(
      FREE_13, responsesBody(FREE_13, "auto"), true, CREDS,
    );
    expect(autoOut.tool_choice).toBe("auto");
    expectFingerprintPair(autoOut.tools);
    expect(autoOut.input).toEqual(INPUT);

    const absentOut = new OpenCodeExecutor().transformRequest(
      FREE_13, responsesBody(FREE_13, undefined), true, CREDS,
    );
    expect(absentOut.tool_choice).toBe("auto");
    expectFingerprintPair(absentOut.tools);
    expect(absentOut.input).toEqual(INPUT);
  });

  it.each([
    ["1.2-Free", "muse-spark-1.2-contributor-free"],
    ["future 1.4-Free", "muse-spark-1.4-contributor-free"],
    ["Go id", "muse-spark-1.3-contributor"],
    ["non-Muse", "big-pickle"],
  ])("does not alter tool_choice of %s", (_label, model) => {
    const choice = { type: "function", name: "get_weather" };
    const body = responsesBody(model, structuredClone(choice));
    const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
    expect(out.tool_choice).toEqual(choice);
  });

  it("wire: execute sends choice auto to /inference/v1/responses", async () => {
    proxyAwareFetch.mockClear();
    const ex = new OpenCodeExecutor();
    const body = responsesBody(FREE_13, { type: "function", name: "get_weather" });
    const { url, transformedBody } = await ex.execute({
      model: FREE_13, body, stream: true, credentials: CREDS,
    });
    expect(url).toBe("https://opencode.ai/inference/v1/responses");
    expect(transformedBody.tool_choice).toBe("auto");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [actualUrl, actualInit] = proxyAwareFetch.mock.calls[0];
    expect(actualUrl).toBe("https://opencode.ai/inference/v1/responses");
    const sent = JSON.parse(actualInit.body);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.model).toBe(FREE_13);
    expectFingerprintPair(sent.tools);
    expect(sent.input).toEqual(INPUT);
  });
});
