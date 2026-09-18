export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
    // The Zen free tier gates on `stream:true` in the BODY (a stream:false or
    // absent body is a 403 FreeTierError even with the bash+read tools). Clients
    // asking for JSON still get JSON — chatCore reshapes the SSE back
    // (handleForcedSSEToJson).
    forceStream: true,
    quirks: {
      // Muse Spark 1.3 Free rejects any tool_choice other than "auto" with HTTP 400
      // (named function / "required" / "none"). Demoted at the Responses boundary
      // in OpenCodeExecutor.transformRequest (PR #4062).
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Endpoint formats differ per model, so declare non-chat models explicitly:
    // Muse Spark → /zen/v1/responses, Union Alpha → /zen/v1/messages (PR #4099).
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
