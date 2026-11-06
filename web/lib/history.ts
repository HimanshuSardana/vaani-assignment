import { promises as fs } from "fs";
import path from "path";

export interface Reading {
  station_id: number;
  event_id: string;
  seq?: number;
  version: number;
  ts: string;
  emitted_at?: string;
  value: number;
  archetype?: string;
  is_duplicate?: boolean;
  is_correction?: boolean;
  late_by_s?: number;
}

/** WAL directory: ../logs relative to web/, overridable via DATA_DIR. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "..", "logs");
}

export async function listStations(): Promise<number[]> {
  let files: string[];
  try {
    files = await fs.readdir(dataDir());
  } catch {
    return [];
  }
  const ids: number[] = [];
  for (const f of files) {
    const m = /^wal-(\d+)\.jsonl$/.exec(f);
    if (m) ids.push(parseInt(m[1], 10));
  }
  return ids.sort((a, b) => a - b);
}

export function walPath(station: number): string {
  return path.join(dataDir(), `wal-${station}.jsonl`);
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function parseLines(lines: string[]): Reading[] {
  const out: Reading[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as Reading;
      if (r.event_id) out.push(r);
    } catch {
      /* torn line mid-write */
    }
  }
  return out;
}

/**
 * Higher version wins; on a version tie the later sighting wins, so the result
 * does not depend on whether we read the whole WAL or only its tail.
 */
function supersedes(next: Reading, cur: Reading): boolean {
  if (next.version !== cur.version) return next.version > cur.version;
  const a = next.emitted_at ?? next.ts;
  const b = cur.emitted_at ?? cur.ts;
  return a > b;
}

/** Dedupe on event_id (highest version wins), then sort by event time. */
function canonical(readings: Reading[]): Reading[] {
  const byEvent = new Map<string, Reading>();
  for (const r of readings) {
    const cur = byEvent.get(r.event_id);
    if (!cur || supersedes(r, cur)) byEvent.set(r.event_id, r);
  }
  return [...byEvent.values()].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
  );
}

const TAIL_CHUNK = 64 * 1024;

/**
 * Read only the last `wantLines` data lines of a WAL by walking backwards
 * from EOF. The WAL grows without bound, so this keeps `limit`-style queries
 * O(limit) instead of O(file).
 */
async function readTailLines(file: string, wantLines: number): Promise<string[]> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    let pos = size;
    let carry = ""; // leading partial line of the chunk we just read
    const collected: string[] = [];

    while (pos > 0 && collected.length < wantLines) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, pos);
      const text = buf.toString("utf8") + carry;
      const parts = text.split("\n");
      carry = parts.shift() ?? "";
      // parts are in file order; newer lines are appended to `collected`.
      const data = parts.filter((p) => p.startsWith("{"));
      if (data.length) collected.unshift(...data);
    }
    // Reached the start of the file: `carry` is a real first line (no \n).
    if (pos === 0 && carry.startsWith("{")) collected.unshift(carry);

    // Keep only the newest `wantLines`.
    return collected.length > wantLines
      ? collected.slice(collected.length - wantLines)
      : collected;
  } finally {
    await fh.close();
  }
}

/* ------------------------------------------------------------------ *
 * Loading (with stat-keyed caching)
 * ------------------------------------------------------------------ */

interface FullEntry {
  size: number;
  mtimeMs: number;
  rows: Reading[];
}
const fullCache = new Map<number, FullEntry>();
const FULL_CACHE_MAX = 32;

/** Whole-file canonical history. Cached per station, invalidated by size/mtime. */
export async function loadHistory(station: number): Promise<Reading[]> {
  const file = walPath(station);
  const stat = await fs.stat(file);
  const hit = fullCache.get(station);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return hit.rows;
  }
  const raw = await fs.readFile(file, "utf8");
  const rows = canonical(parseLines(raw.split("\n")));
  if (fullCache.size >= FULL_CACHE_MAX) {
    const oldest = fullCache.keys().next().value;
    if (oldest !== undefined) fullCache.delete(oldest);
  }
  fullCache.set(station, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
  return rows;
}

/**
 * Newest `limit` canonical readings. Reads only the tail of the WAL.
 * Falls back to the whole file when the tail cannot satisfy `limit`.
 */
export async function loadTailHistory(
  station: number,
  limit: number
): Promise<Reading[]> {
  if (limit <= 0) return loadHistory(station);
  // Over-read to absorb duplicates, corrections and torn lines.
  const wantLines = Math.max(64, Math.ceil(limit * 1.5) + 32);
  const tail = await readTailLines(walPath(station), wantLines);
  const rows = canonical(parseLines(tail));
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}

/* ------------------------------------------------------------------ *
 * Serialized responses (what the HTTP route actually sends)
 * ------------------------------------------------------------------ */

