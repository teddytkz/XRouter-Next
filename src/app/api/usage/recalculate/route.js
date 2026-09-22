import { NextResponse } from "next/server";
import { recalculateCosts } from "@/lib/usageDb.js";

/**
 * POST /api/usage/recalculate
 * Recompute every stored request's cost with the pricing currently in effect
 * (per-model overrides + time-of-day rules), then shift the daily aggregates by
 * the same delta. Token counts are not touched.
 */
export async function POST() {
  try {
    const result = await recalculateCosts();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error recalculating costs:", error);
    return NextResponse.json(
      { error: "Failed to recalculate costs" },
      { status: 500 }
    );
  }
}
