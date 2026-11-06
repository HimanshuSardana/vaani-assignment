"use client";

import { useEffect, useState } from "react";

/** The real transcript from a local run, replayed step by step. */
const TRANSCRIPT = [
  { t: "t+0.0s", text: "generator acknowledges 120 readings", detail: "POST /ingest → 200 {accepted:120}" },
  { t: "t+0.1s", text: "kill -9 — no graceful shutdown", detail: "SIGKILL, no flush, no close" },
  { t: "t+0.2s", text: "lines on disk: 120", detail: "everything acknowledged is present" },
  { t: "t+0.3s", text: "restart → recovered 120 records in 1 ms", detail: "dedupe index rebuilt from the WAL" },
  { t: "t+0.4s", text: "replay event 1:000001", detail: '{"accepted":0,"duplicates":1}' },
  { t: "t+0.5s", text: "lines on disk: 120", detail: "still 120 — the retry was a no-op" },
];

/**
 * Beat 5 — durability, without asking the visitor to crash our server.
 *
 * A scripted replay of a real local transcript: acknowledgement only after
 * fsync, recovery from the WAL, and idempotent retry.
 */
export default function DurabilityBeat() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % (TRANSCRIPT.length + 3)), 900);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="beat">
      <p className="lead">
        The write path answers only after <code>fsync</code>. Here is a real
        transcript: acknowledge, then <code>kill -9</code>, then restart.
      </p>

      <ol className="timeline">
        {TRANSCRIPT.map((s, i) => (
          <li key={s.t} className={i <= Math.min(step, TRANSCRIPT.length - 1) ? "on" : ""}>
            <span className="tstamp">{s.t}</span>
            <span className="ttext">
              {s.text}
              <em>{s.detail}</em>
            </span>
          </li>
        ))}
      </ol>

      <div className="grid2">
        <div className="card">
          <h4>guaranteed today</h4>
          <ul>
            <li>process crash, kill -9, OS reboot</li>
            <li>torn or partial writes (readers skip them)</li>
            <li>crash mid-compaction (re-fold is idempotent)</li>
            <li>retries (dedupe on event id + version)</li>
          </ul>
        </div>
        <div className="card warn">
          <h4>not guaranteed — the honest boundary</h4>
          <ul>
            <li>a drive that lies about flushing its cache</li>
            <li>permanent loss of the node or its disk (single copy)</li>
            <li>two writers after a partition (no fencing token)</li>
          </ul>
        </div>
      </div>

      <p className="fineprint">
        The fix for the second column is replication — acknowledge after a second
        node has it — which brings leader election or fencing. That is a different
        system, and naming the boundary is more useful than half-building it.
      </p>
    </div>
  );
}
