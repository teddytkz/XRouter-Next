import { NextResponse } from "next/server";
import { resetUsage } from "@/lib/usageDb.js";

/**
 * POST /api/usage/reset
 * Delete all usage data: per-request history, daily aggregates, and the
 * observability detail log. A DB backup is taken first — see resetUsage().
 */
export async function POST() {
  try {
    const result = await resetUsage();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error resetting usage:", error);
    return NextResponse.json(
      { error: "Failed to reset usage" },
      { status: 500 }
    );
  }
}
