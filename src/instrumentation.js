export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Proactive OAuth token refresh. Must start from instrumentation (runs once
    // per server process); app/layout.js is prerendered at build time, so its
    // initializeApp bootstrap never executes in a production server.
    const { startBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
    startBackgroundTokenRefresh();
  }
}
