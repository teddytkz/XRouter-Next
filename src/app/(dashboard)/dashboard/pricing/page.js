"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton } from "@/shared/components";
import ModelPricingModal from "../providers/[id]/ModelPricingModal";

const SELECT_CLASS =
  "rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-text-main focus:border-primary focus:outline-none disabled:opacity-50";

// $/1M tokens, trailing zeros trimmed (0.0028 → "$0.0028", 5 → "$5").
const money = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `$${Number(v.toFixed(4))}`;
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const daysLabel = (days) => {
  if (!Array.isArray(days) || days.length === 0) return "";
  if (days.length === 7) return "Every day";
  if (days.length === 5 && days.every((d) => d >= 1 && d <= 5)) return "Mon–Fri";
  return days.map((d) => DAY_NAMES[d]).filter(Boolean).join(", ");
};

// "01:00–04:00 · UTC · Mon–Fri". Windows are evaluated in UTC unless the rule
// pins its own zone, so an absent `tz` reads as UTC rather than "whatever the
// server happens to be".
const windowLabel = (rule) => {
  const parts = [rule.from, rule.to].filter(Boolean).join("–");
  return [parts, rule.tz || "UTC", daysLabel(rule.days)].filter(Boolean).join(" · ");
};

const RATE_FIELDS = [
  ["input", "Input"],
  ["cached", "Cached"],
  ["output", "Output"],
  ["reasoning", "Reasoning"],
  ["cache_creation", "Cache write"],
];

