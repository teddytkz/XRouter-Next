"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { shadowedRules } from "open-sse/providers/pricing.js";

// Only the three rates the user edits. `reasoning` / `cache_creation` are NOT in
// the payload: an override is merged over the resolved base rates, so omitting
// them keeps whatever the provider table already charges for those.
const BASE_FIELDS = ["input", "output", "cached"];

const FIELD_LABELS = {
  input: "Input",
  output: "Output",
  cached: "Cached",
};

// Index matches the engine's weekday numbering (0 = Sunday), same as Date#getDay.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function blankRule() {
  return { from: "01:00", to: "12:00", input: "", output: "" };
}

/**
 * Per-model pricing editor. Rates are $ per 1M tokens.
 * Time-of-day rules: { from, to, days?, ...rates } — window in UTC,
 * start-inclusive / end-exclusive; from > to wraps midnight. `days` lists the
 * weekdays the rule applies on; unchecking a day excludes it (absent = every day).
 */
export default function ModelPricingModal({ isOpen, onClose, provider, modelId, displayModel }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rates, setRates] = useState({});
  const [rules, setRules] = useState([]);
  const [isOverride, setIsOverride] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/pricing?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(modelId)}`
        );
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        const { rules: loadedRules, ...loadedRates } = data?.pricing || {};
        setRates(loadedRates);
        setRules(Array.isArray(loadedRules) ? loadedRules : []);
        setIsOverride(false);
      } catch {
        if (!cancelled) setRates({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [isOpen, provider, modelId]);

  const setRate = (field, value) => {
    setIsOverride(true);
    setRates((prev) => ({ ...prev, [field]: value }));
  };

  const setRule = (index, patch) => {
    setIsOverride(true);
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const addRule = () => {
    setIsOverride(true);
    setRules((prev) => [...prev, blankRule()]);
  };

  const removeRule = (index) => {
    setIsOverride(true);
    setRules((prev) => prev.filter((_, i) => i !== index));
  };

  // Days a rule fires on. An absent/empty list means "every day" — that is what
  // the engine does, so the UI must read it the same way.
  const activeDays = (rule) =>
    Array.isArray(rule.days) && rule.days.length ? rule.days : [0, 1, 2, 3, 4, 5, 6];

  const toggleDay = (index, day) => {
    setIsOverride(true);
    setRules((prev) =>
      prev.map((rule, i) => {
        if (i !== index) return rule;
        const on = activeDays(rule);
        // Unchecking the last remaining day would leave `days: []`, which the
        // engine reads as "every day" — the opposite of what was clicked. Refuse.
        if (on.length === 1 && on.includes(day)) return rule;
        const next = on.includes(day) ? on.filter((d) => d !== day) : [...on, day].sort((a, b) => a - b);
        const copy = { ...rule };
        // All seven is the same as no filter — drop the field so the stored rule
        // stays terse and matches how the DeepSeek seeds are written.
        if (next.length === 7) delete copy.days;
        else copy.days = next;
        return copy;
      })
    );
  };

  const handleSave = async () => {
    const payload = {};
    for (const field of BASE_FIELDS) {
      const value = parseFloat(rates[field]);
      if (!isNaN(value) && value >= 0) payload[field] = value;
    }
    if (Object.keys(payload).length === 0) {
      alert("Set at least one rate (input or output).");
      return;
    }

    const cleanRules = [];
    for (const rule of rules) {
      if (!rule.from || !rule.to) {
        alert("Every time rule needs a from and to time.");
        return;
      }
      const entry = { from: rule.from, to: rule.to };
      if (Array.isArray(rule.days) && rule.days.length && rule.days.length < 7) {
        entry.days = [...rule.days].sort((a, b) => a - b);
      }
      for (const field of BASE_FIELDS) {
        const value = parseFloat(rule[field]);
        if (!isNaN(value) && value >= 0) entry[field] = value;
      }
      cleanRules.push(entry);
    }

    // A rule fully covered by an earlier one never fires (the engine takes the
    // first match), so it silently does nothing while the earlier, wider window
    // bills at the peak rate — the misconfiguration this guard exists to catch.
    // Warn rather than refuse: an overlapping schedule is sometimes deliberate.
    const shadowed = shadowedRules(cleanRules);
    if (shadowed.length) {
      const list = shadowed.map((i) => `${cleanRules[i].from}–${cleanRules[i].to}`).join(", ");
      if (!confirm(
        `These rules can never take effect: ${list}.\n\n` +
        "An earlier rule already covers every hour they apply to, and the first " +
        "matching rule wins — so the earlier one is what actually gets charged.\n\n" +
        "Save anyway?"
      )) return;
    }

    // Send the array whenever the rules shown were non-empty OR the user touched
    // anything, so clearing the last rule actually clears the schedule. Omitting
    // the key keeps the base rules, which made "remove all rules" a no-op.
    if (cleanRules.length || isOverride) payload.rules = cleanRules;

    setSaving(true);
    try {
      const res = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [provider]: { [modelId]: payload } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Failed to save pricing");
        return;
      }
      onClose();
    } catch {
      alert("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm(`Reset pricing for ${modelId} to defaults?`)) return;
    setSaving(true);
    try {
      await fetch(
        `/api/pricing?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(modelId)}`,
        { method: "DELETE" }
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Model Pricing"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={handleReset} disabled={saving} className="mr-auto">
            Reset to default
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={loading}>
            Save
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-text-muted">Loading pricing…</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <code className="block truncate rounded bg-sidebar px-2 py-1 font-mono text-xs text-text-muted">
              {displayModel || `${provider}/${modelId}`}
            </code>
            <p className="mt-2 text-xs text-text-muted">
              Rates in <strong>$ per 1M tokens</strong>. {isOverride
                ? "Unsaved changes."
                : "These are the rates currently in effect for this model."}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-text-muted">Base rates</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {BASE_FIELDS.map((field) => (
                <label key={field} className="flex flex-col gap-1">
                  <span className="text-xs text-text-muted">{FIELD_LABELS[field]}</span>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={rates[field] ?? ""}
                    onChange={(e) => setRate(field, e.target.value)}
                    placeholder="—"
                    className="w-full rounded border border-border bg-background px-2 py-1 text-right text-sm focus:border-primary focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase text-text-muted">
                Time-of-day rules
              </p>
              <Button size="sm" variant="secondary" icon="add" onClick={addRule}>
                Add rule
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className="text-xs text-text-muted">
                No rules. Add one to charge a different rate during certain hours
                (e.g. 01:00–12:00 at $0.10/1M). Windows are in <strong>UTC</strong>;
                a window whose start is later than its end wraps past midnight.
                Toggle the days a rule applies to — all on means every day.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {rules.map((rule, index) => (
                  <div key={index} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-text-muted">From</span>
                        <input
                          type="time"
                          value={rule.from ?? ""}
                          onChange={(e) => setRule(index, { from: e.target.value })}
                          className="rounded border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-text-muted">To</span>
                        <input
                          type="time"
                          value={rule.to ?? ""}
                          onChange={(e) => setRule(index, { to: e.target.value })}
                          className="rounded border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
                        />
                      </label>
                      <button
                        onClick={() => removeRule(index)}
                        className="ml-auto rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                        title="Remove rule"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {BASE_FIELDS.map((field) => (
                        <label key={field} className="flex flex-col gap-1">
                          <span className="text-xs text-text-muted">{FIELD_LABELS[field]}</span>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            value={rule[field] ?? ""}
                            onChange={(e) => setRule(index, { [field]: e.target.value })}
                            placeholder="—"
                            className="w-full rounded border border-border bg-background px-2 py-1 text-right text-sm focus:border-primary focus:outline-none"
                          />
                        </label>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-start gap-2">
                      {DAYS.map((label, day) => {
                        const on = activeDays(rule).includes(day);
                        return (
                          <label
                            key={day}
                            title={`${label} — ${on ? "included" : "excluded"}`}
                            className="flex cursor-pointer flex-col items-center gap-1"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleDay(index, day)}
                              className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
                            />
                            <span className={`text-xs ${on ? "text-text" : "text-text-muted"}`}>
                              {label[0]}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

ModelPricingModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  provider: PropTypes.string.isRequired,
  modelId: PropTypes.string.isRequired,
  displayModel: PropTypes.string,
};
