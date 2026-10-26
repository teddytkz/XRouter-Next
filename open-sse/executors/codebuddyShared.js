/**
 * Shared CodeBuddy channel neutralization (ported from VansRouter).
 *
 * Upstream WAF checks message content for rival CLI identities (Claude Code,
 * ZCode, etc.) and answers 11128 "Illegal API invocation from an unapproved
 * channel". User and tool messages are left byte-for-byte untouched.
 */

export const CODEBUDDY_IDENTITY_REWRITES = [
  {
    roles: ["system"],
    pattern: /^You are Claude Code, Anthropic's official CLI for Claude[^\n]*/gm,
    to: "You are CodeBuddy Code, an expert software engineering assistant.",
  },
  {
    roles: ["assistant"],
    pattern: /You are Claude Code, Anthropic's official CLI for Claude[^\n]*/g,
    to: "You are CodeBuddy Code, an expert software engineering assistant.",
  },
  {
    roles: ["system", "assistant"],
    pattern: /You are (?:ZCode|Cursor|Windsurf|Cline|Aider|Continue|Cody)[^\n.]*[.!]?/gi,
    to: "You are CodeBuddy Code, an expert software engineering assistant.",
  },
  {
    roles: ["system", "assistant"],
    pattern: /You are an interactive (?:ZCode|coding|code) agent[^\n.]*[.!]?/gi,
    to: "You are CodeBuddy Code, an expert software engineering assistant.",
  },
  {
    roles: ["system", "assistant"],
    pattern: /Sisyphus-Junior - Focused executor from OhMyOpenCode/g,
    to: "Sisyphus-Junior - Focused executor",
  },
  {
    roles: ["system"],
    pattern: /x-anthropic-billing-header/gi,
    to: "x-billing-header",
  },
  {
    roles: ["system"],
    pattern: /Main branch \(you will usually use this for PRs\):/g,
    to: "Main branch:",
  },
  {
    roles: ["system"],
    pattern: /^[ \t]*#[ \t]*(?:ZCode|DeepSeek[ \t-]+Harness|Claude[ \t]+Code)[ \t]+Desktop[ \t]+Context[ \t]*$/gim,
    to: "# Desktop Context",
  },
];

export function neutralizeCodeBuddyChannelIdentity(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const role = message.role;
    if (role !== "system" && role !== "assistant") return message;

    const rewrite = (input) => {
      let text = input;
      for (const { roles, pattern, to } of CODEBUDDY_IDENTITY_REWRITES) {
        if (!roles || roles.includes(role)) text = text.replace(pattern, to);
      }
      return text;
    };

    if (typeof message.content === "string") {
      const text = rewrite(message.content);
      return text === message.content ? message : { ...message, content: text };
    }

    if (Array.isArray(message.content)) {
      let changed = false;
      const nextContent = message.content.map((part) => {
        if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") {
          return part;
        }
        const text = rewrite(part.text);
        if (text === part.text) return part;
        changed = true;
        return { ...part, text };
      });
      return changed ? { ...message, content: nextContent } : message;
    }

    return message;
  });
}

/** Strips tool descriptions when the metadata exceeds the 64KB WAF limit. */
export function compactOversizedTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  try {
    if (new TextEncoder().encode(JSON.stringify(tools)).byteLength < 65536) return tools;
    return tools.map((tool) => {
      if (!tool || typeof tool !== "object" || tool.type !== "function" || !tool.function?.description) return tool;
      const fn = { ...tool.function };
      delete fn.description;
      return { ...tool, function: fn };
    });
  } catch {
    return tools;
  }
}

/** Harvests a rotated Bearer token from the response headers. */
export function captureRotatedToken(response, credentials) {
  if (!response?.headers || !credentials) return;
  const getHeader = typeof response.headers.get === "function"
    ? (k) => response.headers.get(k)
    : (k) => response.headers[k] || response.headers[k.toLowerCase()];
  const authHeader = getHeader("authorization");
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const newToken = authHeader.slice("Bearer ".length).trim();
    if (newToken && newToken !== credentials.accessToken) credentials.accessToken = newToken;
  }
}
