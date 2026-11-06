#!/usr/bin/env bash
#
# run-demo.sh — run the whole demo stack on a small VPS.
#
#   ./run-demo.sh              # 5 stations, port 3000, 48h raw retention
#   STATIONS=5 PORT=3000 ./run-demo.sh
#
# Supervises three long-lived things:
#   1. station generators that never stop (auto-restarted if they die)
#   2. a compaction loop (folds old readings into rollups, prunes the raw WAL)
#   3. the Next.js server, which only ever reads
#
# Nothing here exposes a write path to the internet: ingest is deliberately not
# started. The generators write to local WALs, which is all the read side needs.
set -euo pipefail
cd "$(dirname "$0")"

STATIONS="${STATIONS:-5}"
PORT="${PORT:-3000}"
RETENTION="${RETENTION:-48h}"
SEED_DAYS="${SEED_DAYS:-365}"   # seed an archive on first run so the demo has history
INTERVAL="${INTERVAL:-2}"
PERIOD="${PERIOD:-300}"
LOGDIR="${LOGDIR:-logs}"
COMPACT_EVERY="${COMPACT_EVERY:-300}"   # seconds between compaction passes

mkdir -p "$LOGDIR" .run

# Resolve LOGDIR to an absolute path: the compaction step and the Next server
# run from subdirectories, so a relative path breaks there (and an absolute one
# must not be prefixed again).
# Go durations don't accept days; accept "90d" for convenience.
case "$RETENTION" in
  *d) RETENTION="$(( ${RETENTION%d} * 24 ))h" ;;
esac

case "$LOGDIR" in
  /*) DATA_PATH="$LOGDIR" ;;
  *)  DATA_PATH="$PWD/$LOGDIR" ;;
esac
echo "[demo] data dir: $DATA_PATH"

# Seed once: a year of readings makes the history comparison meaningful
# (a full parse of one station is ~100 MB). Compaction then folds it into
# rollups and prunes the raw WAL, so disk stays small afterwards.
if [ "$SEED_DAYS" -gt 0 ] && [ ! -f "$LOGDIR/wal-1.jsonl" ]; then
  echo "[demo] seeding ${SEED_DAYS}d archive into $LOGDIR (one time)"
  python3 seed_data.py --out "$LOGDIR" --days "$SEED_DAYS" | sed 's/^/[seed] /'
fi

echo "[demo] stations=$STATIONS port=$PORT retention=$RETENTION interval=${INTERVAL}s"

# Fold whatever we just seeded before serving, so rollups exist immediately.
(cd ingest && go run . --compact --dir "$DATA_PATH" --retention "$RETENTION") 2>&1 | sed 's/^/[compact] /' || true

cleanup() {
  echo "[demo] stopping"
  for f in .run/*.pid; do
    [ -e "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
  done
  sleep 1
  pkill -f "generator.py --station-id" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# 1. generators: restart forever, never exit, never use --die-after
for i in $(seq 1 "$STATIONS"); do
  (
    while true; do
      python3 generator.py --station-id "$i" --interval "$INTERVAL" --period "$PERIOD" \
        --outage-rate 0.004 --dup-rate 0.05 --reorder-rate 0.08 --late-rate 0.05 \
        --correction-rate 0.03 >> "$LOGDIR/station-$i.log" 2>&1 || true
      sleep 2
    done
  ) &
  echo $! > ".run/gen-$i.pid"
done
echo "[demo] $STATIONS generators started (auto-restarting)"

# 2. compaction: rollups + pruning, so the demo runs for weeks without filling disk
(
  while true; do
    sleep "$COMPACT_EVERY"
    (cd ingest && go run . --compact --dir "$DATA_PATH" --retention "$RETENTION") \
      >> .run/compact.log 2>&1 || echo "[demo] compaction failed" >> .run/compact.log
  done
) &
echo $! > .run/compact.pid

# 3. the app (build once, then serve)
if [ ! -d web/.next ]; then
  echo "[demo] building web"
  (cd web && npm ci --omit=dev >/dev/null 2>&1 || npm install >/dev/null 2>&1; npm run build)
fi

echo "[demo] serving on :$PORT"
(cd web && DATA_DIR="$DATA_PATH" npx next start -p "$PORT") &
echo $! > .run/web.pid

wait
