"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl, Card, Button } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const TABS = [
  { value: "overview", label: "Overview", icon: "dashboard" },
  { value: "details", label: "Detailed Analysis", icon: "analytics" },
  { value: "logs", label: "Request Logs", icon: "list_alt" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState(searchParams.get("period") || "today");
  const [recalculating, setRecalculating] = useState(false);
  const [resetting, setResetting] = useState(false);

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };
  
  const handlePeriodChange = (newPeriod) => {
    setPeriod(newPeriod);
    const params = new URLSearchParams(searchParams);
    params.set("period", newPeriod);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  const handleRecalculate = async () => {
    if (!confirm(
      "Recompute the cost of every stored request with the pricing currently in effect?\n\n" +
      "This rewrites historical cost figures (including past months). Token counts are not changed."
    )) return;

    setRecalculating(true);
    try {
      const res = await fetch("/api/usage/recalculate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to recalculate costs");
        return;
      }
      const delta = Number.isFinite(data.delta) ? data.delta : 0;
      alert(
        `Recomputed ${data.rows} requests — ${data.changed} changed across ${data.days} day(s).\n` +
        (data.skipped > 0
          ? `${data.skipped} left unchanged (no pricing for that model).\n`
          : "") +
        `Total cost delta: ${delta < 0 ? "−" : "+"}$${Math.abs(delta).toFixed(4)}`
      );
      // UsageStats only refetches on a period change and the SSE stream carries
      // realtime fields only, so a full reload is what actually re-reads costs.
      window.location.reload();
    } catch {
      alert("Failed to recalculate costs");
    } finally {
      setRecalculating(false);
    }
  };

  const handleReset = async () => {
    if (!confirm(
      "Delete ALL usage data?\n\n" +
      "This erases every request record, all daily totals, and the request detail log. " +
      "It cannot be undone from the UI.\n\n" +
      "A backup of the history and totals is saved first under ~/.9router/db/backups " +
      "(the request detail log is NOT included — it is large and auto-pruned)."
    )) return;
    if (prompt('Type "reset" to confirm.') !== "reset") return;

    setResetting(true);
    try {
      const res = await fetch("/api/usage/reset", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to reset usage");
        return;
      }
      alert(
        `Deleted ${data.history} request record(s), ${data.days} day(s) of totals, ` +
        `and ${data.details} detail log(s).` +
        (data.detailsError
          ? `\n\nThe request detail log could not be cleared (${data.detailsError}) — retry the reset.`
          : "") +
        (data.backup ? `\n\nBackup: ${data.backup}` : "\n\nWarning: backup failed.")
      );
      window.location.reload();
    } catch {
      alert("Failed to reset usage");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Period Selector */}
      <Card padding="sm">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">calendar_month</span>
            Time Period:
          </span>
          <SegmentedControl
            options={PERIODS}
            value={period}
            onChange={handlePeriodChange}
            size="sm"
          />
          <Button
            size="sm"
            variant="secondary"
            icon="calculate"
            onClick={handleRecalculate}
            loading={recalculating}
            disabled={recalculating}
            className="sm:ml-auto"
            title="Recompute all stored costs with the pricing currently in effect"
          >
            Recalculate costs
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="delete_sweep"
            onClick={handleReset}
            loading={resetting}
            disabled={resetting}
            title="Delete all usage history, daily totals, and request details"
          >
            Reset usage
          </Button>
        </div>
      </Card>

      {/* Tab Navigation */}
      <div className="border-b border-border -mx-1 sm:mx-0">
        <nav className="flex gap-1 px-1 sm:px-0" aria-label="Analytics tabs">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => handleTabChange(t.value)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all flex items-center gap-1.5 ${
                activeTab === t.value
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-text-muted hover:text-text-main hover:border-border hover:bg-surface-1/50"
              }`}
            >
              <span className="material-symbols-outlined text-base">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="min-h-[400px]">
        {activeTab === "overview" && (
          <Suspense fallback={<CardSkeleton />}>
            <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
          </Suspense>
        )}
        {activeTab === "details" && (
          <Suspense fallback={<CardSkeleton />}>
            <RequestDetailsTab period={period} />
          </Suspense>
        )}
        {activeTab === "logs" && <RequestLogger />}
      </div>
    </div>
  );
}
