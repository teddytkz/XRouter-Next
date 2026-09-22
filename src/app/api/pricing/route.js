import { NextResponse } from "next/server";
import { getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing } from "@/lib/localDb.js";
import { getDefaultPricing } from "open-sse/providers/pricing.js";

const NUMERIC_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

/**
 * Validate one time-of-day rule: { from, to, tz?, days?, ...rates }.
 * Returns an error string, or null when valid.
 */
function validateRule(rule, label) {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    return `Invalid rule for ${label}: must be an object`;
  }
  // 00:00–23:59, plus 24:00 as an end-of-day bound. "24:30" is not a time.
  const timeRe = /^(([01]?\d|2[0-3])(:[0-5]\d)?|24:00)$/;
  if (!timeRe.test(String(rule.from ?? ""))) return `Invalid rule "from" for ${label}: expected HH:MM`;
  if (!timeRe.test(String(rule.to ?? ""))) return `Invalid rule "to" for ${label}: expected HH:MM`;
  if (rule.tz !== undefined) {
    if (typeof rule.tz !== "string" || !isValidTimeZone(rule.tz)) {
      return `Invalid rule "tz" for ${label}: unknown IANA time zone`;
    }
  }
  if (rule.days !== undefined) {
    if (!Array.isArray(rule.days) || rule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return `Invalid rule "days" for ${label}: expected array of weekday numbers 0-6`;
    }
  }
  for (const [key, value] of Object.entries(rule)) {
    if (key === "from" || key === "to" || key === "tz" || key === "days") continue;
    if (!NUMERIC_FIELDS.includes(key)) return `Invalid rule field: ${key} for ${label}`;
    if (!Number.isFinite(value) || value < 0) {
      return `Invalid rule value for ${key} in ${label}: must be non-negative number`;
    }
  }
  return null;
}

// Intl throws on an unknown zone; probe once so a bad `tz` is rejected at the
// boundary instead of silently falling back to server-local at cost time.
function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the full registry-wide price table: every provider's every model with
 * the rates actually in effect (user overrides merged over the built-in tables).
 *
 * Registry-driven on purpose — `getPricing()` only returns PROVIDER_PRICING, the
 * two providers with *overrides*, so it cannot answer "what does model X cost".
 *
 * @returns {Promise<Array<{id, name, icon, models: Array<{id, name, pricing, peak}>>>}
 */
async function buildPricingTable() {
  const { AI_PROVIDERS, resolveProviderId } = await import("@/shared/constants/providers.js");
  const { PROVIDER_MODELS } = await import("open-sse/config/providerModels.js");

  // PROVIDER_MODELS is keyed by registry alias ("gh", "ds") while AI_PROVIDERS is
  // keyed by id ("github", "deepseek"), so resolve each key and skip the pseudo
  // entries that are not providers at all (tts/voice tables).
  const byProvider = new Map();
  for (const [key, models] of Object.entries(PROVIDER_MODELS)) {
    const id = resolveProviderId(key);
    const provider = AI_PROVIDERS[id];
    if (!provider || !Array.isArray(models)) continue;
    if (!byProvider.has(id)) byProvider.set(id, { ...provider, id, models: [] });
    byProvider.get(id).models.push(...models);
  }

  const table = [];
  for (const provider of byProvider.values()) {
    const seen = new Set();
    const rows = [];
    for (const model of provider.models) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      const pricing = await getPricingForModel(provider.id, model.id);
      rows.push({
        id: model.id,
        name: model.name || model.id,
        pricing: pricing || null,
        // Drives the "peak" badge — a model with no rules only ever charges base.
        peak: Array.isArray(pricing?.rules) && pricing.rules.length > 0,
      });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    table.push({
      id: provider.id,
      name: provider.name || provider.id,
      icon: provider.icon || null,
      models: rows,
    });
  }

  table.sort((a, b) => a.name.localeCompare(b.name));
  return table;
}

/**
 * GET /api/pricing
 * Without params: whole merged pricing map (user + defaults).
 * With ?provider=&model=: the resolved rates for that one model — what the
 * per-model editor pre-fills, including any time-of-day rules.
 * With ?table=1: every provider's every model with resolved rates (read-only
 * viewer at /dashboard/pricing).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    if (searchParams.get("table") === "1") {
      return NextResponse.json(await buildPricingTable());
    }

    if (provider && model) {
      const resolved = await getPricingForModel(provider, model);
      return NextResponse.json({ provider, model, pricing: resolved });
    }

    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch pricing" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/pricing
 * Update pricing configuration
 * Body: { provider: { model: { input: number, output: number, cached: number, ... } } }
 */
export async function PATCH(request) {
  try {
    const body = await request.json();

    // Validate body structure
    if (typeof body !== "object" || body === null) {
      return NextResponse.json(
        { error: "Invalid pricing data format" },
        { status: 400 }
      );
    }

    // Validate pricing structure
    for (const [provider, models] of Object.entries(body)) {
      if (typeof models !== "object" || models === null) {
        return NextResponse.json(
          { error: `Invalid pricing for provider: ${provider}` },
          { status: 400 }
        );
      }

      for (const [model, pricing] of Object.entries(models)) {
        if (typeof pricing !== "object" || pricing === null) {
          return NextResponse.json(
            { error: `Invalid pricing for model: ${provider}/${model}` },
            { status: 400 }
          );
        }

        // Validate pricing fields
        for (const [key, value] of Object.entries(pricing)) {
          if (key === "rules") {
            if (!Array.isArray(value)) {
              return NextResponse.json(
                { error: `Invalid rules for ${provider}/${model}: must be an array` },
                { status: 400 }
              );
            }
            for (const rule of value) {
              const err = validateRule(rule, `${provider}/${model}`);
              if (err) return NextResponse.json({ error: err }, { status: 400 });
            }
            continue;
          }
          if (!NUMERIC_FIELDS.includes(key)) {
            return NextResponse.json(
              { error: `Invalid pricing field: ${key} for ${provider}/${model}` },
              { status: 400 }
            );
          }
          // Number.isFinite rejects NaN AND ±Infinity — `isNaN` let Infinity
          // through, which JSON.stringify turns into `null` on the way back out.
          if (!Number.isFinite(value) || value < 0) {
            return NextResponse.json(
              { error: `Invalid pricing value for ${key} in ${provider}/${model}: must be non-negative number` },
              { status: 400 }
            );
          }
        }
      }
    }

    const updatedPricing = await updatePricing(body);
    return NextResponse.json(updatedPricing);
  } catch (error) {
    console.error("Error updating pricing:", error);
    return NextResponse.json(
      { error: "Failed to update pricing" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/pricing
 * Reset pricing to defaults
 * Query params: ?provider=xxx&model=yyy (optional)
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    if (provider && model) {
      // Reset specific model
      await resetPricing(provider, model);
    } else if (provider) {
      // Reset entire provider
      await resetPricing(provider);
    } else {
      // Reset all pricing
      await resetAllPricing();
    }

    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error resetting pricing:", error);
    return NextResponse.json(
      { error: "Failed to reset pricing" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/pricing/defaults
 * Get default pricing configuration
 */
export async function GET_DEFAULTS() {
  try {
    const defaultPricing = getDefaultPricing();
    return NextResponse.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch default pricing" },
      { status: 500 }
    );
  }
}