"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MiniChart, { MiniSeries } from "../MiniChart";
import { stationColor } from "../../lib/colors";

interface Rec {
  station: number;
  id: string;
  version: number;
  t: number;
  v: number;
}

/**
 * Beat 1 — the pathologies, in the browser.
 *
 * A tiny station simulator runs client-side so this beat works even if the
 * backend is down: every interval each station either reports normally, or
 * delivers late / duplicated / corrected / out of order. The same records are
 * then shown two ways — arrival order (what the wire looks like) and canonical
 * history (what the reader returns) — which is the whole point of the data
 * model in one picture.
 */
export default function ChaosBeat() {
  const [dup, setDup] = useState(20);
  const [reorder, setReorder] = useState(25);
  const [late, setLate] = useState(15);
  const [corr, setCorr] = useState(10);
  const [running, setRunning] = useState(true);
  const [view, setView] = useState<"arrival" | "canonical">("arrival");
  const [counts, setCounts] = useState({ total: 0, dup: 0, corr: 0, late: 0, ooo: 0 });

  const emitted = useRef<Rec[]>([]);
  const canon = useRef(new Map<string, Rec>());
  const recent = useRef<Rec[]>([]);
  const seq = useRef(0);
  const [, force] = useState(0);

  const params = useRef({ dup, reorder, late, corr });
  params.current = { dup, reorder, late, corr };

  useEffect(() => {
    const t = setInterval(() => {
      if (!running) return;
      const p = params.current;
      const now = Date.now();
      const batch: Rec[] = [];

      for (let s = 1; s <= 3; s++) {
        seq.current++;
        // Late by seconds, not minutes: enough to break the order visibly
        // without turning the chart into a spider web.
        const t0 = now - (Math.random() < p.late / 100 ? 3_000 + Math.random() * 9_000 : 0);
        const rec: Rec = {
          station: s,
          id: `s${s}:${seq.current}`,
          version: 1,
          t: t0,
          v: 22 + s * 1.2 + 4 * Math.sin(seq.current / 6 + s) + (Math.random() - 0.5),
        };
        batch.push(rec);
        recent.current.push(rec);
        if (recent.current.length > 40) recent.current.shift();

        // duplicate: byte-identical resend
        if (Math.random() < p.dup / 100 && recent.current.length > 3) {
          const dupRec = recent.current[Math.floor(Math.random() * recent.current.length)];
          batch.push({ ...dupRec, t: dupRec.t });
        }
        // correction: same id, version bump, revised value
        if (Math.random() < p.corr / 100 && recent.current.length > 3) {
          const orig = recent.current[Math.floor(Math.random() * recent.current.length)];
          batch.push({ ...orig, version: orig.version + 1, v: orig.v + (Math.random() - 0.5) * 3 });
        }
      }

      // reorder: swap neighbours rather than shuffling the whole batch, so the
      // line stays readable while still arriving out of order
      if (Math.random() < params.current.reorder / 100) {
        for (let i = 1; i < batch.length; i++) {
          if (Math.random() < 0.5) {
            const j = Math.max(0, i - 1 - Math.floor(Math.random() * 2));
            [batch[i], batch[j]] = [batch[j], batch[i]];
          }
        }
      }

      let dupN = 0;
      let corrN = 0;
      let lateN = 0;
      for (const r of batch) {
        emitted.current.push(r);
        const cur = canon.current.get(r.id);
        if (cur && r.version <= cur.version) dupN++;
        else {
          if (cur) corrN++;
          if (now - r.t > 5000) lateN++;
          canon.current.set(r.id, r);
        }
      }
      if (emitted.current.length > 600) emitted.current.splice(0, emitted.current.length - 600);

      setCounts((c) => ({
        total: c.total + batch.length,
        dup: c.dup + dupN,
        corr: c.corr + corrN,
        late: c.late + lateN,
        ooo: c.ooo + (Math.random() < params.current.reorder / 100 ? 1 : 0),
      }));
      force((n) => n + 1);
    }, 420);
    return () => clearInterval(t);
  }, [running]);

  const reset = useCallback(() => {
    emitted.current = [];
    canon.current = new Map();
    recent.current = [];
    seq.current = 0;
    setCounts({ total: 0, dup: 0, corr: 0, late: 0, ooo: 0 });
  }, []);

  const series: MiniSeries[] = [1, 2, 3].map((s) => {
    const all =
      view === "arrival"
        ? emitted.current.filter((r) => r.station === s)
        : [...canon.current.values()].filter((r) => r.station === s).sort((a, b) => a.t - b.t);
    const pts = all.slice(-45); // keep the picture legible
    return {
      id: s,
      color: stationColor(s),
      points: pts.map((r) => ({ t: r.t, v: r.v })),
    };
  });

  return (
    <div className="beat">
      <p className="lead">
        Three simulated stations. Move the sliders and the archive gets uglier —
        then flip the view: the reader returns the same clean history either way.
      </p>

      <div className="sliders">
        {(
          [
            ["duplicates", dup, setDup],
            ["out of order", reorder, setReorder],
            ["late arrivals", late, setLate],
            ["corrections", corr, setCorr],
          ] as const
        ).map(([label, val, set]) => (
          <label key={label} className="slider">
            <span>
              {label} <b>{val}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={60}
              value={val}
              onChange={(e) => set(Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      <div className="viewswitch">
        <button
          className={`chip${view === "arrival" ? " on" : ""}`}
          onClick={() => setView("arrival")}
        >
          arrival order
        </button>
        <button
          className={`chip${view === "canonical" ? " on" : ""}`}
          onClick={() => setView("canonical")}
        >
          canonical history
        </button>
        <span className="spacer" />
        <button className="chip" onClick={() => setRunning((r) => !r)}>
          {running ? "pause" : "resume"}
        </button>
        <button className="chip" onClick={reset}>
          reset
        </button>
      </div>

      <div className="chartbox">
        <MiniChart
          series={series}
          height={200}
          xLabel={view === "arrival" ? "event time → (as received, out of order)" : "event time → (deduped, version-merged)"}
          yLabel="value"
          dots={view === "arrival"}
        />
      </div>

      <div className="counters">
        <span>records {counts.total}</span>
        <span>duplicates dropped {counts.dup}</span>
        <span>corrections applied {counts.corr}</span>
        <span>late repaired {counts.late}</span>
        <span>shuffles {counts.ooo}</span>
        <span className="muted">
          view: {view === "arrival" ? "as received" : "deduped, version-merged, time-ordered"}
        </span>
      </div>
    </div>
  );
}
