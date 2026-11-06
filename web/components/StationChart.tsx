"use client";

import { useEffect, useRef } from "react";

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
}

const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/**
 * Animated multi-series line chart.
 * - New series fade in + draw themselves left-to-right (eased reveal).
 * - Toggled-off series fade out instead of vanishing.
 * - The x-domain eases toward its target, so the sliding window glides
 *   instead of jumping every render.
 * - The newest point pulses; hovering shows a crosshair + values.
 */
export default function StationChart({ series, windowSec }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    series,
    windowSec,
    opacity: new Map<number, number>(),
    born: new Map<number, number>(),
    lo: 0,
    hi: 1,
    init: false,
    hover: null as { x: number; y: number } | null,
  });
  stateRef.current.series = series;
  stateRef.current.windowSec = windowSec;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const st = stateRef.current;
    let raf = 0;
    let w = 0;
    let h = 0;

    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      st.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => (st.hover = null);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);

    const now0 = performance.now();
    for (const s of st.series) {
      if (!st.born.has(s.id)) st.born.set(s.id, now0);
      if (!st.opacity.has(s.id)) st.opacity.set(s.id, 0);
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const { series: S, windowSec: win } = st;
      ctx.clearRect(0, 0, w, h);

      const padL = 52;
      const padR = 12;
      const padT = 12;
      const padB = 24;
      const nowMs = Date.now();

      // Target domain from data.
      let tLo = Infinity;
      let tHi = -Infinity;
      let vLo = Infinity;
      let vHi = -Infinity;
      const visible = new Map<number, ChartPoint[]>();
      for (const s of S) {
        const cutoff = win ? nowMs - win * 1000 : -Infinity;
        const pts = s.points.filter((p) => p.t >= cutoff);
        if (!pts.length) continue;
        visible.set(s.id, pts);
        for (const p of pts) {
          if (p.t < tLo) tLo = p.t;
          if (p.t > tHi) tHi = p.t;
          if (p.v < vLo) vLo = p.v;
          if (p.v > vHi) vHi = p.v;
        }
      }
      if (win && visible.size) {
        tLo = Math.min(tLo, nowMs - win * 1000);
        tHi = Math.max(tHi, nowMs);
      }

      if (!visible.size) {
        ctx.fillStyle = "#9aa4b2";
        ctx.font = "13px system-ui";
        ctx.fillText("No data in window — check a station, or let generators run.", padL, 40);
        return;
      }
      if (tHi - tLo < 1000) tHi = tLo + 1000;

      // Ease the displayed domain toward the target (gliding window).
      if (!st.init) {
        st.lo = tLo;
        st.hi = tHi;
        st.init = true;
      } else {
        st.lo += (tLo - st.lo) * 0.12;
        st.hi += (tHi - st.hi) * 0.12;
      }
      const pad = (vHi - vLo || 1) * 0.1;
      vLo -= pad;
      vHi += pad;
      const X = (t: number) => padL + ((t - st.lo) / (st.hi - st.lo)) * (w - padL - padR);
      const Y = (v: number) => padT + (1 - (v - vLo) / (vHi - vLo)) * (h - padT - padB);

      // Grid + axes.
      ctx.strokeStyle = "#1e2630";
      ctx.fillStyle = "#7d8590";
      ctx.font = "11px system-ui";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = vLo + ((vHi - vLo) * i) / 4;
        const y = Y(v);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillText(v.toFixed(1), 6, y + 3);
      }
      for (let i = 0; i <= 5; i++) {
        const t = st.lo + ((st.hi - st.lo) * i) / 5;
        ctx.fillText(new Date(t).toLocaleTimeString(), X(t) - 24, h - 8);
      }

      // Series (fade in/out, eased reveal, pulsing head).
      const liveIds = new Set(visible.keys());
      for (const [id, op] of [...st.opacity]) {
        const target = liveIds.has(id) ? 1 : 0;
        const next = op + (target - op) * 0.08;
        if (!liveIds.has(id) && next < 0.02) {
          st.opacity.delete(id);
          st.born.delete(id);
        } else {
          st.opacity.set(id, next);
        }
      }
      for (const s of S) {
        if (!visible.has(s.id)) continue;
        if (!st.born.has(s.id)) st.born.set(s.id, now);
        if (!st.opacity.has(s.id)) st.opacity.set(s.id, 0);
      }

      let hoverPts: { id: number; color: string; p: ChartPoint }[] = [];
      if (st.hover) {
        let bestDx = 28;
        for (const s of S) {
          const pts = visible.get(s.id);
          if (!pts) continue;
          for (const p of pts) {
            const dx = Math.abs(X(p.t) - st.hover.x);
            if (dx < bestDx) {
              bestDx = dx;
              hoverPts = [{ id: s.id, color: s.color, p }];
            }
          }
        }
      }

      for (const s of S) {
        const pts = visible.get(s.id);
        if (!pts) continue;
        const op = st.opacity.get(s.id) ?? 1;
        if (op <= 0.01) continue;
        ctx.globalAlpha = Math.min(1, op);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.6;

        // Eased left-to-right reveal over ~900ms from first sight.
        const reveal = easeOutCubic(
          Math.min(1, (now - (st.born.get(s.id) ?? now)) / 900)
        );
        const cutT = pts[0].t + (pts[pts.length - 1].t - pts[0].t) * reveal + 1;
        const drawn = pts.filter((p) => p.t <= cutT);
        if (drawn.length < 2) {
          // Too early in the reveal: just show the head dot.
          const p = pts[0];
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(X(p.t), Y(p.v), 3, 0, 7);
          ctx.fill();
          ctx.globalAlpha = 1;
          continue;
        }
        ctx.beginPath();
        drawn.forEach((p, i) =>
          i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))
        );
        ctx.stroke();

        // Pulsing head dot on the newest point.
        const last = drawn[drawn.length - 1];
        const pulse = 3 + 1.6 * (0.5 + 0.5 * Math.sin(now / 280));
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(X(last.t), Y(last.v), pulse, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.arc(X(last.t), Y(last.v), pulse + 5, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Hover crosshair + tooltip.
      if (hoverPts.length && st.hover) {
        const t = hoverPts[0].p.t;
        ctx.strokeStyle = "#3a4556";
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(X(t), padT);
        ctx.lineTo(X(t), h - padB);
        ctx.stroke();
        ctx.setLineDash([]);
        const lines = [
          new Date(t).toLocaleTimeString(),
          ...S.flatMap((s) => {
            const pts = visible.get(s.id);
            if (!pts) return [];
            let best = pts[0];
            for (const p of pts) {
              if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
            }
            return [`st${s.id}  ${best.v.toFixed(3)}`];
          }),
        ];
        ctx.font = "12px system-ui";
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
        let bx = X(t) + 12;
        if (bx + tw > w - 8) bx = X(t) - tw - 12;
        const by = Math.min(st.hover.y, h - padB - lines.length * 18 - 12);
        ctx.fillStyle = "rgba(22,27,34,0.95)";
        ctx.strokeStyle = "#2a3340";
        ctx.beginPath();
        ctx.roundRect(bx, by, tw, lines.length * 18 + 10, 6);
        ctx.fill();
        ctx.stroke();
        lines.forEach((l, i) => {
          ctx.fillStyle = i === 0 ? "#9aa4b2" : "#e6e6e6";
          ctx.fillText(l, bx + 8, by + 20 + i * 18);
        });
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div ref={wrapRef} style={{ height: "100%" }}>
      <canvas ref={canvasRef} style={{ background: "#0e1116" }} />
    </div>
  );
}
