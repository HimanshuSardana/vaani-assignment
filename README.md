# The Archive

Sensor-station archive: generators that misbehave, a durable write path, cheap
reads, and recency-weighted similarity. Design write-up: [`report/report.pdf`](report/report.pdf).

## Layout

| path | what it is |
|---|---|
| `generator.py` | one process = one station; injects late / out-of-order / duplicate / corrected data, outages, permanent death |
| `start-generators.sh` | `./start-generators.sh 10` runs stations 1–10 (`status`, `stop`) |
| `ingest/` | durable write path (Go): `fsync`-before-ack, idempotent dedupe, group commit, crash recovery, compaction into rollups |
| `web/` | Next.js app: history + similarity APIs, rollup reads, dashboard |
| `web/bench.go` | benchmarks old vs new on the same data |
| `seed_data.py` | generates a synthetic year (219 MB) for benchmarking |
| `report/` | the 3-page design document (Typst + PDF) |

## Run it

```bash
# 1. durable ingest (terminal 1)
cd ingest && go run . --addr :8090 --dir ../logs

# 2. stations posting into it (terminal 2)
INGEST_URL=http://localhost:8090/ingest ./start-generators.sh 10

# 3. dashboard + APIs (terminal 3)
cd web && npm install && npm run dev      # http://localhost:3000

# maintenance: fold old readings into rollups and prune raw logs
cd ingest && go run . --compact --dir ../logs --retention 72h
```

Long ranges are served from rollups (`/api/history?station=1&resolution=3600`),
recent ranges from raw readings (`&limit=500`).

## Verify

```bash
cd ingest && go test ./...                 # 13 tests: dedupe, versions, ack==durable,
                                           # recovery, 1,200 concurrent posts, compaction
cd web && npm test                         # 12 tests against the real read path
cd web && npx tsc --noEmit

python3 seed_data.py --days 365            # 1,136,068 readings, 219 MB
cd web && go run bench.go --station 1 --limit 500
```

`ALLOW_LEGACY=1` re-enables `/api/history-legacy`, the pre-optimization handler the
benchmark compares against (off by default so production exposes one history path).

## Measured (prod build, station 1, 1-year archive)

| path | p50 | payload |
|---|---|---|
| `history` old vs new | 1147 ms → **2.7 ms** | 100 KB → 55 KB |
| `history` 304 revalidation | **1.6 ms** | 0 B |
| `history` full year | 1717 ms → **134 ms** | 103 MB → 57 MB |
| `similar` EWMA | **2.2 ms** | 303 B |

Write path with `fsync`: 5.6 ms per acknowledged record; group commit reaches
24,075 records/s at 16 workers. Compaction: 219 MB → 75 MB, one year of hourly
rollups in 679 KB per station.
