"use client";

import { useEffect, useRef } from "react";

export interface MiniSeries {
  id: number;
  color: string;
  points: { t: number; v: number }[];
}

/** Dependency-free sparkline used by the demo beats (no pan/zoom by design). */
export default function MiniChart({
  series,
  height = 180,
  xLabel,
  yLabel,
  dots = false,
}: {
  series: MiniSeries[];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  dots?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const state = useRef({ series, xLabel, yLabel, dots });
  state.current = { series, xLabel, yLabel, dots };

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { series, xLabel, yLabel, dots } = state.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.clearRect(0, 0, w, h);

      const padL = 44;
      const padR = 10;
      const padT = 10;
      const padB = 18;

      let lo = Infinity;
      let hi = -Infinity;
      let vlo = Infinity;
      let vhi = -Infinity;
      for (const s of series)
        for (const p of s.points) {
          if (p.t < lo) lo = p.t;
          if (p.t > hi) hi = p.t;
          if (p.v < vlo) vlo = p.v;
          if (p.v > vhi) vhi = p.v;
        }
      if (!Number.isFinite(lo) || hi <= lo) {
        ctx.fillStyle = "#8a8a8a";
        ctx.font = "12px system-ui";
        ctx.fillText("no data", padL, h / 2);
        return;
      }
      if (vhi === vlo) {
        vhi += 1;
        vlo -= 1;
      }
      const X = (t: number) => padL + ((t - lo) / (hi - lo)) * (w - padL - padR);
      const Y = (v: number) => padT + (1 - (v - vlo) / (vhi - vlo)) * (h - padT - padB);

      // grid + axis labels
      ctx.strokeStyle = "rgba(60,72,90,0.35)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        const y = padT + ((h - padT - padB) * i) / 3;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        const v = vhi - ((vhi - vlo) * i) / 3;
        ctx.fillStyle = "#6a6a6a";
        ctx.font = "10px system-ui";
        ctx.fillText(v.toFixed(1), 4, y + 3);
      }

      for (const s of series) {
        if (s.points.length < 2) continue;
        if (dots) {
          // Scatter: shows what arrived, without implying a path through it.
          ctx.fillStyle = s.color;
          for (const p of s.points) {
            ctx.beginPath();
            ctx.arc(X(p.t), Y(p.v), 2.2, 0, 7);
            ctx.fill();
          }
        } else {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          s.points.forEach((p, i) =>
            i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))
          );
          ctx.stroke();
        }
        const last = s.points[s.points.length - 1];
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(X(last.t), Y(last.v), 2.5, 0, 7);
        ctx.fill();
      }

      ctx.fillStyle = "#6a6a6a";
      ctx.font = "10px system-ui";
      if (xLabel) ctx.fillText(xLabel, padL, h - 3);
      if (yLabel) {
        ctx.save();
        ctx.translate(10, padT + 44);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}
