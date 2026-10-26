// Termination-contract prompt: tells agentic models to stop calling tools once
// they have enough information. Injected when the loop guard fires and for
// models known to loop (Kimi). Pattern follows caveman.js.

import { FORMATS } from "../translator/formats.js";

const SEP = "\n\n";

export const TERMINATION_PROMPT = `When you have gathered sufficient information to answer the request, STOP calling tools and provide your final answer. Do not call a tool with the same arguments more than once. If a previous attempt returned the same result, change strategy or summarize with available data. Plan briefly (1-3 steps max), then ACT immediately. Do NOT restate your plan — if you have decided what to do, do it now. If you catch yourself repeating the same intention, STOP and give your answer with current knowledge.`;

export function injectTerminationPrompt(body, format) {
  if (!body) return;

  switch (format) {
    case FORMATS.CLAUDE:
      injectClaudeSystem(body, TERMINATION_PROMPT);
      return;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY:
      injectGeminiSystem(body, TERMINATION_PROMPT);
      return;
    case FORMATS.KIRO:
      injectKiroSystem(body, TERMINATION_PROMPT);
      return;
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      return; // upstream translator owns the body shape
    default:
      injectMessagesSystem(body, TERMINATION_PROMPT);
  }
}

function injectMessagesSystem(body, prompt) {
  if (typeof body.instructions === "string") {
    if (body.instructions.includes(prompt)) return;
    body.instructions = body.instructions ? `${body.instructions}${SEP}${prompt}` : prompt;
    return;
  }
  const arr = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!arr) return;
  const idx = arr.findIndex(m => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    appendToMessage(arr[idx], prompt);
  } else {
    arr.unshift({ role: "system", content: prompt });
  }
}

function appendToMessage(msg, prompt) {
  if (typeof msg.content === "string") {
    if (msg.content.includes(prompt)) return;
    msg.content = `${msg.content}${SEP}${prompt}`;
  } else if (Array.isArray(msg.content)) {
    if (msg.content.some(p => p.text === prompt)) return;
    msg.content.push({ type: "input_text", text: prompt });
  } else {
    msg.content = prompt;
  }
}

function injectClaudeSystem(body, prompt) {
  if (typeof body.system === "string") {
    if (body.system.includes(prompt)) return;
    body.system = body.system.length > 0 ? `${body.system}${SEP}${prompt}` : prompt;
    return;
  }
  if (Array.isArray(body.system)) {
    if (body.system.some(b => b.text === prompt)) return;
    body.system.push({ type: "text", text: prompt });
    return;
  }
  body.system = prompt;
}

function injectGeminiSystem(body, prompt) {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const key = Object.prototype.hasOwnProperty.call(target, "system_instruction")
    ? "system_instruction"
    : "systemInstruction";
  const sys = target[key];
  if (sys && Array.isArray(sys.parts)) {
    if (sys.parts.some(p => p.text === prompt)) return;
    sys.parts.push({ text: prompt });
    return;
  }
  target[key] = { parts: [{ text: prompt }] };
}

function injectKiroSystem(body, prompt) {
  const msg = body?.conversationState?.currentMessage?.userInputMessage;
  if (!msg) return;
  if (typeof msg.content === "string" && msg.content.includes(prompt)) return;
  msg.content = typeof msg.content === "string" && msg.content
    ? `${prompt}${SEP}${msg.content}`
    : prompt;
}
