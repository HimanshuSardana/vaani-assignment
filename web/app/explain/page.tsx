"use client";

import { useEffect, useState } from "react";
import MiniChart from "../../components/MiniChart";
import ChaosBeat from "../../components/demo/ChaosBeat";
import VerifyBeat from "../../components/demo/VerifyBeat";
import ResolutionBeat from "../../components/demo/ResolutionBeat";
import SimilarBeat from "../../components/demo/SimilarBeat";
import DurabilityBeat from "../../components/demo/DurabilityBeat";
import { useLiveSeries } from "../../lib/useLiveSeries";
import { stationColor } from "../../lib/colors";

const STEPS = [
  { id: "chaos", label: "1 · the problem" },
  { id: "verify", label: "2 · same answer, faster" },
  { id: "range", label: "3 · history at any range" },
  { id: "similar", label: "4 · most similar" },
  { id: "durable", label: "5 · durability" },
  { id: "built", label: "6 · how it's built" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export default function DemoPage() {
  const [stations, setStations] = useState<number[]>([]);
  const [step, setStep] = useState<StepId>("chaos");

  useEffect(() => {
    // Small retry: on a cold start (or right after a deploy) the first fetch can
    // land before the server is ready, and an empty station list shows nothing.
    let alive = true;
    const load = async (attempt = 0) => {
      try {
        const ids = (await (await fetch("/api/stations")).json()) as number[];
        if (alive && Array.isArray(ids) && ids.length) return setStations(ids);
      } catch {
        /* retry below */
      }
      if (alive && attempt < 5) setTimeout(() => load(attempt + 1), 800);
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const { series, connected, counts } = useLiveSeries(stations, 3600);
  const total = counts.reduce((a, b) => a + b, 0);

  return (
    <div className="demo">
      <header className="demo-head">
        <div className="brandline">
          <h1>The Archive</h1>
          <span className={`live-dot ${connected ? "" : "off"}`} />
          <span className="muted">
            {stations.length} stations · {total.toLocaleString()} points in view
          </span>
        </div>
        <p className="tagline">
          Append-only sensor archive: durable ingest, cheap history reads, and
          recency-weighted similarity. Every number below is measured on this
          instance, not copied from a slide.
        </p>
        <div className="hero">
          <MiniChart series={series} height={190} yLabel="value" xLabel="last hour →" />
          <div className="herolegend">
            {series.map((s) => (
              <span key={s.id}>
                <i style={{ background: s.color }} />
                st{String(s.id).padStart(2, "0")}
              </span>
            ))}
          </div>
        </div>
      </header>

      <nav className="steps">
        {STEPS.map((s) => (
          <button
            key={s.id}
            className={`step${step === s.id ? " on" : ""}`}
            onClick={() => setStep(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <main className="beatwrap">
        {step === "chaos" && <ChaosBeat />}
        {step === "verify" && <VerifyBeat station={stations[0] ?? 1} />}
        {step === "range" && <ResolutionBeat station={stations[0] ?? 1} />}
        {step === "similar" && stations.length > 0 && (
          <SimilarBeat stations={stations} initial={stations[0]} />
        )}
        {step === "durable" && <DurabilityBeat />}
        {step === "built" && <BuiltBeat />}
      </main>

      <footer className="demo-foot">
        <span>
          design write-up: <a href="/report.pdf">report.pdf</a>
        </span>
        <span>
          <code>go run bench.go --station 1 --limit 500</code>
        </span>
        <span className="muted">synthetic data · 5 stations · seeded continuously</span>
      </footer>
    </div>
  );
}

function BuiltBeat() {
  return (
    <div className="beat">
      <p className="lead">
        Two static binaries and a Next.js front end. No database, because the
        machines are cheap and expected to disappear.
      </p>

      <div className="chartbox">
        <pre className="code block">{`generators (5)            ingest (1 writer)                  storage                  readers
─────────────            ─────────────────                  ───────                  ───────
station 1 ─┐             validate envelope                  wal-1.jsonl ──tail──► /api/history?limit=
station 2 ─┼─POST──────► dedupe (event_id, version) ──fsync─► wal-2.jsonl             │ ETag → 304
   ...     │ single|batch group commit (1 fsync/batch)       wal-3.jsonl             │ projection
station 5 ─┘             index rebuilt from WAL on boot          │                   ▼
                                                                  └─compaction──► rollup-<id>-60.jsonl  ──► ?resolution=60
                                                                    (retention)   rollup-<id>-3600.jsonl ──► ?resolution=3600
                                                                                         │
                                                                                         └──► /api/similar (EWMA Pearson)`}</pre>
      </div>

      <table className="rows">
        <thead>
          <tr>
            <th>decision</th>
            <th>chose</th>
            <th>gave up</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>storage</td>
            <td>one append-only log per station</td>
            <td>cross-station transactions</td>
          </tr>
          <tr>
            <td>ack semantics</td>
            <td>fsync before responding</td>
            <td>~5.6 ms per single record</td>
          </tr>
          <tr>
            <td>write throughput</td>
            <td>group commit</td>
            <td>a few ms of batching latency</td>
          </tr>
          <tr>
            <td>dedupe</td>
            <td>rebuild index from the WAL</td>
            <td>startup scan time</td>
          </tr>
          <tr>
            <td>schema</td>
            <td>validate envelope, store bytes</td>
            <td>enforced typing of payload</td>
          </tr>
          <tr>
            <td>long ranges</td>
            <td>rollups + retention</td>
            <td>exact raw points past retention</td>
          </tr>
        </tbody>
      </table>

      <p className="fineprint">
        Tests: 11 in the write path (dedupe, versions, ack-implies-durable, crash
        recovery, 1 200 concurrent posts, compaction idempotence), 12 against the
        read path (canonicalisation, tail == full, EWMA, rollups).
      </p>
    </div>
  );
}
