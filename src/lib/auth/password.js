// Dashboard password policy. Ported from VansRouter.
//
// The initial password comes from INITIAL_PASSWORD (or the "123456" dev
// fallback). A weak value is a known-credential hazard: on a fresh install it is
// the only thing standing between a remote client and a full dashboard session.
// These helpers centralize the "is this a placeholder?" and "is this strong
// enough for production?" questions so the login/settings/reset paths agree.
const DEFAULT_INITIAL_PASSWORD = "123456";
const PLACEHOLDER_PASSWORDS = new Set([
  "123456",
  "change-me",
  "change-me-in-production",
  "change-me-to-a-long-random-secret",
  "password",
  "changeme",
]);

// Strong = at least 12 chars and not a well-known placeholder. Length is the
// only cheap entropy proxy available without a dictionary; the placeholder set
// catches the "meets length but everyone knows it" cases.
export function isStrongInitialPassword(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= 12 && !PLACEHOLDER_PASSWORDS.has(normalized.toLowerCase());
}

export function getInitialPassword(env = process.env) {
  const configured = typeof env.INITIAL_PASSWORD === "string" ? env.INITIAL_PASSWORD.trim() : "";
  if (!configured) return DEFAULT_INITIAL_PASSWORD;
  // Outside production, or the documented dev default, take the value verbatim.
  if (env.NODE_ENV !== "production" || configured === DEFAULT_INITIAL_PASSWORD) return configured;
  return isStrongInitialPassword(configured) ? configured : null;
}

export function isPlaceholderPassword(value) {
  return PLACEHOLDER_PASSWORDS.has(String(value || "").trim().toLowerCase());
}
