import { promises as fs } from "fs";
import path from "path";

export interface Reading {
  station_id: number;
  event_id: string;
  seq: number;
  version: number;
  ts: string;
  value: number;
  archetype?: string;
  is_duplicate?: boolean;
  is_correction?: boolean;
  late_by_s?: number;
}

/** WAL directory: ../logs relative to web/, overridable via DATA_DIR. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "..", "logs");
}

export async function listStations(): Promise<number[]> {
  let files: string[];
  try {
    files = await fs.readdir(dataDir());
  } catch {
    return [];
  }
  const ids: number[] = [];
  for (const f of files) {
    const m = /^wal-(\d+)\.jsonl$/.exec(f);
    if (m) ids.push(parseInt(m[1], 10));
  }
  return ids.sort((a, b) => a - b);
}

/** Canonical history: dedupe on event_id, highest version wins, by event time. */
export async function loadHistory(station: number): Promise<Reading[]> {
  const raw = await fs.readFile(
    path.join(dataDir(), `wal-${station}.jsonl`),
    "utf8"
  );
  const byEvent = new Map<string, Reading>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const r = JSON.parse(t) as Reading;
      if (!r.event_id) continue; // lifecycle line, not data
      const cur = byEvent.get(r.event_id);
      if (!cur || r.version > cur.version) byEvent.set(r.event_id, r);
    } catch {
      /* skip torn lines mid-write */
    }
  }
  return [...byEvent.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
