import { NextResponse } from "next/server";
import { poolFitnessSnapshot } from "open-sse/services/proxyPoolFitness.js";

// GET /api/proxy-pools/fitness — active pool-fitness rows for the dashboard.
// Auth: dashboardGuard middleware (deny-by-default /api/*).
export async function GET() {
  try {
    return NextResponse.json({ pools: await poolFitnessSnapshot() });
  } catch (error) {
    console.log("Error reading proxy fitness:", error);
    return NextResponse.json({ error: "Failed to read proxy fitness" }, { status: 500 });
  }
}
