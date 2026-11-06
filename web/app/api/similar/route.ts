import { ewmaCorrelation, listStations, stationSeries } from "@/lib/history";
import { clientKey, rateLimit, sweep } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Batch Pearson over per-bucket means (no recency weighting). */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / (Math.sqrt(da) * Math.sqrt(db));
}

async function batchPearson(aId: number, bId: number, secs: number) {
  const [A, B] = await Promise.all([stationSeries(aId, secs), stationSeries(bId, secs)]);
  const a: number[] = [];
  const b: number[] = [];
  let i = 0;
  let j = 0;
  while (i < A.keys.length && j < B.keys.length) {
    if (A.keys[i] < B.keys[j]) i++;
    else if (B.keys[j] < A.keys[i]) j++;
    else {
      a.push(A.vals[i]);
      b.push(B.vals[j]);
      i++;
      j++;
    }
  }
  return { score: a.length >= 3 ? pearson(a, b) : 0, samples: a.length };
}

/** Mean of the last N (recency-weighted) samples is implicit in λ. */
const DEFAULT_LAMBDA = 0.999;

/**
 * GET /api/similar?station=1&top_k=3[&metric=ewma|pearson][&lambda=0.999]
 *
 * Default metric is EWMA Pearson: exponentially-weighted correlation over the
 * buckets both stations observed, so recent behaviour dominates and the score
 * answers "similar lately" rather than "similar across the whole archive".
 *
 *   λ = 0.999  ≈ last ~1000 buckets   (30s buckets → ~8 hours)
 *   λ = 0.99   ≈ last ~100 buckets    (~50 minutes)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const station = parseInt(url.searchParams.get("station") ?? "", 10);
  const topK = Math.max(
    1,
    Math.min(50, parseInt(url.searchParams.get("top_k") ?? "3", 10) || 3)
  );
  const metric = url.searchParams.get("metric") === "pearson" ? "pearson" : "ewma";
  const lambda = Math.min(
    0.99999,
    Math.max(0.5, parseFloat(url.searchParams.get("lambda") ?? String(DEFAULT_LAMBDA)) || DEFAULT_LAMBDA)
  );
  const bucketSeconds = 30;
  const detrend = url.searchParams.get("detrend") === "1";

  sweep();
  const rl = rateLimit(`similar:${clientKey(req)}`, 60);
  if (!rl.ok) {
    return Response.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  if (!station) {
    return Response.json({ error: "need ?station=<id>" }, { status: 400 });
  }

  const ids = await listStations();
  if (!ids.includes(station)) {
    return Response.json({ error: `unknown station ${station}` }, { status: 404 });
  }

  const ranking: {
    station_id: number;
    score: number;
    overlap_buckets: number;
  }[] = [];

  for (const id of ids) {
    if (id === station) continue;
    const res =
      metric === "ewma"
        ? await ewmaCorrelation(station, id, bucketSeconds, lambda, detrend)
        : await batchPearson(station, id, bucketSeconds);
    if (res.samples < 3) continue; // too little shared history to judge
    ranking.push({
      station_id: id,
      score: Number(res.score.toFixed(4)),
      overlap_buckets: res.samples,
    });
  }

  ranking.sort((x, y) => y.score - x.score);

  return Response.json({
    station,
    metric: metric === "ewma" ? "ewma-pearson" : "pearson",
    ...(metric === "ewma"
      ? { lambda, memory_buckets: Math.round(1 / (1 - lambda)), detrend }
      : {}),
    bucket_seconds: bucketSeconds,
    compared_against: ids.filter((i) => i !== station),
    ranking: ranking.slice(0, topK),
  });
}
