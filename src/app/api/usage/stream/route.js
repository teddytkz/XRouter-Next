import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// Shared across ALL SSE connections: one heavy getUsageStats at a time, min 2s apart.
// Per-connection recomputation of the "all"-period aggregate was blocking the
// event loop under load (sync better-sqlite3) — this is the hang fix.
const STATS_TTL_MS = 2000;
const ACTIVE_TTL_MS = 500;
const shared = { stats: null, statsAt: 0, statsInFlight: null, active: null, activeAt: 0, activeInFlight: null };

function getStatsShared() {
  if (shared.stats && Date.now() - shared.statsAt < STATS_TTL_MS) return Promise.resolve(shared.stats);
  if (!shared.statsInFlight) {
    shared.statsInFlight = getUsageStats()
      .then((s) => { shared.stats = s; shared.statsAt = Date.now(); return s; })
      .finally(() => { shared.statsInFlight = null; });
  }
  return shared.statsInFlight;
}

function getActiveShared() {
  if (shared.active && Date.now() - shared.activeAt < ACTIVE_TTL_MS) return Promise.resolve(shared.active);
  if (!shared.activeInFlight) {
    shared.activeInFlight = getActiveRequests()
      .then((a) => { shared.active = a; shared.activeAt = Date.now(); return a; })
      .finally(() => { shared.activeInFlight = null; });
  }
  return shared.activeInFlight;
}

export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Full stats refresh (heavy, shared+throttled) + immediate lightweight push
      state.send = async () => {
        if (state.closed) return;
        try {
          if (state.cachedStats) {
            const { activeRequests, recentRequests, errorProvider, live5m } = await getActiveShared();
            const quickStats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider, live5m };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`));
          }
          const stats = await getStatsShared();
          state.cachedStats = stats;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      // Lightweight push: only refresh activeRequests + recentRequests on pending changes
      state.sendPending = async () => {
        if (state.closed || !state.cachedStats) return;
        try {
          const { activeRequests, recentRequests, errorProvider, live5m } = await getActiveShared();
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider, live5m };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
