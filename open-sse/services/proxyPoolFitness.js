// Durable proxy-pool fitness registry. Ported from VansRouter.
// Scope format: `provider::model` (e.g. `freebuff::deepseek-v4`), or
// `provider::*` for every model of a provider.
//
// SQLite (proxyPoolFitness table) is the source of truth; the Map below is a
// read-through cache so the hot path (isPoolUnfit during pool selection) stays
// synchronous. Everything here is FAIL-OPEN: if persistence is unavailable a
// fitness write/read degrades to the in-memory cache and never throws.
import {
  listProxyPoolFitness,
  upsertProxyPoolFitness,
  deleteProxyPoolFitness,
  clearProxyPoolFitness,
} from "@/models";

export const POOL_UNFIT_MS = 5 * 60 * 1000;

const FITNESS_STATE_KEY = "__9routerPoolFitness__";
const fitness = (globalThis[FITNESS_STATE_KEY] ??= new Map());

function setPoolFitness(poolId, entries) {
  if (entries.length) {
    fitness.set(poolId, new Map(entries.map((e) => [e.scope, { until: e.until, reason: e.reason || "" }])));
  } else {
    fitness.delete(poolId);
  }
}

function updateCachedFitness(poolId, scope, until, reason = "") {
  const byScope = fitness.get(poolId) || new Map();
  byScope.set(scope, { until, reason });
  fitness.set(poolId, byScope);
}

// Load a pool's active rows into the cache, dropping expired ones.
export async function loadPoolFitness(poolId) {
  if (!poolId) return;
  try {
    const entries = await listProxyPoolFitness(poolId);
    const now = Date.now();
    const active = entries.filter((e) => e.until > now);
    setPoolFitness(poolId, active);
    const expired = entries.filter((e) => e.until <= now);
    if (expired.length) await Promise.all(expired.map((e) => deleteProxyPoolFitness(poolId, e.scope)));
  } catch {
    // Fail-open: keep whatever the cache already holds.
  }
}

export async function markPoolUnfit(poolId, scope, until = Date.now() + POOL_UNFIT_MS, reason = "") {
  if (!poolId || !scope || !Number.isFinite(until)) return false;
  try {
    await upsertProxyPoolFitness(poolId, scope, until, reason);
  } catch {
    // Persist failed — still mark in-memory so the current process avoids the pool.
  }
  updateCachedFitness(poolId, scope, until, reason);
  return true;
}

export async function clearPoolUnfit(poolId, scope) {
  if (!poolId || !scope) return false;
  try {
    await deleteProxyPoolFitness(poolId, scope);
  } catch {
    return false;
  }
  const byScope = fitness.get(poolId);
  if (byScope) {
    byScope.delete(scope);
    if (byScope.size === 0) fitness.delete(poolId);
  }
  return true;
}

function providerWildcardScope(scope) {
  const sep = String(scope || "").indexOf("::");
  return sep < 0 ? null : `${scope.slice(0, sep)}::*`;
}

// Synchronous cache read: is `poolId` unfit for `scope` right now? Checks both
// the exact scope and the provider wildcard. Returns true (fit) when unknown.
export function isPoolUnfit(poolId, scope, now = Date.now()) {
  if (!poolId) return false;
  const byScope = fitness.get(poolId);
  if (!byScope) return false;
  for (const key of [scope, providerWildcardScope(scope)]) {
    if (!key) continue;
    const entry = byScope.get(key);
    if (!entry) continue;
    if (entry.until <= now) {
      byScope.delete(key);
      if (byScope.size === 0) fitness.delete(poolId);
      continue;
    }
    return true;
  }
  return false;
}

export async function clearAllPoolUnfit(provider = null) {
  try {
    await clearProxyPoolFitness(provider);
  } catch {
    return false;
  }
  if (!provider) {
    fitness.clear();
  } else {
    const prefix = `${provider}::`;
    for (const [poolId, byScope] of fitness) {
      for (const scope of [...byScope.keys()]) if (scope.startsWith(prefix)) byScope.delete(scope);
      if (!byScope.size) fitness.delete(poolId);
    }
  }
  return true;
}

// Snapshot of active fitness rows keyed by poolId → { scope: { until, reason } },
// for the dashboard. Expired rows are pruned as a side effect.
export async function poolFitnessSnapshot(now = Date.now()) {
  const entries = await listProxyPoolFitness();
  const out = {};
  for (const entry of entries) {
    if (entry.until <= now) {
      await deleteProxyPoolFitness(entry.poolId, entry.scope);
      continue;
    }
    const byScope = out[entry.poolId] || (out[entry.poolId] = {});
    byScope[entry.scope] = { until: entry.until, reason: entry.reason || "" };
  }
  return out;
}
