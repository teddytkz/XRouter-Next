"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

// Only the three rates the user edits. `reasoning` / `cache_creation` are NOT in
// the payload: an override is merged over the resolved base rates, so omitting
// them keeps whatever the provider table already charges for those.
const BASE_FIELDS = ["input", "output", "cached"];

const FIELD_LABELS = {
  input: "Input",
  output: "Output",
  cached: "Cached",
};

function blankRule() {
  return { from: "01:00", to: "12:00", input: "", output: "" };
}

/**
 * Per-model pricing editor. Rates are $ per 1M tokens.
 * Time-of-day rules: { from, to, ...rates } — window in UTC,
 * start-inclusive / end-exclusive; from > to wraps midnight.
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
      for (const field of BASE_FIELDS) {
        const value = parseFloat(rule[field]);
        if (!isNaN(value) && value >= 0) entry[field] = value;
      }
      cleanRules.push(entry);
    }
    if (cleanRules.length) payload.rules = cleanRules;

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
