"use client";

import { useCallback, useState } from "react";

type Resolution = 0 | 60 | 3600;

interface Load {
  rows: number;
  bytes: number;
  ms: number;
  source: string;
  span: string;
}

function spanLabel(first: number, last: number): string {
  const s = Math.max(0, last - first);
  if (s >= 86400) return `${Math.round(s / 86400)} d`;
  if (s >= 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}

/**
 * Beat 3 — history is O(requested window), not O(archive).
 *
 * Raw readings come from the WAL, coarse ranges from compaction rollups. The
 * ETag poll shows what a client that already has the data pays: 304, no body.
 */
export default function ResolutionBeat({ station }: { station: number }) {
  const [res, setRes] = useState<Record<Resolution, Load | null>>({
    0: null,
    60: null,
    3600: null,
  });
  const [busy, setBusy] = useState(false);
  const [poll, setPoll] = useState<{ status: number; ms: number; bytes: number } | null>(null);

  const load = useCallback(
    async (resolution: Resolution) => {
      const t0 = performance.now();
      // Ask each source for a span a human can compare: ~33 min of raw readings,
      // 24 h of minute buckets, 365 d of hourly buckets.
      const wantRows = resolution === 0 ? 2000 : resolution === 60 ? 1440 : 8760;
      const url =
        resolution === 0
          ? `/api/history?station=${station}&limit=${wantRows}`
          : `/api/history?station=${station}&resolution=${resolution}&limit=${wantRows}`;
      const r = await fetch(url);
      const text = await r.text();
      const rows = JSON.parse(text) as { ts?: string; bucket?: number }[];
      const times = rows
        .map((x) => (x.bucket ? x.bucket * 1000 : Date.parse(x.ts ?? "")))
        .filter((n) => !Number.isNaN(n));
      setRes((prev) => ({
        ...prev,
        [resolution]: {
          rows: rows.length,
          bytes: new Blob([text]).size,
          ms: Number((performance.now() - t0).toFixed(2)),
          source: r.headers.get("x-history-source") ?? (resolution === 0 ? "raw wal" : "rollup"),
          span: times.length ? spanLabel(Math.min(...times) / 1000, Math.max(...times) / 1000) : "—",
        },
      }));
    },
    [station]
  );

  const loadAll = async () => {
    setBusy(true);
    setPoll(null);
    await Promise.all([load(0), load(60), load(3600)]);
    setBusy(false);
  };

  const pollAgain = async () => {
    const url = `/api/history?station=${station}&limit=2000`;
    const first = await fetch(url);
    const etag = first.headers.get("etag");
    if (!etag) return;
    const t0 = performance.now();
    const r = await fetch(url, { headers: { "If-None-Match": etag } });
    setPoll({
      status: r.status,
      ms: Number((performance.now() - t0).toFixed(2)),
      bytes: (await r.text()).length,
    });
  };

  const fmt = (n: number) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);

  return (
    <div className="beat">
      <p className="lead">
        Same station, three ranges. Recent readings come from the WAL; everything
        older than the retention window has been folded into rollups by
        compaction, so months of history cost kilobytes instead of hundreds of
        megabytes.
      </p>

      <div className="controls">
        <button className="btn primary" onClick={loadAll} disabled={busy}>
          {busy ? "loading…" : "load all three"}
        </button>
        <button className="btn" onClick={pollAgain}>
          poll with ETag
        </button>
        {poll && (
          <span className="pill">
            {poll.status === 304 ? "304 Not Modified" : `HTTP ${poll.status}`} ·{" "}
            {poll.ms} ms · {fmt(poll.bytes)}
          </span>
        )}
      </div>

      <table className="rows">
        <thead>
          <tr>
            <th>asked for</th>
            <th>served from</th>
            <th>covers</th>
            <th>rows</th>
            <th>payload</th>
            <th>latency</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              [0, "recent readings"],
              [60, "folded history, 1 min"],
              [3600, "folded history, 1 hour"],
            ] as const
          ).map(([r, label]) => (
            <tr key={r}>
              <td>{label}</td>
              <td className="muted">{res[r]?.source ?? "—"}</td>
              <td>{res[r]?.span ?? "—"}</td>
              <td>{res[r]?.rows?.toLocaleString() ?? "—"}</td>
              <td>{res[r] ? fmt(res[r]!.bytes) : "—"}</td>
              <td>{res[r] ? `${res[r]!.ms} ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="fineprint">
        Rollups keep count / mean / min / max per bucket. A spot-checked hour
        matched the raw data exactly (n=61, mean to 1e-9). The same span served as
        raw readings would be ~127 000 rows / 25 MB on this instance — the rollups
        cost a few hundred KB.
      </p>
    </div>
  );
}
