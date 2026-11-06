import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// A local origin keeps this deterministic: no DNS, no egress, no proxy env.
async function withLocalServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    return await run(url);
  } finally {
    server.close();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("proxyFetch directFetch fail-open", () => {
  it("replays on native fetch when a TLS transport cannot load its optional dep", async () => {
    await withLocalServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }, async (url) => {
      const unavailable = Object.assign(new Error("wreq-js unavailable"), { directFetchFailOpen: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const directFetch = vi.fn().mockRejectedValue(unavailable);

      const res = await proxyAwareFetch(url, { method: "POST", body: "{}", directFetch });

      expect(directFetch).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("propagates other directFetch errors instead of silently bypassing TLS", async () => {
    await withLocalServer((_req, res) => res.end("should not be reached"), async (url) => {
      const directFetch = vi.fn().mockRejectedValue(new Error("upstream said 500"));
      await expect(proxyAwareFetch(url, {
        method: "POST",
        body: "{}",
        directFetch,
      })).rejects.toThrow("upstream said 500");
    });
  });

  for (const [name, proxyOptions] of [
    ["Vercel relay", { vercelRelayUrl: "https://relay.invalid" }],
    ["standard proxy pool", { url: "http://127.0.0.1:9", enabled: true, proxyPoolId: "pool" }],
  ]) {
    it(`keeps the impersonated TLS handshake when a ${name} is configured`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const directFetch = vi.fn().mockResolvedValue(new Response("tls"));
      directFetch.requiresDirectTransport = true;

      const res = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", {
        method: "POST", body: "{}", directFetch,
      }, proxyOptions);

      expect(await res.text()).toBe("tls");
      expect(directFetch).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();
    });
  }

  it("refuses to bypass a strict proxy for a transport that needs its own TLS", async () => {
    const directFetch = vi.fn().mockResolvedValue(new Response("tls"));
    directFetch.requiresDirectTransport = true;

    await expect(proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST", body: "{}", directFetch,
    }, { vercelRelayUrl: "https://relay.invalid", strictProxy: true })).rejects.toThrow("strictProxy=true");
    expect(directFetch).not.toHaveBeenCalled();
  });
});
