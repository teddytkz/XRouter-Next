// TLS-impersonating HTTP client for opencode.ai's free tier.
//
// The free gate keys on the TLS ClientHello, not headers: the same body/headers
// answer 429 FreeUsageLimitError over Node's OpenSSL fingerprint and 200 over
// Bun's BoringSSL one. JA4's cipher hash identifies the list, so it must stay
// verbatim. wreq-js is optional; the caller fail-opens to native fetch.

import { loadRuntimeDep } from "./lazyRuntime.js";

const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const DEFAULT_TIMEOUT_MS = 120000;

let sessionPromise = null;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
    // proxyFetch reads this to replay the request on the native transport:
    // a missing optional dep must not turn into a 502.
    this.directFetchFailOpen = true;
  }
}

async function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const wreq = await loadRuntimeDep("wreq-js");
      if (typeof wreq.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      return wreq.createSession({
        emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Drop the cached session so the next call builds a fresh one. */
export function resetOpencodeTlsSession() {
  const pending = sessionPromise;
  sessionPromise = null;
  pending?.then((session) => session.close?.()).catch(() => {});
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged.
 * Streaming is preserved: the body is handed over live, never buffered.
 */
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let session;
  try {
    session = await loadSession();
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const __test__ = { OPENCODE_CIPHER_LIST };
