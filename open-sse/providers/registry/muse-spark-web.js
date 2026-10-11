export default {
  id: "muse-spark-web",
  priority: 150,
  alias: "muse-spark-web",
  // NOTE: VansRouter maps the "muse" alias here (Meta AI web cookie). In this fork
  // "muse" already belongs to the Responses-based Meta Muse provider, so we do NOT
  // claim it — muse-spark-web stays reachable by its own id/alias only.
  uiAlias: "muse-spark-web",
  display: {
    name: "Muse Spark Web (Meta AI)",
    icon: "psychology",
    color: "#0064FF",
    textIcon: "MS",
    website: "https://www.meta.ai",
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your ecto_1_sess= cookie value from meta.ai",
  transport: {
    baseUrl: "https://www.meta.ai/api/graphql",
    format: "muse-spark-web",
    authType: "cookie",
  },
  models: [
    { id: "muse-spark", name: "Muse Spark" },
    { id: "muse-spark-thinking", name: "Muse Spark (Thinking)" },
    { id: "muse-spark-contemplating", name: "Muse Spark (Contemplating)" },
  ],
  passthroughModels: true,
};
