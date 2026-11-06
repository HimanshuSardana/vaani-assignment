/**
 * Coarse in-process rate limiter for the public demo.
 *
 * One instance, one map. Good enough to stop a runaway scraper; not a
 * substitute for the proxy's limiter (which is where it belongs in production).
 */
const buckets = new Map<string, { tokens: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit = 120,
  windowMs = 60_000
): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { tokens: limit - 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (b.tokens > 0) {
    b.tokens--;
    return { ok: true };
  }
  return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
}

/** Best-effort client identity behind a proxy. */
export function clientKey(req: Request): string {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip") ?? "unknown";
}

/** Keep the in-memory table from growing without bound. */
export function sweep(max = 5000): void {
  if (buckets.size <= max) return;
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}
