#!/usr/bin/env python3
"""
generator.py — one instance = one sensor station.

Emits timestamped measurements to stdout (JSONL) and optionally POSTs
them to an ingest endpoint. Uses only the Python standard library so it
runs on the cheapest box with zero install.

Usage:
    python3 generator.py --station-id 3
    python3 generator.py --station-id 3 --ingest-url http://localhost:8080/ingest
    STATION_ID=3 INGEST_URL=http://localhost:8080/ingest python3 generator.py

Every chaos behaviour below maps to a line in the brief:
  regular reports, until they don't  -> base INTERVAL loop + random outages
                                       (+ --die-after to simulate permanent death)
  late / out of order                -> reorder buffer + late timestamps
  duplicated                          -> exact resend of a previous record
  corrected long after the fact       -> same event_id, version bump, new value

Idempotency contract (what the ingest side must honour):
  * event_id = "<station_id>:<seq>" is stable per logical reading.
  * First send is version=1. A correction reuses the event_id with
    version=2 (or higher) and correction_of=<event_id>.
  * Duplicates reuse event_id AND version with an identical payload.
  * Ingest must dedupe on (event_id, version) and apply
    highest-version-wins per event_id.
"""

import argparse
import json
import math
import os
import random
import signal
import sys
import time
import urllib.request
from datetime import datetime, timezone

running = True


def _handle_stop(signum, frame):
    global running
    running = False


signal.signal(signal.SIGTERM, _handle_stop)
signal.signal(signal.SIGINT, _handle_stop)


def utcnow_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ----------------------------------------------------------------------------
# Signal model
# ----------------------------------------------------------------------------
# Stations that "behave most alike" need ground truth. Stations are grouped
# into archetypes by ID so similarity queries have a right answer:
#   archetype = (station_id - 1) % num_archetypes
# Stations in one archetype share base/period/phase; per-station noise and
# drift make them similar-but-not-identical. Different archetypes have
# clearly separated baselines.
ARCHETYPES = [
    {"name": "coastal",  "base": 18.0, "amplitude": 4.0, "period_s": 300, "phase": 0.0},
    {"name": "desert",   "base": 32.0, "amplitude": 8.0, "period_s": 300, "phase": 1.1},
    {"name": "alpine",   "base": 5.0,  "amplitude": 6.0, "period_s": 300, "phase": 2.4},
]


def station_model(station_id, t_wall, seq, rng):
    arch = ARCHETYPES[(station_id - 1) % len(ARCHETYPES)]
    # Slow per-station drift so histories diverge over long runs.
    drift = ((station_id * 7919) % 1000) / 1000.0 * 0.0005 * seq
    signal_val = arch["base"] + arch["amplitude"] * math.sin(
        2 * math.pi * t_wall / arch["period_s"] + arch["phase"]
    )
    noise = rng.gauss(0, 0.4)
    return round(signal_val + drift + noise, 3), arch["name"]


# ----------------------------------------------------------------------------
# Delivery
# ----------------------------------------------------------------------------
def post_json(url, record, timeout=5):
    body = json.dumps(record).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status


def emit(record, ingest_url, wal_fh):
    """Write-ahead-log, then stdout, then optional HTTP POST with retries."""
    line = json.dumps(record)
    if wal_fh:
        wal_fh.write(line + "\n")
        wal_fh.flush()
    print(line, flush=True)
    if not ingest_url:
        return
    last_err = None
    for attempt in range(3):
        try:
            post_json(ingest_url, record)
            return
        except Exception as e:  # noqa: BLE001 - generator must never crash on send
            last_err = e
            time.sleep(0.5 * (2 ** attempt))
    print(
        json.dumps({"level": "warn", "msg": "ingest failed, kept in WAL", "error": str(last_err)}),
        file=sys.stderr,
        flush=True,
    )


def parse_args():
    p = argparse.ArgumentParser(description="Sensor station generator (one instance = one station).")
    p.add_argument("--station-id", type=int, default=int(os.getenv("STATION_ID", "1")))
    p.add_argument("--interval", type=float, default=float(os.getenv("INTERVAL", "2.0")),
                   help="base seconds between readings")
    p.add_argument("--jitter", type=float, default=float(os.getenv("JITTER", "0.5")),
                   help="fraction of interval applied as random jitter")
    p.add_argument("--ingest-url", default=os.getenv("INGEST_URL", ""),
                   help="POST target; empty = stdout/WAL only")
    p.add_argument("--wal", default=os.getenv("WAL", ""),
                   help="append-only log path (default logs/wal-<id>.jsonl)")
    p.add_argument("--seed", type=int, default=int(os.getenv("SEED", "0")),
                   help="0 = derive from station id")
    p.add_argument("--die-after", type=float, default=float(os.getenv("DIE_AFTER", "0")),
                   help="seconds after which the station goes silent forever (0 = never)")
    p.add_argument("--dup-rate", type=float, default=0.05)
    p.add_argument("--reorder-rate", type=float, default=0.08)
    p.add_argument("--late-rate", type=float, default=0.05)
    p.add_argument("--correction-rate", type=float, default=0.03)
    p.add_argument("--outage-rate", type=float, default=0.01,
                   help="per-reading chance of a temporary silence (10-60s)")
    p.add_argument("--max-readings", type=int, default=int(os.getenv("MAX_READINGS", "0")),
                   help="stop after N readings (0 = run forever; handy for tests)")
    return p.parse_args()


