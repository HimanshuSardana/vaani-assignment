"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import StationChart, { ChartPoint, ChartSeries } from "../components/StationChart";
import { stationColor } from "../lib/colors";

interface Pt extends ChartPoint {
  ver: number;
}
interface St {
  color: string;
  pts: Map<string, Pt>;
  dups: number;
  corr: number;
  late: number;
}
interface Stat {
  pts: number;
  dups: number;
  corr: number;
  late: number;
}

interface Incoming {
  station_id: number;
  event_id: string;
  version: number;
  ts: string;
  value: number;
  is_duplicate?: boolean;
  late_by_s?: number;
}

export default function Page() {
  const [ids, setIds] = useState<number[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [stats, setStats] = useState<Record<number, Stat>>({});
  const [windowSec, setWindowSec] = useState(900);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);

  const dataRef = useRef(new Map<number, St>());
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const lastPaint = useRef(0);

  const poke = useCallback(() => {
    // Re-render at most ~4x/sec; the canvas animates at 60fps between pokes.
    const now = performance.now();
    if (now - lastPaint.current > 250) {
      lastPaint.current = now;
      const s: Record<number, Stat> = {};
      for (const [id, st] of dataRef.current) {
        s[id] = { pts: st.pts.size, dups: st.dups, corr: st.corr, late: st.late };
      }
      setStats(s);
      setTick((t) => t + 1);
    }
  }, []);

  const ingest = useCallback((r: Incoming) => {
    let st = dataRef.current.get(r.station_id);
    if (!st) {
      st = {
        color: stationColor(r.station_id),
        pts: new Map(),
        dups: 0,
        corr: 0,
        late: 0,
      };
      dataRef.current.set(r.station_id, st);
    }
    if (r.is_duplicate) {
      st.dups++;
      return;
    }
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) return;
    const prev = st.pts.get(r.event_id);
    if (!prev || r.version > prev.ver) {
      if (prev) st.corr++;
      else if ((r.late_by_s ?? 0) > 0) st.late++;
      st.pts.set(r.event_id, { t, v: r.value, ver: r.version });
    }
  }, []);

  const loadStation = useCallback(
    async (id: number) => {
      const st = dataRef.current.get(id);
      if (st && st.pts.size > 0) return;
      try {
        const hist = (await (
          await fetch(`/api/history?station=${id}&limit=2000`)
        ).json()) as Incoming[];
        hist.forEach(ingest);
        poke();
      } catch {
        /* station has no data yet */
      }
    },
    [ingest, poke]
  );

  // Boot: stations -> select first 3 -> history -> live stream.
  useEffect(() => {
    let es: EventSource | undefined;
    (async () => {
      const list = (await (await fetch("/api/stations")).json()) as number[];
      setIds(list);
      const first = list.slice(0, 3);
      setSelected(first);
      await Promise.all(first.map(loadStation));
      es = new EventSource("/api/stream");
      es.onmessage = (ev) => {
        if (pausedRef.current) return;
        try {
          ingest(JSON.parse(ev.data) as Incoming);
        } catch {
          /* torn line */
        }
        poke();
      };
    })();
    return () => es?.close();
  }, [ingest, loadStation, poke]);

  const toggle = (id: number) => {
    setSelected((sel) => {
      if (sel.includes(id)) return sel.filter((s) => s !== id);
      loadStation(id);
      return [...sel, id].sort((a, b) => a - b);
    });
  };

  const series: ChartSeries[] = useMemo(
    () =>
      selected.flatMap((id) => {
        const st = dataRef.current.get(id);
        if (!st) return [];
        return [
          {
            id,
            color: st.color,
            points: [...st.pts.values()]
              .sort((a, b) => a.t - b.t)
              .map((p) => ({ t: p.t, v: p.v })),
          },
        ];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tick]
  );

  return (
    <div className="stage">
      <div className="chart-layer">
        <StationChart series={series} windowSec={windowSec} />
      </div>

      <motion.div
        className="panel topbar"
        initial={{ opacity: 0, y: -18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
      >
        <div className="brand">
          Station Monitor
          <motion.span
            className="live-dot"
            style={{ background: paused ? "#d29922" : "#3fb950" }}
            animate={
              paused
                ? { scale: 1, opacity: 0.7 }
                : { scale: [1, 1.5, 1], opacity: [1, 0.55, 1] }
            }
            transition={
              paused ? { duration: 0.2 } : { duration: 1.6, repeat: Infinity }
            }
          />
        </div>
        <div className="stations">
          {ids.map((id) => {
            const on = selected.includes(id);
            return (
              <motion.button
                key={id}
                className={`station-pill${on ? "" : " off"}`}
                onClick={() => toggle(id)}
                whileHover={{ scale: 1.07 }}
                whileTap={{ scale: 0.93 }}
                transition={{ type: "spring", stiffness: 500, damping: 22 }}
                style={
                  on
                    ? {
                        borderColor: stationColor(id),
                        boxShadow: `0 0 12px ${stationColor(id)}55`,
                      }
                    : undefined
                }
              >
                <span
                  className="dot"
                  style={{ background: stationColor(id) }}
                />
                {id}
              </motion.button>
            );
          })}
        </div>
        <div className="controls">
          <select
            value={windowSec}
            onChange={(e) => setWindowSec(Number(e.target.value))}
          >
            <option value={300}>last 5 min</option>
            <option value={900}>last 15 min</option>
            <option value={0}>all</option>
          </select>
          <motion.button
            className="action-btn"
            onClick={() => setPaused((p) => !p)}
            whileTap={{ scale: 0.93 }}
          >
            {paused ? "Resume" : "Pause"}
          </motion.button>
        </div>
      </motion.div>

      <AnimatePresence>
        {selected.length > 0 && (
          <motion.div
            key="stats"
            className="panel stats-panel"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
          >
            {selected.map((id) => {
              const s = stats[id] ?? { pts: 0, dups: 0, corr: 0, late: 0 };
              return (
                <div key={id}>
                  <span style={{ color: stationColor(id) }}>● </span>
                  st{id}: {s.pts} pts, {s.dups} dup, {s.corr} corr, {s.late}{" "}
                  late
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        className="panel legend-panel"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 26, delay: 0.08 }}
      >
        {series.length === 0
          ? "select a station"
          : series.map((s) => `— st${s.id} (${s.points.length} pts)`).join("   ")}
      </motion.div>
    </div>
  );
}