function ProviderSection({ provider, onEdit }) {
  const peakCount = provider.models.filter((m) => m.peak).length;
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <span className="material-symbols-outlined text-[18px] text-primary">
          {provider.icon || "dns"}
        </span>
        <h2 className="text-sm font-semibold text-text-main">{provider.name}</h2>
        <span className="text-xs text-text-muted">{provider.models.length} models</span>
        {peakCount > 0 && (
          <Badge variant="warning" size="sm" className="ml-auto">
            {peakCount} with peak rate
          </Badge>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-text-muted">
              <th className="px-4 py-2 text-left font-semibold">Model</th>
              {RATE_FIELDS.map(([key, label]) => (
                <th key={key} className="px-3 py-2 text-right font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {provider.models.map((model) => (
              <ModelRows key={model.id} provider={provider} model={model} onEdit={onEdit} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// One row per rate tier: the normal (base) row, then one row per time rule.
function ModelRows({ provider, model, onEdit }) {
  const pricing = model.pricing;
  const rules = Array.isArray(pricing?.rules) ? pricing.rules : [];
  // Local (self-hosted) providers have no upstream cost, so rates are meaningless.
  const editable = !provider.id.startsWith("selfhosted");

  return (
    <>
      <tr className="border-t border-border-subtle/60 hover:bg-surface-2/40">
        <td className="px-4 py-2 align-top">
          <div className="flex items-center gap-2">
            <span className="font-medium text-text-main">{model.name}</span>
            {!pricing && <Badge variant="default" size="sm">no rate</Badge>}
            {editable && (
              <Button
                size="sm"
                variant="ghost"
                icon="edit"
                className="ml-auto shrink-0"
                title={`Edit rates for ${model.id}`}
                aria-label={`Edit rates for ${model.id}`}
                onClick={() => onEdit(provider.id, model.id)}
              />
            )}
          </div>
          <code className="text-[11px] text-text-muted">{model.id}</code>
        </td>
        {RATE_FIELDS.map(([key]) => (
          <td key={key} className="px-3 py-2 text-right align-top font-mono text-xs text-text-main">
            {pricing ? money(pricing[key]) : "—"}
          </td>
        ))}
      </tr>

      {rules.map((rule, i) => (
        <tr key={i} className="bg-warning/[0.04]">
          <td className="px-4 py-1.5 align-top">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
              <span className="material-symbols-outlined text-[13px] text-yellow-600 dark:text-yellow-400">
                bolt
              </span>
              Peak · {windowLabel(rule)}
            </span>
          </td>
          {RATE_FIELDS.map(([key]) => (
            <td key={key} className="px-3 py-1.5 text-right align-top font-mono text-xs text-yellow-700 dark:text-yellow-400">
              {typeof rule[key] === "number" ? money(rule[key]) : "—"}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function PricingPage() {
  const [table, setTable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [peakOnly, setPeakOnly] = useState(false);
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [editing, setEditing] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/pricing?table=1");
        if (res.ok && !cancelled) setTable(await res.json());
      } catch (error) {
        console.error("Failed to load pricing table:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const providerOptions = useMemo(
    () => (table || []).map((p) => ({ id: p.id, name: p.name })),
    [table]
  );

  // Scoped to the chosen provider, and keyed by a composite "providerId::modelId"
  // — model ids repeat across providers, so a bare id could not say which row to keep.
  const modelOptions = useMemo(() => {
    if (!table) return [];
    const source = providerFilter
      ? table.filter((p) => p.id === providerFilter)
      : table;
    return source.flatMap((p) =>
      p.models.map((m) => ({
        value: `${p.id}::${m.id}`,
        name: providerFilter ? m.name : `${p.name} · ${m.name}`,
      }))
    );
  }, [table, providerFilter]);

  const onProviderChange = (value) => {
    setProviderFilter(value);
    setModelFilter("");
  };

  const onEdit = useCallback((provider, model) => setEditing({ provider, model }), []);

  const filtered = useMemo(() => {
    if (!table) return [];
    const q = query.trim().toLowerCase();
    const [mfProvider, mfModel] = modelFilter ? modelFilter.split("::") : [];
    return table
      .filter((provider) => !providerFilter || provider.id === providerFilter)
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((m) => {
          if (peakOnly && !m.peak) return false;
          if (mfModel && !(provider.id === mfProvider && m.id === mfModel)) return false;
          if (!q) return true;
          return m.id.toLowerCase().includes(q)
            || m.name.toLowerCase().includes(q)
            || provider.id.toLowerCase().includes(q)
            || provider.name.toLowerCase().includes(q);
        }),
      }))
      .filter((provider) => provider.models.length > 0);
  }, [table, query, peakOnly, providerFilter, modelFilter]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const totalModels = filtered.reduce((a, p) => a + p.models.length, 0);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-1 sm:px-0">
      <Card padding="sm">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <span className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">
                search
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search provider or model…"
                className="w-full rounded-lg border border-border bg-background py-1.5 pl-9 pr-3 text-sm focus:border-primary focus:outline-none"
              />
            </div>
            <Button
              size="sm"
              variant={peakOnly ? "primary" : "secondary"}
              icon="bolt"
              onClick={() => setPeakOnly((v) => !v)}
            >
              Peak rate only
            </Button>
            <span className="shrink-0 text-xs text-text-muted">
              {filtered.length} providers · {totalModels} models
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={providerFilter}
              onChange={(e) => onProviderChange(e.target.value)}
              className={SELECT_CLASS}
              aria-label="Filter by provider"
            >
              <option value="">All providers</option>
              {providerOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              disabled={modelOptions.length === 0}
              className={SELECT_CLASS}
              aria-label="Filter by model"
            >
              <option value="">
                {providerFilter ? "All models in provider" : "All models"}
              </option>
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>{m.name}</option>
              ))}
            </select>

            {(providerFilter || modelFilter) && (
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                onClick={() => { setProviderFilter(""); setModelFilter(""); }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-text-muted">
          All rates are <strong>$ per 1M tokens</strong>, and all time windows are in <strong>UTC</strong>.
          Models with a time-of-day schedule show a
          <span className="mx-1 inline-flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
            <span className="material-symbols-outlined text-[12px]">bolt</span>peak
          </span>
          row under their normal rate; every other model is billed at its normal rate only.
        </p>
      </Card>

      {filtered.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-sm text-text-muted">No models match your search.</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {filtered.map((provider) => (
            <ProviderSection key={provider.id} provider={provider} onEdit={onEdit} />
          ))}
        </div>
      )}

      {/* Refetch on close: the modal saves or resets, so the visible rates would
          otherwise stay stale until a manual page reload. */}
      {editing && (
        <ModelPricingModal
          isOpen
          provider={editing.provider}
          modelId={editing.model}
          displayModel={`${editing.provider}/${editing.model}`}
          onClose={() => { setEditing(null); setReloadKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