def main():
    args = parse_args()
    station_id = args.station_id
    rng = random.Random(args.seed or (0xC0FFEE + station_id))
    wal_path = args.wal or f"logs/wal-{station_id}.jsonl"
    os.makedirs(os.path.dirname(wal_path) or ".", exist_ok=True)
    wal_fh = open(wal_path, "a", buffering=1)

    start = time.time()
    print(
        json.dumps({"level": "info", "msg": "station up",
                    "station_id": station_id, "wal": wal_path,
                    "ingest_url": args.ingest_url or None}),
        file=sys.stderr, flush=True,
    )

    seq = 0
    pending = []   # reorder buffer: held-back records sent out of order
    history = []   # recent records, eligible for dup / correction
    sent = 0

    while running:
        if args.die_after and (time.time() - start) > args.die_after:
            print(json.dumps({"level": "info", "msg": "station died (die-after reached)",
                              "station_id": station_id}),
                  file=sys.stderr, flush=True)
            break
        if args.max_readings and sent >= args.max_readings:
            break

        # --- temporary outage: station stops reporting for a while ---
        if rng.random() < args.outage_rate:
            nap = rng.uniform(10, 60)
            print(json.dumps({"level": "info", "msg": f"outage, silent for {nap:.0f}s",
                              "station_id": station_id}),
                  file=sys.stderr, flush=True)
            deadline = time.time() + nap
            while running and time.time() < deadline:
                time.sleep(0.5)
            continue

        seq += 1
        t_wall = time.time()
        value, archetype = station_model(station_id, t_wall, seq, rng)

        # --- late arrival: event time is minutes in the past ---
        event_t = t_wall
        late_by = 0.0
        if rng.random() < args.late_rate:
            late_by = rng.uniform(300, 3600)
            event_t = t_wall - late_by

        event_id = f"{station_id}:{seq:06d}"
        record = {
            "station_id": station_id,
            "event_id": event_id,
            "seq": seq,
            "version": 1,
            "ts": datetime.fromtimestamp(event_t, timezone.utc)
                      .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "emitted_at": utcnow_iso(),
            "value": value,
            "archetype": archetype,
            "late_by_s": round(late_by, 1),
        }

        # --- out-of-order: hold this record back, flush an older one first ---
        if rng.random() < args.reorder_rate:
            pending.append(record)
            if len(pending) >= rng.randint(2, 4):
                emit(pending.pop(rng.randrange(len(pending))), args.ingest_url, wal_fh)
                sent += 1
        else:
            emit(record, args.ingest_url, wal_fh)
            sent += 1
            # drain one held-back record so nothing sits forever
            if pending and rng.random() < 0.7:
                emit(pending.pop(0), args.ingest_url, wal_fh)
                sent += 1

        history.append(record)
        if len(history) > 50:
            history.pop(0)

        # --- duplicate: byte-identical resend of a recent record ---
        if history and rng.random() < args.dup_rate:
            dup = dict(rng.choice(history))
            dup["emitted_at"] = utcnow_iso()
            dup["is_duplicate"] = True
            emit(dup, args.ingest_url, wal_fh)
            sent += 1

        # --- correction: same event_id, version bump, revised value ---
        if history and rng.random() < args.correction_rate:
            orig = rng.choice(history)
            corr = dict(orig)
            corr["version"] = orig.get("version", 1) + 1
            corr["value"] = round(orig["value"] + rng.gauss(0, 1.5), 3)
            corr["emitted_at"] = utcnow_iso()
            corr["correction_of"] = orig["event_id"]
            corr["is_correction"] = True
            emit(corr, args.ingest_url, wal_fh)
            sent += 1

        # --- regular cadence with jitter ---
        time.sleep(max(0.1, args.interval * (1 + rng.uniform(-args.jitter, args.jitter))))

    # flush anything still held back so no data is lost on shutdown
    for rec in pending:
        emit(rec, args.ingest_url, wal_fh)
    wal_fh.close()
    print(json.dumps({"level": "info", "msg": "station down", "station_id": station_id}),
          file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
