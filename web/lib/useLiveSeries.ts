"use client";

import { useEffect, useRef, useState } from "react";
import type { MiniSeries } from "../components/MiniChart";
import { stationColor } from "./colors";

interface Pt {
  t: number;
  v: number;
}
interface Incoming {
  station_id: number;
  event_id: string;
  version: number;
  ts: string;
  value: number;
  is_duplicate?: boolean;
}

/**
 * Live series for the demo hero: backfills recent points, then appends from the
 * SSE stream. Kept separate from the dashboard so the demo can run on its own.
 */
export function useLiveSeries(ids: number[], windowSec = 900) {
  const store = useRef(new Map<number, Map<string, Pt>>());
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const lastPaint = useRef(0);

  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;

    (async () => {
      await Promise.all(
        ids.map(async (id) => {
          try {
            const rows = (await (
              await fetch(`/api/history?station=${id}&limit=2000`)
            ).json()) as Incoming[];
            const m = store.current.get(id) ?? new Map<string, Pt>();
            for (const r of rows) {
              const t = Date.parse(r.ts);
              if (!Number.isNaN(t)) m.set(r.event_id, { t, v: r.value });
            }
            store.current.set(id, m);
          } catch {
            /* station has no data yet */
          }
        })
      );
      if (cancelled) return;
      setTick((n) => n + 1);

      es = new EventSource("/api/stream");
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.onmessage = (ev) => {
        try {
          const r = JSON.parse(ev.data) as Incoming;
          if (r.is_duplicate) return;
          const m = store.current.get(r.station_id) ?? new Map<string, Pt>();
          const t = Date.parse(r.ts);
          if (!Number.isNaN(t)) m.set(r.event_id, { t, v: r.value });
          store.current.set(r.station_id, m);
        } catch {
          /* torn line */
        }
      };
    })();

    // Repaint throttled: the chart animates itself between updates.
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - lastPaint.current > 600) {
        lastPaint.current = now;
        setTick((n) => n + 1);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearInterval(timer);
      es?.close();
    };
  }, [ids.join(",")]);

  const cutoff = Date.now() - windowSec * 1000;
  const series: MiniSeries[] = ids.map((id) => {
    const m = store.current.get(id);
    const points = m
      ? [...m.values()].filter((p) => p.t >= cutoff).sort((a, b) => a.t - b.t)
      : [];
    return { id, color: stationColor(id), points };
  });

  // tick is referenced so the series recompute on every repaint
  void tick;
  return { series, connected, counts: series.map((s) => s.points.length) };
}
