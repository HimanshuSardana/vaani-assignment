#!/usr/bin/env bash
#
# start-generators.sh — spin up N station generators at once.
#
#   ./start-generators.sh 10            # stations with IDs 1..10
#   ./start-generators.sh 10 --interval 1.0   # extra args are forwarded to generator.py
#   ./start-generators.sh stop          # stop all stations started by this script
#   ./start-generators.sh status        # show running stations
#
# Each station runs as a background `python3 generator.py --station-id <id>`
# process logging to logs/station-<id>.log. PIDs are tracked in .generators.pids.
#
# Env knobs (all forwarded to every station unless overridden by flags):
#   INGEST_URL   POST target, e.g. http://localhost:8080/ingest (empty = stdout/logs only)
#   INTERVAL     seconds between readings (default 2.0)
#   DIE_AFTER    seconds after which stations go silent forever (default 0 = never)
#
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=".generators.pids"
LOGDIR="logs"

cmd="${1:-}"

stop_all() {
  if [[ ! -f "$PIDFILE" ]]; then
    echo "No stations running (no $PIDFILE)."
    return 0
  fi
  while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done < "$PIDFILE"
  sleep 1
  # Force-kill stragglers
  while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  echo "Stopped all stations."
}

show_status() {
  if [[ ! -f "$PIDFILE" ]]; then
    echo "No stations running."
    return 0
  fi
  printf "%-10s %-8s %s\n" "STATION" "PID" "STATE"
  idx=1
  while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      state="running"
    else
      state="dead"
    fi
    printf "%-10s %-8s %s\n" "$idx" "$pid" "$state"
    idx=$((idx + 1))
  done < "$PIDFILE"
}

case "$cmd" in
  stop)
    stop_all
    exit 0
    ;;
  status)
    show_status
    exit 0
    ;;
  "" | -h | --help | help)
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    echo "Usage: $0 <count> [generator args...] | stop | status"
    exit 0
    ;;
esac

if ! [[ "$cmd" =~ ^[0-9]+$ ]] || [[ "$cmd" -lt 1 ]]; then
  echo "Error: first argument must be a positive station count, got '$cmd'." >&2
  echo "Usage: $0 <count> [generator args...] | stop | status" >&2
  exit 1
fi
COUNT="$cmd"
shift
EXTRA_ARGS=("$@")

# Stop any previous run first so relaunches don't double up stations.
if [[ -f "$PIDFILE" ]]; then
  echo "Stopping previous run..."
  stop_all
fi

mkdir -p "$LOGDIR"
: > "$PIDFILE"

echo "Starting $COUNT station(s) (IDs 1-$COUNT)..."
for i in $(seq 1 "$COUNT"); do
  # shellcheck disable=SC2086
  nohup python3 generator.py --station-id "$i" "${EXTRA_ARGS[@]}" \
    >> "$LOGDIR/station-$i.log" 2>&1 &
  echo $! >> "$PIDFILE"
  echo "  station $i -> pid $! (log: $LOGDIR/station-$i.log)"
done

echo "Done. $COUNT station(s) running. Try: $0 status | tail -f $LOGDIR/station-1.log | $0 stop"
