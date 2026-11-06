import { describe, it, expect, vi, beforeEach } from "vitest";

const { tlsFetchMock, proxyFetchMock } = vi.hoisted(() => ({
  tlsFetchMock: vi.fn(),
  proxyFetchMock: vi.fn(),
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
  OpencodeTlsUnavailableError: class OpencodeTlsUnavailableError extends Error {},
  resetOpencodeTlsSession: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyFetchMock,
}));

import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const RESPONSE = () => new Response("{}", {
  status: 200,
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  tlsFetchMock.mockReset();
  proxyFetchMock.mockReset();
  proxyFetchMock.mockResolvedValue(RESPONSE());
});

describe("OpenCode free-tier TLS transport", () => {
  it("hands a directFetch override to proxyAwareFetch", async () => {
    const executor = new OpenCodeExecutor();
    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { connectionId: "tls-wiring-test" },
    });

    expect(result.headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const [, options] = proxyFetchMock.mock.calls[0];
    expect(typeof options.directFetch).toBe("function");
    expect(options.directFetch.requiresDirectTransport).toBe(true);
  });

  it("routes the direct path through the impersonated TLS client, with body and signal", async () => {
    const executor = new OpenCodeExecutor();
    await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { connectionId: "tls-wiring-test" },
    });

    const [url, options] = proxyFetchMock.mock.calls[0];
    const signal = options.signal;
    tlsFetchMock.mockResolvedValue(RESPONSE());
    await options.directFetch(url, options);

    expect(tlsFetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init, meta] = tlsFetchMock.mock.calls[0];
    expect(calledUrl).toContain("https://opencode.ai/inference/v1/");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(options.body);
    expect(init.headers["x-opencode-session"]).toBe(options.headers["x-opencode-session"]);
    expect(meta.signal).toBe(signal);
  });
});
