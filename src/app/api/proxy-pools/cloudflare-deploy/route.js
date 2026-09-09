import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";

// Relay worker source code deployed to Cloudflare
const RELAY_WORKER_CODE = `
// In-memory log storage (max 50 entries)
const logs = [];
const MAX_LOGS = 50;

function addLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs.shift(); // Remove oldest entry
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint untuk melihat logs
    if (url.pathname === "/log") {
      return new Response(JSON.stringify(logs, null, 2), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    const startTime = Date.now();

    // Reroute httpbin.org ke mock response 200
    if (target && target.includes("httpbin.org")) {
      const duration = Date.now() - startTime;
      const mockResponse = {
        message: "httpbin.org mocked",
        original_target: target,
        path: relayPath,
        method: request.method,
        timestamp: new Date().toISOString(),
      };

      addLog({
        timestamp: new Date().toISOString(),
        request: {
          method: request.method,
          path: url.pathname,
          targetUrl: target + relayPath,
          headers: Object.fromEntries(request.headers.entries()),
          body: null,
        },
        response: {
          status: 200,
          mocked: true,
          body: JSON.stringify(mockResponse),
        },
        duration,
      });

      return new Response(JSON.stringify(mockResponse, null, 2), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (!target) {
      addLog({
        timestamp: new Date().toISOString(),
        request: {
          method: request.method,
          path: url.pathname,
          headers: Object.fromEntries(request.headers.entries()),
        },
        response: {
          status: 400,
          error: "Missing x-relay-target header",
        },
        duration: Date.now() - startTime,
      });

      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
    };

    let requestBody = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bodyBuffer = await request.arrayBuffer();
      newRequestInit.body = bodyBuffer;
      newRequestInit.duplex = "half";
      
      try {
        requestBody = new TextDecoder().decode(bodyBuffer);
      } catch {
        requestBody = \`<binary data: \${bodyBuffer.byteLength} bytes>\`;
      }
    }

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("host");

    try {
      const response = await fetch(targetUrl, newRequestInit);
      const responseBody = await response.text();
      const duration = Date.now() - startTime;

      addLog({
        timestamp: new Date().toISOString(),
        request: {
          method: request.method,
          path: url.pathname,
          targetUrl,
          headers: Object.fromEntries(request.headers.entries()),
          body: requestBody,
        },
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody.length > 1000 ? responseBody.substring(0, 1000) + "... (truncated)" : responseBody,
        },
        duration,
      });

      return new Response(responseBody, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      addLog({
        timestamp: new Date().toISOString(),
        request: {
          method: request.method,
          path: url.pathname,
          targetUrl,
          headers: Object.fromEntries(request.headers.entries()),
          body: requestBody,
        },
        response: {
          status: 502,
          error: "Relay Fetch Failed",
          details: error.message,
        },
        duration,
      });

      return new Response(JSON.stringify({ error: "Relay Fetch Failed", details: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

// POST /api/proxy-pools/cloudflare-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const accountId = body.accountId?.trim();
    const apiToken = body.apiToken?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare Account ID and API Token are required" }, { status: 400 });
    }

    // 1. Upload Worker Script
    const workerScriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${projectName}`;
    
    // Cloudflare requires multipart/form-data for worker script upload
    const formData = new FormData();
    formData.append("index.js", new Blob([RELAY_WORKER_CODE], { type: "application/javascript+module" }), "index.js");
    formData.append("metadata", new Blob([JSON.stringify({
      main_module: "index.js",
      compatibility_date: "2024-03-20",
      observability: { enabled: true }
    })], { type: "application/json" }), "metadata.json");

    const uploadRes = await fetch(workerScriptUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error("Cloudflare upload error:", err);
      return NextResponse.json(
        { error: err.errors?.[0]?.message || "Failed to upload Worker to Cloudflare" },
        { status: uploadRes.status }
      );
    }

    // 2. Enable workers.dev subdomain for the script
    const enableSubdomainRes = await fetch(`${workerScriptUrl}/subdomain`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });

    if (!enableSubdomainRes.ok) {
      const err = await enableSubdomainRes.json().catch(() => ({}));
      console.error("Cloudflare subdomain enable error:", err);
      // We don't fail completely here, just continue
    }

    // 3. Get the workers.dev subdomain for the account to construct the final URL
    let deployUrl = "";
    const subdomainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (subdomainRes.ok) {
      const subdomainData = await subdomainRes.json();
      if (subdomainData.result && subdomainData.result.subdomain) {
        deployUrl = `https://${projectName}.${subdomainData.result.subdomain}.workers.dev`;
      }
    }

    if (!deployUrl) {
       return NextResponse.json(
        { error: "Worker deployed but failed to retrieve workers.dev subdomain. Make sure you have setup a workers.dev subdomain in Cloudflare Dashboard." },
        { status: 400 }
      );
    }

    // Create proxy pool entry with type cloudflare
    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "cloudflare",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    });

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    console.log("Error deploying Cloudflare relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
