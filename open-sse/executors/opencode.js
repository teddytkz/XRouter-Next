import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

// Upstream (Authorization: Bearer public) requires `opencode/<ver>` with ver >= 1.17.0.
// Bare `opencode`, third-party UAs (Claude-Code/*, curl/*) => 403 FreeTierError;
// versions < 1.17.0 => 426 Upgrade Required. See PR #4105.
const OPENCODE_UA = "opencode/1.18.31";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
const REQ_FIELD = "_opencodeRequest";

// Canonical OpenCode identifiers: 30 chars total.
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
// Zen serves Union Alpha from /zen/v1/messages (Anthropic Messages format) — PR #4099.
const MESSAGES_MODELS = new Set(["union-alpha"]);

// Preserve a valid downstream opencode UA; otherwise fall back to OPENCODE_UA.
function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}

let lastTimestamp = 0;
let sessionCounter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) randomPart += BASE62_CHARS[bytes[i] % 62];
  return randomPart;
}

// 48-bit big-endian hex of a BigInt (two's-complement AND keeps the low byte positive).
function hex48(value) {
  return Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")
  ).join("");
}

// Descending canonical session id: ses_ + 12 hex + 14 Base62 (30 chars).
export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
  return `ses_${hex48(~current)}${unstableRandom()}`;
}

// Canonical request id: msg_ + 12 hex + 14 Base62 (30 chars).
export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  return `msg_${hex48(current)}${unstableRandom()}`;
}

function lastUserText(body) {
  try {
    if (!body || typeof body !== "object") return "";
    const arr = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
    if (!arr) return typeof body.input === "string" ? body.input.slice(-600) : "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const msg = arr[i];
      if (!msg || (msg.role && msg.role !== "user")) continue;
      const content = msg.content;
      if (typeof content === "string" && content.trim()) return content.trim().slice(-600);
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part === "string" ? part : part?.text || part?.input_text || ""))
          .join(" ")
          .trim();
        if (text) return text.slice(-600);
      }
    }
  } catch {
    return "";
  }
  return "";
}

// The real CLI sends the current user message id (stable per turn, same on
// retries) as x-opencode-request. Derive it from session + last user message so
// retries share the id instead of minting a fresh one every attempt.
export function deriveRequestId(sessionId, body) {
  const text = lastUserText(body);
  if (!text) return generateRequestId();
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-req\0${sessionId || ""}\0${text}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += BASE62_CHARS[digest[i] % 62];
  const id = `msg_${timeHex}${randomPart}`;
  return OPENCODE_REQUEST_RE.test(id) ? id : generateRequestId();
}

function normalizeRequestId(value) {
  const normalized = normalizeSession(value);
  return normalized && OPENCODE_REQUEST_RE.test(normalized) ? normalized : null;
}

function resolveOpencodeRequestId(body, credentials, sessionId) {
  for (const [key, value] of Object.entries(credentials?.rawHeaders || {})) {
    if (key.toLowerCase() !== "x-opencode-request") continue;
    const normalized = normalizeRequestId(value);
    if (normalized) return normalized;
    break;
  }
  return deriveRequestId(sessionId, body);
}

// Deterministically map foreign session identities (claude:<uuid>, antigravity:…,
// codex sessions, plain UUIDs) into canonical 30-char ids so multi-turn prompt
// caching survives upstream while still passing the 403 FreeTierError gate.
export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += BASE62_CHARS[digest[i] % 62];
  return `ses_${timeHex}${randomPart}`;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

// Case-insensitive lookup of an already-canonical native session header.
function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== SESSION_HEADER) continue;
    const normalized = normalizeSession(value);
    if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
  }
  return null;
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const resolved = incoming || normalizeSession(providerSessionId) || resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  });

  return resolved ? translateSessionId(resolved, clientTool) : generateSessionId();
}

