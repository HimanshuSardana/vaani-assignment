import { promises as fs } from "fs";
import { walPath, type Reading } from "@/lib/history";

export const dynamic = "force-dynamic";

/**
 * GET /api/history-legacy?station=1[&limit=500]
 *
 * BENCHMARK ONLY. This is a faithful copy of the pre-optimization handler, kept
 * so `bench.go` can compare old vs new against the same dataset on the same
 * server. Do not use it from the UI.
 *
 * Deliberately reproduces every original inefficiency:
 *   - reads and splits the entire WAL on every request
 *   - JSON.parses every line
 *   - dedupes first-wins, then sorts the whole set
 *   - slices to `limit` only afterwards
 *   - serializes the full record (no field projection), no cache, no ETag
 */
export async function GET(req: Request) {
  // Benchmark-only: never exposed unless explicitly enabled, so the production
  // route tree contains exactly one history implementation.
  if (process.env.ALLOW_LEGACY !== "1") {
    return new Response("not found", { status: 404 });
  }
  const url = new URL(req.url);
  const station = parseInt(url.searchParams.get("station") ?? "", 10);
  if (!station) {
    return Response.json({ error: "need ?station=<id>" }, { status: 400 });
  }

  const t0 = performance.now();
  let raw: string;
  try {
    raw = await fs.readFile(walPath(station), "utf8");
  } catch {
    return Response.json({ error: "no data for station" }, { status: 404 });
  }

  const byEvent = new Map<string, Reading>();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as Reading;
      if (!r.event_id) continue;
      const cur = byEvent.get(r.event_id);
      if (!cur || r.version > cur.version) byEvent.set(r.event_id, r);
    } catch {
      /* skip torn lines */
    }
  }

  let rows = [...byEvent.values()].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
  );
  const limit = parseInt(url.searchParams.get("limit") ?? "0", 10) || 0;
  if (limit > 0 && rows.length > limit) rows = rows.slice(rows.length - limit);

  return new Response(JSON.stringify(rows), {
    headers: {
      "Content-Type": "application/json",
      "X-History-Time": (performance.now() - t0).toFixed(2),
      "X-History-Rows": String(rows.length),
    },
  });
}
