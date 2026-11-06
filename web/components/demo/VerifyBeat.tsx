"use client";

import { useCallback, useState } from "react";

/**
 * Beat 2 — the optimisation is semantic-preserving.
 *
 * One request answers the same question twice on one snapshot (full scan vs
 * tail read) and diffs the event ids. This is the check a benchmark normally
 * skips, and it is the one that caught a real id-reuse bug.
 */
export default function VerifyBeat({ station }: { station: number }) {
  const [limit, setLimit] = useState(500);
  const [res, setRes] = useState<null | {
    identical: boolean;
    full: { rows: number; ms: number };
    tail: { rows: number; ms: number };
    firstMismatch: unknown;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/verify?station=${station}&limit=${limit}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRes(await r.json());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [station, limit]);

  const speedup = res && res.tail.ms > 0 ? res.full.ms / res.tail.ms : 0;

  return (
    <div className="beat">
      <p className="lead">
        The same 500 rows, two implementations, one snapshot. The tail read walks
        backwards from the end of the file; the full read parses everything.
      </p>

      <div className="controls">
        <label>
          limit
          <input
            type="number"
            min={1}
            max={5000}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </label>
        <button className="btn primary" onClick={run} disabled={busy}>
          {busy ? "checking…" : `verify station ${station}`}
        </button>
        {err && <span className="err">{err}</span>}
      </div>

      {res && (
        <div className="result">
          <div className={`verdict ${res.identical ? "ok" : "bad"}`}>
            {res.identical ? "identical ✓" : "MISMATCH ✗"}
            <span className="verdict-sub">
              {res.tail.rows} rows compared by event id
            </span>
          </div>
          <table className="kv">
            <tbody>
              <tr>
                <td>tail read</td>
                <td>
                  <b>{res.tail.ms} ms</b>
                </td>
                <td className="muted">{res.tail.rows} rows</td>
              </tr>
              <tr>
                <td>full read</td>
                <td>{res.full.ms} ms</td>
                <td className="muted">{res.full.rows} rows</td>
              </tr>
              <tr>
                <td>difference</td>
                <td colSpan={2}>
                  {speedup >= 1 ? (
                    <b>{speedup.toFixed(1)}× faster</b>
                  ) : (
                    <span className="muted">file is small; no advantage yet</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          {!res.identical && (
            <pre className="code">{JSON.stringify(res.firstMismatch, null, 2)}</pre>
          )}
          <p className="fineprint">
            Server-side, both reads run on the same file, so the comparison cannot
            be skewed by new data arriving between calls.
          </p>
        </div>
      )}
    </div>
  );
}
