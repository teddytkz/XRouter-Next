"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

// A provider counts as "on" while it has traffic inside this window; past it the
// row shows the plain "Idle" label instead of a lamp.
const IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Force-stop the blink if a provider stays active longer than this (BE stuck).
const ACTIVE_TIMEOUT_MS = 60000;
const ACTIVE_TICK_MS = 1000;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function ProviderRow({ providerId, nodeName, name, models, activeModelKeys, lastUsed, now }) {
  const config = getProviderConfig(providerId);
  const color = config.color || "#6b7280";
  const label = (config.name !== providerId ? config.name : null) || nodeName || name || providerId;
  const imageUrl = getProviderIconSrc(providerId);
  const textIcon = config.textIcon || (providerId || "?").slice(0, 2).toUpperCase();
  const [imgError, setImgError] = useState(false);

  const isActive = activeModelKeys.size > 0;
  const lastMs = lastUsed ? new Date(lastUsed).getTime() : 0;
  const isIdle = !isActive && (!lastMs || now - lastMs >= IDLE_WINDOW_MS);

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5">
      {/* Provider icon */}
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `${color}15` }}
      >
        {imageUrl && !imgError ? (
          <img
            src={imageUrl}
            alt={label}
            className="size-6 rounded-sm object-contain"
            loading="lazy"
            decoding="async"
            onError={() => {
              const m = imageUrl?.match(/^\/providers\/([^/]+)\.png$/i);
              if (m) markProviderIconMissing(m[1]);
              setImgError(true);
            }}
          />
        ) : (
          <span className="text-sm font-bold" style={{ color }}>{textIcon}</span>
        )}
      </div>

      {/* Provider name */}
      <span className="w-32 shrink-0 truncate text-sm font-medium sm:w-44">{label}</span>

      {/* Active models - one line, bounded width, scrolls sideways */}
      <div className="scroll-thin-x flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5">
        {models.length === 0 ? (
          <span className="text-xs text-text-muted">No active models</span>
        ) : (
          models.map((m) => {
            const hot = activeModelKeys.has(m.model);
            return (
              <span
                key={m.model}
                className={`inline-flex max-w-[16rem] shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                  hot
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-border bg-bg-subtle text-text-muted"
                }`}
                title={m.model}
              >
                {hot && <span className="size-1.5 shrink-0 rounded-full bg-success" />}
                <span className="truncate">{m.model}</span>
              </span>
            );
          })
        )}
      </div>

      {/* Status: green lamp (blinking while active), plain "Idle" once cold */}
      <div className="flex w-16 shrink-0 items-center justify-end gap-1.5">
        {isIdle ? (
          <span className="text-xs font-medium text-text-muted">Idle</span>
        ) : (
          <>
            <span className="relative flex size-2.5">
              {isActive && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
              )}
              <span className="relative inline-flex size-2.5 rounded-full bg-success" />
            </span>
            <span className="text-xs font-medium text-success">{isActive ? "Active" : "On"}</span>
          </>
        )}
      </div>
    </div>
  );
}

ProviderRow.propTypes = {
  providerId: PropTypes.string.isRequired,
  nodeName: PropTypes.string,
  name: PropTypes.string,
  models: PropTypes.arrayOf(PropTypes.shape({
    model: PropTypes.string,
    lastUsed: PropTypes.string,
    requests: PropTypes.number,
  })).isRequired,
  activeModelKeys: PropTypes.instanceOf(Set).isRequired,
  lastUsed: PropTypes.string,
  now: PropTypes.number.isRequired,
};

