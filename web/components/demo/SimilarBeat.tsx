"use client";

import { useCallback, useEffect, useState } from "react";
import { stationColor } from "../../lib/colors";

interface Sim {
  station: number;
  metric: string;
  lambda?: number;
  memory_buckets?: number;
  detrend?: boolean;
  ranking: { station_id: number; score: number; overlap_buckets: number }[];
}

const MEMORIES: { label: string; lambda: number }[] = [
  { label: "10 buckets (~5 min)", lambda: 0.9 },
  { label: "100 buckets (~50 min)", lambda: 0.99 },
  { label: "1 000 buckets (~8 h)", lambda: 0.999 },
  { label: "10 000 buckets (~3.5 d)", lambda: 0.9999 },
];

/**
 * Beat 4 — the teaching beat.
 *
 * Two levers, both of which change the answer: how much recent history counts
 * (λ), and whether the shared slow trend is removed first (detrend). The second
 * one is the point: the *metric* was never the interesting decision.
 */
export default function SimilarBeat({
  stations,
  initial,
}: {
  stations: number[];
  initial: number;
}) {
  const [station, setStation] = useState(initial);
  const [lambda, setLambda] = useState(0.999);
  const [detrend, setDetrend] = useState(false);
  const [sim, setSim] = useState<Sim | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/similar?station=${station}&top_k=4&lambda=${lambda}&detrend=${detrend ? 1 : 0}`
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSim(await r.json());
    } catch (e) {
      setErr(String(e));
      setSim(null);
    } finally {
      setBusy(false);
    }
  }, [station, lambda, detrend]);

  useEffect(() => {
    run();
  }, [run]);

  const max = Math.max(0.0001, ...(sim?.ranking.map((r) => Math.abs(r.score)) ?? [0]));

  return (
    <div className="beat">
      <p className="lead">
        Which stations behave most like this one? Two knobs decide the answer:
        how far back to look, and whether to remove the trend everything shares.
      </p>

      <div className="controls">
        <label>
          station
          <select value={station} onChange={(e) => setStation(Number(e.target.value))}>
            {stations.map((s) => (
              <option key={s} value={s}>
                Station {String(s).padStart(2, "0")}
              </option>
            ))}
          </select>
        </label>
        <label>
          memory
          <select value={lambda} onChange={(e) => setLambda(Number(e.target.value))}>
            {MEMORIES.map((m) => (
              <option key={m.lambda} value={m.lambda}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="checkline">
          <input
            type="checkbox"
            checked={detrend}
            onChange={(e) => setDetrend(e.target.checked)}
          />
          detrend (compare changes, not levels)
        </label>
        {busy && <span className="muted">computing…</span>}
        {err && <span className="err">{err}</span>}
      </div>

      {sim && (
        <>
          <div className="ranklist">
            {sim.ranking.map((r) => (
              <div className="rankrow" key={r.station_id}>
                <span
                  className="swatch"
                  style={{ background: stationColor(r.station_id) }}
                />
                <span className="rankname">
                  Station {String(r.station_id).padStart(2, "0")}
                </span>
                <span className="rankbar">
                  <i
                    style={{
                      width: `${Math.max(2, (Math.abs(r.score) / max) * 100)}%`,
                      background: stationColor(r.station_id),
                    }}
                  />
                </span>
                <span className="rankscore">{r.score.toFixed(3)}</span>
                <span className="rankoverlap">{r.overlap_buckets.toLocaleString()} buckets</span>
              </div>
            ))}
          </div>
          <p className="fineprint">
            {sim.metric} · λ={sim.lambda} · memory ≈ {sim.memory_buckets} buckets ·{" "}
            {sim.detrend ? "detrended" : "raw levels"} · 30 s buckets
          </p>
        </>
      )}

      <div className="callout">
        <b>Try this:</b> with raw levels every station scores ≈0.92 — they all share
        one slow ramp, so the number is measuring the calendar. Tick <i>detrend</i>
        and the same pair drops to ≈0.44, where the ranking starts to mean
        something. Changing λ moves the window; only detrending changes the
        question.
      </div>
    </div>
  );
}