// Flatten Chat Completions tool declarations into the Responses flat shape and
// drop hosted/nameless tools the /responses endpoint rejects.
function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // {type:"object"} without properties is rejected by strict Responses backends.
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// The Zen free tier rejects the request with HTTP 403 FreeTierError ("OpenCode's
// free tier can only be used from within OpenCode") unless the body declares a
// tool named "bash" AND a tool named "read" — exact, lowercase. Nothing else
// gates it: no header, model, prompt or other body field matters. Verified by
// A/B replay against /zen/v1/responses AND /zen/v1/chat/completions:
//
//   no tools / tools:[] / 1 tool / bash+edit / read+grep  -> 403
//   bash+read / bash+read+anything else                   -> 200
//
// Clients (Claude Code, Codex, …) send capitalized Bash/Read, which do not
// satisfy the gate, so their requests 403 even with real tools present. The
// stubs are harmless: the model still calls the client's own tools.
const FINGERPRINT_TOOL_NAMES = ["bash", "read"];
const FINGERPRINT_TOOL_DESCRIPTION =
  "Do not call this tool. It exists only for API compatibility and must never be invoked.";

// Each endpoint takes a different tool shape: /responses wants the flat
// {type,name,parameters}, /chat/completions wants the nested {type,function:{…}}
// (a flat tool there is a 500 "Internal server error").
function fingerprintTool(name, nested) {
  const fn = {
    name,
    description: FINGERPRINT_TOOL_DESCRIPTION,
    parameters: { type: "object", properties: {} },
  };
  return nested ? { type: "function", function: fn } : { type: "function", ...fn };
}

function ensureFingerprintTools(body, nested = false) {
  if (!Array.isArray(body.tools)) body.tools = [];
  const present = new Set(body.tools.map((tool) => tool?.name || tool?.function?.name));
  for (const name of FINGERPRINT_TOOL_NAMES) {
    if (present.has(name)) continue;
    body.tools.push(fingerprintTool(name, nested));
  }
}

// Last line of defense for native Responses clients (sourceFormat === targetFormat
// skips translation): coerce items in place so malformed tool payloads 400 here
// with a clear shape instead of upstream as InputValidationError.
function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // PR #4061: OpenCode Free uses pooled public credentials (`Bearer public`)
    // routed across rotating upstream accounts. Reasoning `encrypted_content` is
    // bound to the caller that issued it, so replaying it on a later turn fails
    // with 400 "reasoning encrypted_content was not issued to this caller"; under
    // store=false, keeping the reasoning item without encrypted_content fails as
    // "not found or was deleted". Dropping prior reasoning items fixes both.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  // Stateless, request-local session: never mutate shared executor state (the
  // executor is a process-wide singleton) and never mutate source credentials.
  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const resolved = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: resolved,
      [REQ_FIELD]: resolveOpencodeRequestId(body, sourceCredentials, resolved),
    };
  }

  async execute(args) {
    return super.execute({ ...args, credentials: this.prepareRequestCredentials(args) });
  }

  transformRequest(model, body, stream, credentials) {
    if (!body || typeof body !== "object") return body;
    const effectiveModel = model || body.model;
    if (isResponsesModel(effectiveModel)) {
      // PR #4062: muse-spark-1.3-contributor-free only accepts tool_choice "auto";
      // named/required/none are demoted at this boundary to avoid HTTP 400.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(effectiveModel))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(effectiveModel, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      ensureFingerprintTools(body);
      sanitizeResponsesItems(body);
    } else if (!isMessagesModel(effectiveModel)) {
      // The same gate guards the free Chat Completions models (big-pickle,
      // nemotron-*-free, …): "bash"+"read" tools AND stream:true in the body —
      // nested tool shape here. The registry's forceStream makes chatCore
      // reshape the SSE back to JSON for non-streaming clients.
      body.stream = true;
      ensureFingerprintTools(body, true);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/zen/v1/responses`;
    if (isMessagesModel(model)) return `${base}/zen/v1/messages`;
    return `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);
    const session = credentials?.[SESSION_FIELD]
      || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];
    const requestId = credentials?.[REQ_FIELD]
      || normalizeRequestId(lower["x-opencode-request"])
      || generateRequestId();

    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": requestId,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    // The Messages endpoint requires the shared Anthropic version header (PR #4099).
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