/** Fields the dashboard/benchmark consume; keeps payload small. */
function project(r: Reading): Reading {
  const out: Reading = {
    station_id: r.station_id,
    event_id: r.event_id,
    version: r.version,
    ts: r.ts,
    value: r.value,
  };
  if (r.is_duplicate) out.is_duplicate = true;
  if (r.is_correction) out.is_correction = true;
  if (r.late_by_s) out.late_by_s = r.late_by_s;
  return out;
}

export interface HistoryPayload {
  body: string;
  rows: number;
  etag: string;
  size: number;
  mtimeMs: number;
  cached: boolean;
}

interface BodyEntry {
  size: number;
  mtimeMs: number;
  body: string;
  rows: number;
  etag: string;
}
const bodyCache = new Map<string, BodyEntry>();
const BODY_CACHE_MAX = 64;

/**
 * Serialized history for (station, limit) with a strong ETag derived from the
 * WAL's size+mtime. Repeat requests can answer 304 with no body at all.
 */
export async function historyPayload(
  station: number,
  limit: number,
  bypassCache = false
): Promise<HistoryPayload | null> {
  const file = walPath(station);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return null;
  }
  const key = `${station}:${limit}`;
  const etag = `W/"${station}-${limit}-${stat.size.toString(16)}-${Math.floor(
    stat.mtimeMs
  ).toString(16)}"`;

  const hit = bypassCache ? undefined : bodyCache.get(key);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return {
      body: hit.body,
      rows: hit.rows,
      etag: hit.etag,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      cached: true,
    };
  }

  const rows = limit > 0 ? await loadTailHistory(station, limit) : await loadHistory(station);
  const body = JSON.stringify(rows.map(project));
  const entry: BodyEntry = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    body,
    rows: rows.length,
    etag,
  };
  if (bodyCache.size >= BODY_CACHE_MAX) {
    const oldest = bodyCache.keys().next().value;
    if (oldest !== undefined) bodyCache.delete(oldest);
  }
  bodyCache.set(key, entry);
  return { ...entry, cached: false };
}

/* ------------------------------------------------------------------ *
 * Bucketed rollups (what similarity actually consumes)
 * ------------------------------------------------------------------ */

export function bucketMeans(rows: Reading[], secs: number): Map<number, number> {
  const sum = new Map<number, number>();
  const n = new Map<number, number>();
  const ms = secs * 1000;
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    const b = Math.floor(t / ms);
    sum.set(b, (sum.get(b) ?? 0) + r.value);
    n.set(b, (n.get(b) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (const [b, s] of sum) out.set(b, s / (n.get(b) ?? 1));
  return out;
}

interface BucketEntry {
  size: number;
  mtimeMs: number;
  means: Map<number, number>;
}
const bucketCache = new Map<string, BucketEntry>();
const BUCKET_CACHE_MAX = 64;

/**
 * Per-station per-bucket means, cached on the WAL's size+mtime.
 * Similarity recomputed these over the whole archive on every request, which
 * is O(history) of `Date.parse` calls — by far the dominant cost at scale.
 */
export async function stationBuckets(
  station: number,
  secs: number
): Promise<Map<number, number>> {
  const stat = await fs.stat(walPath(station));
  const key = `${station}:${secs}`;
  const hit = bucketCache.get(key);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return hit.means;
  }
  const means = bucketMeans(await loadHistory(station), secs);
  if (bucketCache.size >= BUCKET_CACHE_MAX) {
    const oldest = bucketCache.keys().next().value;
    if (oldest !== undefined) bucketCache.delete(oldest);
  }
  bucketCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, means });
  return means;
}

/* ------------------------------------------------------------------ *
 * EWMA correlation (recency-weighted, the live metric)
 * ------------------------------------------------------------------ */

interface SeriesEntry {
  size: number;
  mtimeMs: number;
  keys: number[];
  vals: number[];
}
const seriesCache = new Map<string, SeriesEntry>();
const SERIES_CACHE_MAX = 32;

/** Sorted (bucket, mean) arrays per station — the form the streaming maths needs. */
export async function stationSeries(
  station: number,
  secs: number
): Promise<{ keys: number[]; vals: number[] }> {
  const stat = await fs.stat(walPath(station));
  const key = `${station}:${secs}`;
  const hit = seriesCache.get(key);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return { keys: hit.keys, vals: hit.vals };
  }
  const means = await stationBuckets(station, secs);
  const keys = [...means.keys()].sort((a, b) => a - b);
  const vals = new Array<number>(keys.length);
  for (let i = 0; i < keys.length; i++) vals[i] = means.get(keys[i])!;
  if (seriesCache.size >= SERIES_CACHE_MAX) {
    const oldest = seriesCache.keys().next().value;
    if (oldest !== undefined) seriesCache.delete(oldest);
  }
  seriesCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, keys, vals });
  return { keys, vals };
}

export interface EwmaScore {
  score: number;
  samples: number;
  cached: boolean;
}

