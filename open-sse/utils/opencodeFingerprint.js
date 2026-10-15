/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * Live upstream probes against OpenCode v2 (`/inference/v1`) isolate the
 * body-side half of the free-tier gate. The other half lives in the executor
 * (endpoint, session headers, `stream:true`); this module owns the tools.
 *
 * Proven rules:
 *  - A tool named exactly `read` (lowercase) MUST be declared. `Read`/`READ` do
 *    not satisfy the gate, and any tool list without a lowercase `read` answers
 *    403 FreeTierError. `read` alone is enough — `shell` is optional, but the
 *    real CLI declares both, so both are appended to look like the client.
 *  - Every declaration whose name is one of the reserved lowercase set
 *    (`read`/`write`/`edit`/`glob`/`grep`/`bash`/`shell`) MUST carry a
 *    non-empty `parameters.properties` map. `properties: {}` answers 403;
 *    `properties: {x:{}}` passes, so the gate only checks emptiness.
 *  - Case variants such as `Read`/`Bash` are NOT reserved and pass untouched.
 *    This module therefore no longer lowercases the caller's tools — doing so
 *    turned a passing `Bash` into a reserved `bash` that then failed on schema.
 *  - Duplicate declarations of one name answer 400, so at most one `read` and
 *    one `shell` are appended.
 */

/** Names appended to every free-tier request when missing. `read` is required. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

/**
 * Lowercase names the upstream gate treats as OpenCode's own tools. Declaring
 * any of these with an empty `properties` map answers 403 FreeTierError.
 */
export const OPENCODE_RESERVED_TOOLS = ["read", "write", "edit", "glob", "grep", "bash", "shell"];

// Verbatim from the OpenCode v2 CLI. Upstream does not compare the wording (a
// minimal schema passes too), but the real definitions keep the model behaving
// like it does in the official client.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

// Placeholder property injected when a reserved name arrives with an empty
// schema. Any non-empty map satisfies the gate.
const PLACEHOLDER_PROPERTY = { type: "string", description: "Unused" };

// Request body -> names renamed for that request. Kept so the response side can
// still be handed a map; the current gate needs no renames, so it stays empty.
const renamedToolNames = new WeakMap();

/** The reserved name when `name` is exactly one (case-sensitive); "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_RESERVED_TOOLS.includes(trimmed) ? trimmed : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

/** True when `parameters` carries at least one declared property. */
function hasProperties(parameters) {
  const props = parameters?.properties;
  return !!props && typeof props === "object" && !Array.isArray(props) && Object.keys(props).length > 0;
}

/**
 * Give every reserved-name declaration a non-empty `properties` map, and drop
 * duplicate declarations of one name (upstream answers 400 on duplicates).
 * Caller tools are otherwise preserved verbatim, including case variants.
 *
 * @param {Array} tools
 * @returns {Array} the rewritten tool list
 */
export function ensureReservedToolSchemas(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return Array.isArray(tools) ? tools : [];

  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const name = toolNameOf(tool);
    if (!name) {
      out.push(tool);
      continue;
    }

    if (seen.has(name)) continue;
    seen.add(name);

    if (!fingerprintToolKey(name)) {
      out.push(tool);
      continue;
    }

    const fn = chatFunctionOf(tool);
    const holder = fn || tool;
    if (hasProperties(holder.parameters)) {
      out.push(tool);
      continue;
    }

    const parameters = {
      ...(holder.parameters && typeof holder.parameters === "object" && !Array.isArray(holder.parameters)
        ? holder.parameters
        : {}),
      type: "object",
      properties: { input: { ...PLACEHOLDER_PROPERTY } },
    };
    out.push(fn ? { ...tool, function: { ...fn, parameters } } : { ...tool, parameters });
  }
  return out;
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  const present = new Set(tools.map(toolNameOf));
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(
      flat
        ? { type: "function", name, description, parameters, strict: false }
        : { type: "function", function: { name, description, parameters } }
    );
    present.add(name);
    appended.push(name);
  }
  return appended;
}

/** Point an explicit tool_choice at a renamed tool, if any rename happened. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;

  if (typeof choice.name === "string") {
    const key = fingerprintToolKey(choice.name);
    if (key && map.has(key)) body.tool_choice = { ...choice, name: key };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const key = fingerprintToolKey(fn.name);
    if (key && map.has(key)) {
      body.tool_choice = { ...choice, function: { ...fn, name: key } };
    }
  }
}

/**
 * Tell the model the appended definitions are inert. Without this it calls the
 * appended `read` instead of the caller's own tool (live probe: `read` on
 * "what files are in /etc?"). Upstream does not gate on the prompt text.
 * Wording matters: "not available" made the model also refuse the caller's own
 * Read/Bash; "placeholders ... use the other tools" kept those working.
 */
function noteUnavailableTools(body, flat, names) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note =
    names.length > 1
      ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
      : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions =
      typeof body.instructions === "string" && body.instructions.trim()
        ? `${body.instructions}\n\n${note}`
        : note;
    return;
  }
  // OpenAI chat shape only; Claude-shaped bodies carry `system` instead.
  if (!Array.isArray(body.messages) || body.system !== undefined) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/**
 * Full request-side pass: satisfy the reserved-name schema rule, append the
 * fingerprint pair, and mark the appended definitions inert.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name (empty today)
 */
export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return new Map();

  const tools = ensureReservedToolSchemas(body.tools);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  const map = new Map();
  retargetToolChoice(body, map);
  if (appended.length) noteUnavailableTools(body, flat, appended);

  // Responses keeps its explicit auto default. Never default to "none": the
  // upstream gate reads a tools-less body as not-from-CLI.
  if (!body.tool_choice && flat) body.tool_choice = "auto";

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
