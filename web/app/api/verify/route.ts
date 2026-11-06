import { loadHistoryUncached, loadTailHistory, listStations } from "@/lib/history";
import { clientKey, rateLimit, sweep } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * GET /api/verify?station=1&limit=500
 *
 * Proves the optimisation is semantic-preserving by answering *the same
 * question twice in one request*: a full canonical read, and a tail read of
 * the same file, then diffing them. Doing both server-side on one snapshot
 * avoids the race you'd get from two separate HTTP calls on a live archive.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const station = parseInt(url.searchParams.get("station") ?? "", 10);
  const limit = Math.max(1, Math.min(5000, parseInt(url.searchParams.get("limit") ?? "500", 10) || 500));

  sweep();
  const rl = rateLimit(`verify:${clientKey(req)}`, 60);
  if (!rl.ok) {
    return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const ids = await listStations();
  if (!station || !ids.includes(station)) {
    return Response.json({ error: "unknown station" }, { status: 404 });
  }

  // Deliberately uncached: the point is to compare a real full parse against a
  // real tail read, not to measure which one is already warm in memory.
  const t0 = performance.now();
  const full = await loadHistoryUncached(station);
  const fullMs = performance.now() - t0;

  const t1 = performance.now();
  const tail = await loadTailHistory(station, limit);
  const tailMs = performance.now() - t1;

  const expected = full.slice(-limit).map((r) => r.event_id);
  const got = tail.map((r) => r.event_id);
  const identical =
    expected.length === got.length && expected.every((id, i) => id === got[i]);

  return Response.json({
    station,
    limit,
    identical,
    full: { rows: full.length, ms: Number(fullMs.toFixed(2)) },
    tail: { rows: tail.length, ms: Number(tailMs.toFixed(2)) },
    // First point where the two disagree, so a failure is diagnosable rather
    // than just red.
    firstMismatch:
      identical ? null : expected.findIndex((id, i) => id !== got[i]) >= 0
        ? { index: expected.findIndex((id, i) => id !== got[i]), full: expected.find((id) => !got.includes(id)) ?? null, tail: got.find((id) => !expected.includes(id)) ?? null }
        : { index: Math.min(expected.length, got.length), full: null, tail: null },
  });
}
