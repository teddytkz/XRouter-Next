"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardSkeleton } from "@/shared/components";

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

function ProviderSection({ provider }) {
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
              <ModelRows key={model.id} provider={provider} model={model} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// One row per rate tier: the normal (base) row, then one row per time rule.
function ModelRows({ provider, model }) {
  const pricing = model.pricing;
  const rules = Array.isArray(pricing?.rules) ? pricing.rules : [];
  const linkable = !provider.id.startsWith("selfhosted") && !!pricing;

  return (
    <>
      <tr className="border-t border-border-subtle/60 hover:bg-surface-2/40">
        <td className="px-4 py-2 align-top">
          <div className="flex items-center gap-2">
            <span className="font-medium text-text-main">{model.name}</span>
            {!pricing && <Badge variant="default" size="sm">no rate</Badge>}
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

      {linkable && rules.length > 0 && (
        <tr>
          <td colSpan={RATE_FIELDS.length + 1} className="px-4 pb-2">
            <Link
              href={`/dashboard/providers/${provider.id}`}
              className="text-[11px] text-primary hover:underline"
            >
              Edit rates for {provider.name} →
            </Link>
          </td>
        </tr>
      )}
    </>
  );
}

export default function PricingPage() {
  const [table, setTable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [peakOnly, setPeakOnly] = useState(false);

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
  }, []);

  const filtered = useMemo(() => {
    if (!table) return [];
    const q = query.trim().toLowerCase();
    return table
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((m) => {
          if (peakOnly && !m.peak) return false;
          if (!q) return true;
          return m.id.toLowerCase().includes(q)
            || m.name.toLowerCase().includes(q)
            || provider.id.toLowerCase().includes(q)
            || provider.name.toLowerCase().includes(q);
        }),
      }))
      .filter((provider) => provider.models.length > 0);
  }, [table, query, peakOnly]);

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
            <ProviderSection key={provider.id} provider={provider} />
          ))}
        </div>
      )}
    </div>
  );
}
