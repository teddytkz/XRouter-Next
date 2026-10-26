import * as log from "../utils/logger.js";
import { getProviderConnections, updateProviderConnection } from "../../lib/localDb.js";

// Kimchi's monthly quota resets at the start of the month, but a quota-exhausted
// connection stays inactive until something flips it back. Nothing else does.
function reactivatedUpdate() {
  return {
    isActive: true,
    rateLimitedUntil: null,
    testStatus: "active",
    quotaExhaustedAt: null,
    quotaResetsAt: null,
  };
}

/** Reactivates kimchi connections whose quota cooldown has expired. */
export async function reactivateExpiredKimchiAccounts() {
  let connections;
  try {
    connections = await getProviderConnections({ provider: "kimchi", isActive: false });
  } catch (e) {
    log.warn("AUTH", `Kimchi quota reactivation: failed to query connections: ${e.message}`);
    return 0;
  }
  if (!connections?.length) return 0;

  const now = Date.now();
  let reactivated = 0;
  for (const conn of connections) {
    if (conn.testStatus !== "quota_exhausted" || !conn.rateLimitedUntil) continue;
    const untilMs = new Date(conn.rateLimitedUntil).getTime();
    if (Number.isNaN(untilMs) || untilMs > now) continue;
    try {
      await updateProviderConnection(conn.id, reactivatedUpdate());
      reactivated++;
      log.info("AUTH", `Kimchi quota reactivated: ${conn.name || conn.id} (cooldown expired ${conn.rateLimitedUntil})`);
    } catch (e) {
      log.warn("AUTH", `Kimchi quota reactivation failed for ${conn.name || conn.id}: ${e.message}`);
    }
  }
  if (reactivated > 0) log.info("AUTH", `Kimchi quota reactivation: ${reactivated} account(s) reactivated`);
  return reactivated;
}
