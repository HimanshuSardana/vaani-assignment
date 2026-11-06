"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";

export interface ChartPoint {
  t: number;
  v: number;
}
export interface ChartSeries {
  id: number;
  color: string;
  points: ChartPoint[];
}

interface Props {
  series: ChartSeries[];
  windowSec: number;
  following: boolean;
  onUserTakeover: () => void;
  onFollow: () => void;
}

/**
 * Chart rendered with lightweight-charts (TradingView, Apache-2.0): built-in
 * pan, wheel zoom, price-scale drag, crosshair and smooth animated updates,
 * so none of the view-transform maths lives in this codebase.
 *
 * The library's time axis is whole seconds in UTC, so samples are aggregated
 * into 1-second buckets (mean). That also guarantees the strictly-increasing
 * timestamps it requires.
 */
function toLineData(points: ChartPoint[]): LineData[] {
  const sum = new Map<number, { s: number; n: number }>();
  for (const p of points) {
    const sec = Math.floor(p.t / 1000);
    const cur = sum.get(sec);
    if (cur) {
      cur.s += p.v;
      cur.n += 1;
    } else {
      sum.set(sec, { s: p.v, n: 1 });
    }
  }
  return [...sum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, { s, n }]) => ({
      time: sec as UTCTimestamp,
      value: s / n,
    }));
}

export default function StationChart({
  series,
  windowSec,
  following,
  onUserTakeover,
  onFollow,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const linesRef = useRef(new Map<number, ISeriesApi<"Line">>());
  const live = useRef({ series, windowSec, following });
  live.current = { series, windowSec, following };
  const cb = useRef({ onUserTakeover, onFollow });
  cb.current = { onUserTakeover, onFollow };
  const programmatic = useRef(false);
  const cache = useRef(
    new Map<number, { lastSec: number; count: number; lastFull: number }>()
  );

  // Create the chart once.
  useEffect(() => {
    const box = boxRef.current!;
    const chart = createChart(box, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0e1116" },
        textColor: "#7d8590",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        // Sparse, Desmos-ish: only the major lines.
        vertLines: { color: "rgba(60,72,90,0.35)" },
        horzLines: { color: "rgba(60,72,90,0.35)" },
      },
      rightPriceScale: {
        borderColor: "#232c38",
        scaleMargins: { top: 0.12, bottom: 0.12 },
        autoScale: true,
      },
      timeScale: {
        borderColor: "#232c38",
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 2,
        barSpacing: 6,
        fixLeftEdge: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#46536a", width: 1, style: 3, labelBackgroundColor: "#1f2937" },
        horzLine: { color: "#46536a", width: 1, style: 3, labelBackgroundColor: "#1f2937" },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: {
        locale: "en-GB",
        timeFormatter: (t: number) =>
          new Date(t * 1000).toLocaleTimeString("en-GB", { hour12: false }),
      },
    });
    chartRef.current = chart;

    // Any direct interaction on the pane detaches "follow live".
    const detach = () => {
      if (live.current.following) cb.current.onUserTakeover();
    };
    box.addEventListener("wheel", detach, { passive: true });
    box.addEventListener("pointerdown", detach);

    return () => {
      box.removeEventListener("wheel", detach);
      box.removeEventListener("pointerdown", detach);
      chart.remove();
      chartRef.current = null;
      linesRef.current.clear();
    };
  }, []);

  // Sync series data + follow state. Updates are incremental: only buckets
  // newer than what the library already holds are pushed, with a periodic full
  // refresh so late corrections to old samples still land.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const lines = linesRef.current;
    const alive = new Set(series.map((s) => s.id));

    // Remove lines for deselected stations.
    for (const [id, line] of [...lines]) {
      if (!alive.has(id)) {
        chart.removeSeries(line);
        lines.delete(id);
        cache.current.delete(id);
      }
    }

    let lastTime = 0;
    const nowMs = Date.now();
    for (const s of series) {
      let line = lines.get(s.id);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: s.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        lines.set(s.id, line);
      }

      const pts = s.points;
      const c = cache.current.get(s.id);
      const full = !c || pts.length < c.count || nowMs - c.lastFull > 5000;

      if (full) {
        const data = toLineData(pts);
        line.setData(data);
        const tail = data.length ? (data[data.length - 1].time as number) : 0;
        cache.current.set(s.id, { lastSec: tail, count: pts.length, lastFull: nowMs });
        if (tail) lastTime = Math.max(lastTime, tail);
        continue;
      }

      // Incremental: only samples that land in a newer 1s bucket.
      if (c && pts.length) {
        const fresh = pts.filter((p) => Math.floor(p.t / 1000) > c.lastSec);
        if (fresh.length) {
          const data = toLineData(fresh);
          for (const d of data) {
            line.update(d);
            lastTime = Math.max(lastTime, d.time as number);
          }
          const tail = data[data.length - 1].time as number;
          cache.current.set(s.id, {
            lastSec: Math.max(c.lastSec, tail),
            count: pts.length,
            lastFull: c.lastFull,
          });
        } else {
          c.count = pts.length;
        }
        lastTime = Math.max(lastTime, cache.current.get(s.id)!.lastSec);
      }
    }

    // Follow live: keep a trailing window glued to the newest sample.
    if (following && lastTime) {
      programmatic.current = true;
      const nowSec = Math.floor(Date.now() / 1000);
      const to = Math.max(lastTime, nowSec);
      if (windowSec > 0) {
        chart.timeScale().setVisibleRange({
          from: (to - windowSec) as UTCTimestamp,
          to: to as UTCTimestamp,
        });
      } else {
        chart.timeScale().fitContent();
      }
      programmatic.current = false;
    }
  }, [series, following, windowSec]);

  // Keep the pane sized correctly after mount (autoSize handles resizes).
  useEffect(() => {
    const id = setTimeout(() => chartRef.current?.timeScale().fitContent(), 60);
    return () => clearTimeout(id);
  }, []);

  return (
    <div
      ref={boxRef}
      style={{ position: "absolute", inset: 0, height: "100%", width: "100%" }}
    />
  );
}
