#!/usr/bin/env python3
"""
seed_data.py — generate a realistic multi-month archive for benchmarking.

    python3 seed_data.py --out logs-year --days 365

Writes logs-year/wal-<id>.jsonl in the same shape the generators produce, but
compressed in time: a full year of readings, written as fast as possible.

Station 1 is the big one (1 year at 60s = 525,600 readings) because it is what
the history endpoint gets benchmarked against; the rest are smaller and exist so
/api/similar and the dashboard have neighbours to compare.

Includes the same pathologies as the live generators: duplicates, corrections
(version bumps), late arrivals, and gaps from outages.
"""

import argparse
import json
import os
import random
import time
from datetime import datetime, timezone

# station_id -> seconds between readings
STATIONS = {1: 60, 2: 120, 3: 300, 4: 300, 5: 300}
NOISE = 0.4


def iso(ts: float) -> str:
    return (
        datetime.fromtimestamp(ts, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="logs-year")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--dup-rate", type=float, default=0.03)
    ap.add_argument("--correction-rate", type=float, default=0.01)
    ap.add_argument("--late-rate", type=float, default=0.005)
    ap.add_argument("--outage-rate", type=float, default=0.0005)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    end = time.time()
    start = end - args.days * 86400
    run = int(start)

    total = 0
    t_boot = time.time()
    for station, step in STATIONS.items():
        path = os.path.join(args.out, f"wal-{station}.jsonl")
        rng = random.Random(1000 + station)
        base = 22.0 + (station - 3) * 0.4
        seq = 0
        lines: list[str] = []
        recent: list[str] = []

        t = start
        with open(path, "w", buffering=1024 * 1024) as fh:
            while t < end:
                seq += 1
                # Occasional outage: the station reports nothing for a while.
                if rng.random() < args.outage_rate:
                    t += rng.uniform(300, 3600)
                    continue

                value = round(
                    base
                    + 5.0 * ((t / 86400) % 1)  # slow daily ramp
                    + 1.2 * ((t / 3600) % 1)
                    + rng.gauss(0, NOISE),
                    3,
                )
                event_ts = t
                late_by = 0.0
                if rng.random() < args.late_rate:
                    late_by = rng.uniform(600, 7200)
                    event_ts = t - late_by

                rec = {
                    "station_id": station,
                    "event_id": f"{station}:{run}:{seq:07d}",
                    "seq": seq,
                    "version": 1,
                    "ts": iso(event_ts),
                    "emitted_at": iso(t),
                    "value": value,
                    "archetype": "standard",
                    "late_by_s": round(late_by, 1),
                }
                lines.append(json.dumps(rec, separators=(",", ":")))
                recent.append(lines[-1])
                if len(recent) > 200:
                    recent.pop(0)

                # Duplicate: byte-identical resend of a recent reading.
                if rng.random() < args.dup_rate and recent:
                    lines.append(rng.choice(recent))

                # Correction: same event id, bumped version, revised value.
                if rng.random() < args.correction_rate and recent:
                    corr = json.loads(rng.choice(recent))
                    corr["version"] = corr.get("version", 1) + 1
                    corr["value"] = round(corr["value"] + rng.gauss(0, 1.5), 3)
                    corr["emitted_at"] = iso(t)
                    corr["is_correction"] = True
                    corr["correction_of"] = corr["event_id"]
                    lines.append(json.dumps(corr, separators=(",", ":")))

                if len(lines) >= 50_000:
                    fh.write("\n".join(lines) + "\n")
                    total += len(lines)
                    lines.clear()
                t += step

            if lines:
                fh.write("\n".join(lines) + "\n")
                total += len(lines)

        size = os.path.getsize(path)
        print(f"  station {station}: {seq:>7d} readings, {size / 1e6:>7.1f} MB")

    elapsed = time.time() - t_boot
    print(f"done: {total:,} lines in {elapsed:.1f}s -> {args.out}/")


if __name__ == "__main__":
    main()
