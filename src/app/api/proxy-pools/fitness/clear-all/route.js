import { NextResponse } from "next/server";
import { clearAllPoolUnfit } from "open-sse/services/proxyPoolFitness.js";

// POST /api/proxy-pools/fitness/clear-all — clear all pool fitness, or only
// rows for one provider when { provider } is supplied.
// Auth: dashboardGuard middleware (deny-by-default /api/*).
export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty body = clear all */ }
    const provider = typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
    const ok = await clearAllPoolUnfit(provider);
    if (!ok) return NextResponse.json({ error: "Failed to clear proxy fitness" }, { status: 500 });
    return NextResponse.json({ ok: true, provider });
  } catch (error) {
    console.log("Error clearing proxy fitness:", error);
    return NextResponse.json({ error: "Failed to clear proxy fitness" }, { status: 500 });
  }
}