export default function ProviderActivityList({
  providers = [],
  activeRequests = [],
  providerActivity = [],
}) {
  const [now, setNow] = useState(() => Date.now());

  // In-flight provider/model pairs, lowercased for stable matching.
  const activeKeys = useMemo(
    () => activeRequests.map((r) => `${r.provider || ""}|${r.model || ""}`.toLowerCase()).filter(Boolean).sort().join(","),
    [activeRequests]
  );
  const rawActiveSet = useMemo(() => new Set(activeKeys ? activeKeys.split(",") : []), [activeKeys]);

  // Providers stuck "active" longer than ACTIVE_TIMEOUT_MS are treated as
  // stopped (BE hang guard). firstSeenRef is only touched inside the interval
  // and its reset effect, never during render.
  const firstSeenRef = useRef({});
  const [stuck, setStuck] = useState(() => new Set());

  useEffect(() => {
    if (rawActiveSet.size === 0) firstSeenRef.current = {};
  }, [rawActiveSet]);

  // Clock: fast while something is in flight (blink + timeout), slow otherwise
  // (the 24h idle rule only needs minute granularity).
  useEffect(() => {
    const period = rawActiveSet.size > 0 ? ACTIVE_TICK_MS : 30000;
    const id = setInterval(() => {
      const ts = Date.now();
      const seen = firstSeenRef.current;
      const provs = new Set();
      for (const k of rawActiveSet) provs.add(k.split("|")[0]);
      for (const p of provs) if (!seen[p]) seen[p] = ts;
      for (const p of Object.keys(seen)) if (!provs.has(p)) delete seen[p];

      const nextStuck = new Set();
      for (const p of provs) if (ts - seen[p] >= ACTIVE_TIMEOUT_MS) nextStuck.add(p);
      setStuck(nextStuck);
      setNow(ts);
    }, period);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  const activeSet = useMemo(() => {
    const filtered = new Set();
    for (const k of rawActiveSet) {
      if (!stuck.has(k.split("|")[0])) filtered.add(k);
    }
    return filtered;
  }, [rawActiveSet, stuck]);

  // Activity index: provider → { models, lastUsed }
  const activityMap = useMemo(() => {
    const map = new Map();
    for (const p of providerActivity) {
      const id = (p.provider || "").toLowerCase();
      if (id) map.set(id, p);
    }
    return map;
  }, [providerActivity]);

  // Union of connected providers and providers seen in the 24h window, so free
  // noAuth providers with traffic still show up even without a connection row.
  const rows = useMemo(() => {
    const byId = new Map();
    for (const p of providers) {
      const id = (p.provider || "").toLowerCase();
      if (id) byId.set(id, { providerId: id, nodeName: p.nodeName, name: p.name });
    }
    for (const p of providerActivity) {
      const id = (p.provider || "").toLowerCase();
      if (id && !byId.has(id)) byId.set(id, { providerId: id, nodeName: null, name: null });
    }

    const list = [...byId.values()].map((r) => {
      const act = activityMap.get(r.providerId);
      const models = act?.models || [];
      const activeModelKeys = new Set();
      for (const k of activeSet) {
        const [prov, model] = k.split("|");
        if (prov === r.providerId) activeModelKeys.add(model);
      }
      return { ...r, models, lastUsed: act?.lastUsed, activeModelKeys };
    });

    // Active first, then most recently used, then alphabetical.
    return list.sort((a, b) => {
      const aActive = a.activeModelKeys.size > 0 ? 1 : 0;
      const bActive = b.activeModelKeys.size > 0 ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      const at = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const bt = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      if (at !== bt) return bt - at;
      return a.providerId.localeCompare(b.providerId);
    });
  }, [providers, providerActivity, activityMap, activeSet]);

  const activeCount = rows.filter((r) => r.activeModelKeys.size > 0).length;

  return (
    <Card className="flex h-full max-h-[480px] min-w-0 flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <img
            src="/favicon.svg"
            alt="9Router"
            className="size-5"
            loading="lazy"
            decoding="async"
          />
          <span className="text-sm font-bold text-primary">9Router</span>
          <span className="text-xs text-text-muted">· Provider activity (24h)</span>
        </div>
        {activeCount > 0 && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
            {activeCount} active
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-8 text-sm text-text-muted">
          No providers connected
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
          {rows.map((r) => (
            <ProviderRow
              key={r.providerId}
              providerId={r.providerId}
              nodeName={r.nodeName}
              name={r.name}
              models={r.models}
              activeModelKeys={r.activeModelKeys}
              lastUsed={r.lastUsed}
              now={now}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

ProviderActivityList.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    provider: PropTypes.string,
    name: PropTypes.string,
    nodeName: PropTypes.string,
  })),
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    model: PropTypes.string,
    account: PropTypes.string,
  })),
  providerActivity: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    lastUsed: PropTypes.string,
    models: PropTypes.arrayOf(PropTypes.shape({
      model: PropTypes.string,
      lastUsed: PropTypes.string,
      requests: PropTypes.number,
    })),
  })),
};
