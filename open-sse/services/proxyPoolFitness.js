// ponytail: in-memory pool fitness tracker. Upgrade to persistent (DB) when
// pool ids survive across server restarts — add when the dashboard surfaces
// "pool unhealthy" badges.
const _unfit = new Map();

export async function markPoolUnfit(poolId, scope, untilMs, reason) {
  if (!poolId) return;
  const key = `${poolId}::${scope}`;
  _unfit.set(key, { until: untilMs, reason: reason || "unknown" });
}

export async function clearPoolUnfit(poolId, scope) {
  if (!poolId) return;
  _unfit.delete(`${poolId}::${scope}`);
}

export function isPoolUnfit(poolId, scope) {
  if (!poolId) return false;
  const e = _unfit.get(`${poolId}::${scope}`);
  if (!e) return false;
  if (Date.now() >= e.until) {
    _unfit.delete(`${poolId}::${scope}`);
    return false;
  }
  return true;
}
