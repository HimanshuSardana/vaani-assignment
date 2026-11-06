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
  sorted: ChartPoint[];
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
interface ReadingRow {
  event_id: string;
  ts: string;
  value: number;
  version: number;
}
interface SimResult {
  station: number;
  metric: string;
  ranking: { station_id: number; score: number; overlap_buckets: number }[];
}

type Section = "stations" | "history" | "similar" | null;

const pad2 = (n: number) => String(n).padStart(2, "0");
const stationLabel = (id: number) => `Station ${pad2(id)}`;
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export default function Page() {
  const [ids, setIds] = useState<number[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [stats, setStats] = useState<Record<number, number>>({});
  const [windowSec, setWindowSec] = useState(900);
  const [rate, setRate] = useState(0);
  const [following, setFollowing] = useState(true);
  const [open, setOpen] = useState<Section>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tick, setTick] = useState(0);

  // history section
  const [histStation, setHistStation] = useState(1);
  const [histRows, setHistRows] = useState<ReadingRow[]>([]);
  // similar section
  const [simStation, setSimStation] = useState(1);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [simBusy, setSimBusy] = useState(false);

  const dataRef = useRef(new Map<number, St>());
  const paused = false;
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const lastPaint = useRef(0);

  const seen = useRef(0);
  const poke = useCallback(() => {
    const now = performance.now();
    if (now - lastPaint.current > 500) {
      lastPaint.current = now;
      const s: Record<number, number> = {};
      for (const [id, st] of dataRef.current) s[id] = st.sorted.length;
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
        sorted: [],
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
    if (prev && r.version <= prev.ver) return;
    if (prev) st.corr++;
    else if ((r.late_by_s ?? 0) > 0) st.late++;
    st.pts.set(r.event_id, { t, v: r.value, ver: r.version });

    const arr = st.sorted;
    const last = arr.length ? arr[arr.length - 1].t : -Infinity;
    if (t >= last) {
      arr.push({ t, v: r.value });
      return;
    }
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t === t) {
        arr[mid].v = r.value;
        return;
      }
      if (arr[mid].t < t) lo = mid + 1;
      else hi = mid - 1;
    }
    arr.splice(lo, 0, { t, v: r.value });
  }, []);

  const loadStation = useCallback(
    async (id: number) => {
      const st = dataRef.current.get(id);
      if (st && st.sorted.length > 0) return;
      try {
        const hist = (await (
          await fetch(`/api/history?station=${id}&limit=2000`)
        ).json()) as Incoming[];
        hist.forEach(ingest);
        poke();
      } catch {
        /* no data yet */
      }
    },
    [ingest, poke]
  );

  // Boot: load stations, select all, backfill, then stream.
  useEffect(() => {
    let es: EventSource | undefined;
    (async () => {
      const list = (await (await fetch("/api/stations")).json()) as number[];
      setIds(list);
      setSelected(list); // all stations shown by default
      if (list.length) {
        setHistStation(list[0]);
        setSimStation(list[0]);
      }
      await Promise.all(list.map(loadStation));
      es = new EventSource("/api/stream");
      es.onmessage = (ev) => {
        try {
          seen.current++;
          ingest(JSON.parse(ev.data) as Incoming);
        } catch {
          /* torn line */
        }
        poke();
      };
    })();
    return () => es?.close();
  }, [ingest, loadStation, poke]);

  // Update rate: count messages per second, resetting every tick.
  useEffect(() => {
    const t = setInterval(() => {
      // Average over a 2 s window: with 5 stations at 2 s intervals a 1 s
      // window lands on 0 or 5 and reads as a glitch.
      setRate(Number((seen.current / 2).toFixed(1)));
      seen.current = 0;
    }, 2000);
    return () => clearInterval(t);
  }, []);

  // History panel data, refreshed when opened / station changes / every 2s.
  useEffect(() => {
    if (open !== "history" || !histStation) return;
    let alive = true;
    const grab = async () => {
      try {
        const rows = (await (
          await fetch(`/api/history?station=${histStation}&limit=8`)
        ).json()) as ReadingRow[];
        if (alive) setHistRows(rows.slice().reverse()); // newest first
      } catch {
        if (alive) setHistRows([]);
      }
    };
    grab();
    const t = setInterval(grab, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, histStation]);

  const runSimilar = useCallback(async (station: number) => {
    setSimBusy(true);
    setSimErr(null);
    try {
      const res = await fetch(`/api/similar?station=${station}&top_k=5`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSim((await res.json()) as SimResult);
    } catch (e) {
      setSimErr(String(e));
      setSim(null);
    } finally {
      setSimBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open === "similar" && simStation) runSimilar(simStation);
  }, [open, simStation, runSimilar]);

  const toggleStation = (id: number) => {
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
        return [{ id, color: st.color, points: st.sorted }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tick]
  );

  const allOn = ids.length > 0 && selected.length === ids.length;
  const toggleAll = () => {
    if (allOn) setSelected([]);
    else {
      setSelected(ids);
      ids.forEach(loadStation);
    }
  };

  const SectionRow = ({
    id,
    title,
    sub,
    children,
  }: {
    id: Exclude<Section, null>;
    title: string;
    sub?: string;
    children: React.ReactNode;
  }) => {
    const isOpen = open === id;
    return (
      <div className="row">
        <button
          className="row-head"
          onClick={() => setOpen(isOpen ? null : id)}
          aria-expanded={isOpen}
        >
          <span className="grow">{title}</span>
          {sub && <span className="sub">{sub}</span>}
          <motion.span
            className="chev"
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.18 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </motion.span>
        </button>
        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.div
              className="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="stage">
      <div className="chart-layer">
        <StationChart
          series={series}
          windowSec={windowSec}
          following={following}
          onUserTakeover={() => setFollowing(false)}
          onFollow={() => setFollowing(true)}
        />
      </div>

      <div className="livebar">
        <motion.span
          className="live-dot"
          animate={
            following
              ? { opacity: [1, 0.35, 1], scale: [1, 1.35, 1] }
              : { opacity: 0.5, scale: 1 }
          }
          transition={following ? { duration: 1.8, repeat: Infinity } : { duration: 0.2 }}
        />
        <b>{ids.length}</b> stations
        <span className="livebar-sep" />
        <span className="muted">{rate}/s</span>
        {!following && <span className="livebar-paused">paused</span>}
      </div>

      <motion.button
        className="fab"
        onClick={() => {
          setPanelOpen((p) => !p);
          if (panelOpen) setOpen(null); // collapse sections when closing
        }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.94 }}
        aria-label="Settings"
        title="Settings"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </motion.button>

      <AnimatePresence>
        {panelOpen && (
          <motion.div
            className="panel"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <div className="panel-title">
              Settings<span>live archive</span>
            </div>

            {/* 1 — stations shown */}
            <SectionRow
              id="stations"
              title="Stations"
              sub={`${selected.length}/${ids.length}`}
            >
              <p className="hint">
                Choose which stations to plot. All available stations are shown
                by default.
              </p>
              <div className="station-row" onClick={toggleAll}>
                <span className="station-name">All stations</span>
                <button className="toggle" data-on={allOn} aria-label="All stations" />
              </div>
              {ids.map((id) => {
                const on = selected.includes(id);
                return (
                  <div
                    key={id}
                    className="station-row"
                    onClick={() => toggleStation(id)}
                  >
                    <span
                      className="swatch"
                      style={{ background: stationColor(id) }}
                    />
                    <span className="station-name">{stationLabel(id)}</span>
                    <span className="station-meta">{stats[id] ?? 0} pts</span>
                    <button
                      className="toggle"
                      data-on={on}
                      aria-label={`Toggle station ${id}`}
                    />
                  </div>
                );
              })}
              <div className="field" style={{ marginTop: 12 }}>
                <label>Follow</label>
                <button
                  className="toggle"
                  data-on={following}
                  aria-label="Follow live"
                  onClick={() => setFollowing((f) => !f)}
                />
                <select
                  value={windowSec}
                  onChange={(e) => {
                    setWindowSec(Number(e.target.value));
                    setFollowing(true);
                  }}
                >
                  <option value={300}>last 5 min</option>
                  <option value={900}>last 15 min</option>
                  <option value={0}>all time</option>
                </select>
              </div>
            </SectionRow>

            {/* 2 — history */}
            <SectionRow id="history" title="Station history" sub="one station">
              <p className="hint">
                Latest stored readings, deduplicated and ordered by event time.
              </p>
              <div className="field">
                <label>Station</label>
                <select
                  value={histStation}
                  onChange={(e) => setHistStation(Number(e.target.value))}
                >
                  {ids.map((id) => (
                    <option key={id} value={id}>
                      {stationLabel(id)}
                    </option>
                  ))}
                </select>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Value</th>
                    <th>Ver</th>
                  </tr>
                </thead>
                <tbody>
                  {histRows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="empty">
                        No readings yet.
                      </td>
                    </tr>
                  )}
                  {histRows.map((r) => (
                    <tr key={r.event_id}>
                      <td>{clock(r.ts)}</td>
                      <td>{r.value.toFixed(3)}</td>
                      <td style={{ color: "var(--muted-2)" }}>v{r.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="btn-row">
                <a
                  className="btn"
                  href={`/api/history?station=${histStation}&limit=500`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View JSON ↗
                </a>
              </div>
            </SectionRow>

            {/* 3 — similarity */}
            <SectionRow id="similar" title="Similar stations" sub="correlation">
              <p className="hint">
                Correlation with the selected station, exponentially weighted so
                recent behaviour dominates (λ=0.999 ≈ last 8 hours).
              </p>
              <div className="field">
                <label>Station</label>
                <select
                  value={simStation}
                  onChange={(e) => setSimStation(Number(e.target.value))}
                >
                  {ids.map((id) => (
                    <option key={id} value={id}>
                      {stationLabel(id)}
                    </option>
                  ))}
                </select>
              </div>
              {simBusy && <div className="empty">Computing…</div>}
              {simErr && <div className="err">Failed: {simErr}</div>}
              {!simBusy && sim && (
                <>
                  {sim.ranking.length === 0 && (
                    <div className="empty">Not enough overlapping data yet.</div>
                  )}
                  {sim.ranking.map((r) => (
                    <div className="sim-row" key={r.station_id}>
                      <span
                        className="swatch"
                        style={{ background: stationColor(r.station_id) }}
                      />
                      <span style={{ width: 74 }}>{stationLabel(r.station_id)}</span>
                      <span className="sim-bar">
                        <i
                          style={{
                            width: `${Math.max(2, Math.max(0, r.score) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="sim-score">{r.score.toFixed(2)}</span>
                    </div>
                  ))}
                  <div className="btn-row">
                    <a
                      className="btn"
                      href={`/api/similar?station=${simStation}&top_k=5`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View JSON ↗
                    </a>
                  </div>
                </>
              )}
            </SectionRow>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
