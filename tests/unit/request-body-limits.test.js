import { afterAll, describe, expect, it } from "vitest";

// Guardrail: oversized bodies are rejected before parse. Ported from VansRouter
// (RTK-threshold cases dropped — this fork has no RTK_MAX_BODY_BYTES yet).
process.env.NINEROUTER_MAX_BODY_BYTES = "508";
afterAll(() => { delete process.env.NINEROUTER_MAX_BODY_BYTES; });

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { POST: responsesPost } = await import("../../src/app/api/v1/responses/route.js");

describe("request body ceiling", () => {
  it("rejects an oversized chat body with 413 before parsing", async () => {
    const request = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "a".repeat(4000) }] }),
    });
    const response = await handleChat(request);
    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error.message).toContain("too large");
  });

  it("rejects a UTF-8 body whose bytes exceed the ceiling despite a shorter JS length", async () => {
    const content = "é".repeat(450);
    const body = JSON.stringify({ model: "x/y", messages: [{ role: "user", content }] });
    expect(body.length).toBeLessThan(508);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(508);

    const request = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const response = await handleChat(request);
    expect(response.status).toBe(413);
  });

  it("rejects an oversized chunked body that never declares a Content-Length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(2000)));
        controller.close();
      },
    });
    const request = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBe(null);
    const response = await handleChat(request);
    expect(response.status).toBe(413);
  });

  it("rejects an oversized body through the Responses wrapper route", async () => {
    const request = new Request("http://localhost:20128/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x/y", input: "a".repeat(4000) }),
    });
    const response = await responsesPost(request);
    expect(response.status).toBe(413);
  });

  it("lets a body under the ceiling reach normal handling", async () => {
    const request = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await handleChat(request);
    expect(response.status).not.toBe(413);
  });

  it("still rejects malformed JSON with 400", async () => {
    const request = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const response = await handleChat(request);
    expect(response.status).toBe(400);
  });
});

describe("bounded body reader", () => {
  it("stops pulling the stream once the ceiling is crossed instead of buffering it whole", async () => {
    const { readBoundedJson } = await import("../../src/sse/utils/boundedBody.js");
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls > 50) return controller.close();
        controller.enqueue(new TextEncoder().encode("a".repeat(600)));
      },
    });
    const request = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    });

    const { error } = await readBoundedJson(request, 508);

    expect(error.status).toBe(413);
    // request.text() would drain all 51 chunks before the size check; the bounded
    // read cancels as soon as the running count is over the limit.
    expect(pulls).toBeLessThan(5);
  });
});