interface PairEntry {
  aSize: number;
  aMtime: number;
  bSize: number;
  bMtime: number;
  score: number;
  samples: number;
}
const pairCache = new Map<string, PairEntry>();
const PAIR_CACHE_MAX = 512;

/**
 * Exponentially-weighted Pearson over the buckets both stations observed.
 *
 *   x̄ ← λx̄ + (1−λ)x ,  ȳ ← λȳ + (1−λ)y
 *   Cxy ← λCxy + (1−λ)(x−x̄)(y−ȳ)   (likewise Cxx, Cyy)
 *   r = Cxy / √(Cxx·Cyy)
 *
 * Streams the merged bucket timeline once (two-pointer, no allocation), so it
 * is O(buckets) with constant state — the same maths a live updater would run
 * per sample, replayed over stored history.
 */
export async function ewmaCorrelation(
  aId: number,
  bId: number,
  secs: number,
  lambda: number
): Promise<EwmaScore> {
  const [sa, sb] = await Promise.all([fs.stat(walPath(aId)), fs.stat(walPath(bId))]);
  const key = `${Math.min(aId, bId)}:${Math.max(aId, bId)}:${secs}:${lambda}`;
  const hit = pairCache.get(key);
  if (
    hit &&
    hit.aSize === sa.size &&
    hit.aMtime === sa.mtimeMs &&
    hit.bSize === sb.size &&
    hit.bMtime === sb.mtimeMs
  ) {
    return { score: hit.score, samples: hit.samples, cached: true };
  }

  const [{ keys: ka, vals: va }, { keys: kb, vals: vb }] = await Promise.all([
    stationSeries(aId, secs),
    stationSeries(bId, secs),
  ]);

  let mx = 0;
  let my = 0;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  let samples = 0;
  let started = false;
  const decay = lambda;
  const gain = 1 - lambda;

  let i = 0;
  let j = 0;
  while (i < ka.length && j < kb.length) {
    if (ka[i] < kb[j]) {
      i++;
    } else if (kb[j] < ka[i]) {
      j++;
    } else {
      const x = va[i];
      const y = vb[j];
      if (!started) {
        mx = x;
        my = y;
        started = true;
      } else {
        mx = decay * mx + gain * x;
        my = decay * my + gain * y;
        const dx = x - mx;
        const dy = y - my;
        cxx = decay * cxx + gain * dx * dx;
        cyy = decay * cyy + gain * dy * dy;
        cxy = decay * cxy + gain * dx * dy;
      }
      samples++;
      i++;
      j++;
    }
  }

  const denom = Math.sqrt(cxx * cyy);
  const score = denom > 0 ? cxy / denom : 0;

  if (pairCache.size >= PAIR_CACHE_MAX) {
    const oldest = pairCache.keys().next().value;
    if (oldest !== undefined) pairCache.delete(oldest);
  }
  pairCache.set(key, {
    aSize: sa.size,
    aMtime: sa.mtimeMs,
    bSize: sb.size,
    bMtime: sb.mtimeMs,
    score,
    samples,
  });

  return { score, samples, cached: false };
}

/* ------------------------------------------------------------------ *
 * Rollups (compacted history for long ranges)
 * ------------------------------------------------------------------ */

export interface RollupPoint {
  bucket: number; // unix seconds, truncated to `res`
  n: number;
  mean: number;
  min: number;
  max: number;
}

export function rollupPath(station: number, res: number): string {
  return path.join(dataDir(), `rollup-${station}-${res}.jsonl`);
}

interface RollupEntry {
  size: number;
  mtimeMs: number;
  rows: RollupPoint[];
}
const rollupCache = new Map<string, RollupEntry>();
const ROLLUP_CACHE_MAX = 32;

/** Newest `limit` rollup buckets at the given resolution (60 or 3600 s). */
export async function loadRollups(
  station: number,
  res: number,
  limit: number
): Promise<RollupPoint[]> {
  const file = rollupPath(station, res);
  const stat = await fs.stat(file);
  const key = `${station}:${res}:${limit}`;
  const hit = rollupCache.get(key);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return hit.rows;
  }
  const want = limit > 0 ? Math.max(64, limit + 16) : Infinity;
  const raw = want === Infinity ? await fs.readFile(file, "utf8") : (await readTailLines(file, want)).join("\n");
  const rows: RollupPoint[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const p = JSON.parse(line) as RollupPoint;
      if (typeof p.bucket === "number" && p.n > 0) rows.push(p);
    } catch {
      /* torn line */
    }
  }
  rows.sort((a, b) => a.bucket - b.bucket);
  const trimmed = limit > 0 && rows.length > limit ? rows.slice(rows.length - limit) : rows;
  if (rollupCache.size >= ROLLUP_CACHE_MAX) {
    const oldest = rollupCache.keys().next().value;
    if (oldest !== undefined) rollupCache.delete(oldest);
  }
  rollupCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, rows: trimmed });
  return trimmed;
}
