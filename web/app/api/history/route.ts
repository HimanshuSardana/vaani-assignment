import { historyPayload, loadRollups, rollupPath } from "@/lib/history";

export const dynamic = "force-dynamic";

/**
 * GET /api/history?station=1[&limit=500]
 *
 * Latency work:
 *  - limit>0 reads only the tail of the WAL (O(limit), not O(file))
 *  - the serialized body is cached per (station, limit) and invalidated by
 *    the WAL's size+mtime, so a hot request does no parsing at all
 *  - a strong ETag lets clients poll for free: If-None-Match -> 304, no body
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const station = parseInt(url.searchParams.get("station") ?? "", 10);
  if (!station) {
    return Response.json({ error: "need ?station=<id>" }, { status: 400 });
  }
  const limit = Math.max(0, parseInt(url.searchParams.get("limit") ?? "0", 10) || 0);
  // ?nocache=1 forces the parse path — used by bench to measure cold latency.
  const bypass = url.searchParams.get("nocache") === "1";

  // Coarse resolutions are served from compaction rollups, not raw readings.
  const resolution = parseInt(url.searchParams.get("resolution") ?? "0", 10);
  if (resolution === 60 || resolution === 3600) {
    try {
      const points = await loadRollups(station, resolution, limit || 5000);
      return new Response(JSON.stringify(points), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-History-Rows": String(points.length),
          "X-History-Source": `rollup-${resolution}s`,
        },
      });
    } catch {
      return Response.json({ error: "no rollups for station yet" }, { status: 404 });
    }
  }

  const t0 = performance.now();
  const payload = await historyPayload(station, limit, bypass);
  if (!payload) {
    return Response.json({ error: "no data for station" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    ETag: payload.etag,
    // Clients should revalidate cheaply rather than serve stale archives.
    "Cache-Control": "no-cache",
    "X-History-Rows": String(payload.rows),
    "X-History-Cache": payload.cached ? "hit" : "miss",
    "X-History-Time": (performance.now() - t0).toFixed(2),
  };

  if (req.headers.get("if-none-match") === payload.etag) {
    return new Response(null, { status: 304, headers });
  }

  headers["Content-Type"] = "application/json";
  return new Response(payload.body, { headers });
}
