// ingest — the durable write path for the archive.
//
// The generators append a write-ahead log locally and POST each reading here.
// This service acknowledges a record only after it is on stable storage, so
// "acknowledged data is never lost" is a property of the HTTP response, not a
// hope. It is deliberately a single static binary with no database: cheap cloud
// machines can disappear, and a self-healing file format is easier to reason
// about than a cluster.
//
//	POST /ingest   single record or array of records
//	GET  /healthz  liveness
//	GET  /stats    counters (accepted, duplicates, fsyncs, batches)
//
// Design notes
//   - Group commit: concurrent requests share one write+fsync per station per
//     batch. fsync is the expensive part, so batching amortises it.
//   - Idempotent: dedupe on (event_id, version), highest version wins. A retry
//     after a crash or a duplicated POST returns 200 with `duplicates` > 0.
//   - Crash safe: the dedupe index is rebuilt from the WALs at startup, so no
//     second store can drift out of sync with the data.
//   - Format tolerant: the request is validated only for the envelope
//     (station_id, event_id, version, ts) and stored byte-for-byte, so adding
//     fields later does not require a migration or a redeploy of the writer.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type record struct {
	StationID int      `json:"station_id"`
	EventID   string   `json:"event_id"`
	Version   int      `json:"version"`
	Ts        string   `json:"ts"`
	Value     *float64 `json:"value"`
}

type ingestResponse struct {
	Accepted   int    `json:"accepted"`
	Duplicates int    `json:"duplicates"`
	Error      string `json:"error,omitempty"`
}

func validate(r record) error {
	if r.StationID <= 0 {
		return errors.New("station_id must be a positive integer")
	}
	if r.EventID == "" {
		return errors.New("event_id is required")
	}
	if r.Version < 1 {
		return errors.New("version must be >= 1")
	}
	if _, err := time.Parse(time.RFC3339, r.Ts); err != nil {
		return fmt.Errorf("ts must be RFC3339: %v", err)
	}
	if r.Value == nil {
		return errors.New("value is required")
	}
	return nil
}

// parseBody accepts either a single object or an array.
func parseBody(body []byte) ([]json.RawMessage, error) {
	body = trimSpace(body)
	if len(body) == 0 {
		return nil, errors.New("empty body")
	}
	if body[0] == '[' {
		var arr []json.RawMessage
		if err := json.Unmarshal(body, &arr); err != nil {
			return nil, fmt.Errorf("invalid JSON array: %v", err)
		}
		if len(arr) == 0 {
			return nil, errors.New("empty array")
		}
		return arr, nil
	}
	var one json.RawMessage
	if err := json.Unmarshal(body, &one); err != nil {
		return nil, fmt.Errorf("invalid JSON: %v", err)
	}
	return []json.RawMessage{one}, nil
}

func trimSpace(b []byte) []byte {
	for len(b) > 0 && (b[0] == ' ' || b[0] == '\n' || b[0] == '\r' || b[0] == '\t') {
		b = b[1:]
	}
	for len(b) > 0 {
		c := b[len(b)-1]
		if c != ' ' && c != '\n' && c != '\r' && c != '\t' {
			break
		}
		b = b[:len(b)-1]
	}
	return b
}

func ingestHandler(w *Writer) http.HandlerFunc {
	return func(rw http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			http.Error(rw, "POST only", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, 16<<20))
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, ingestResponse{Error: err.Error()})
			return
		}
		raws, err := parseBody(body)
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, ingestResponse{Error: err.Error()})
			return
		}

		// Validate the whole request first: a batch is accepted or rejected as
		// a unit, so a partially valid batch cannot be half-written.
		items := make([]item, len(raws))
		for i, raw := range raws {
			var rec record
			if err := json.Unmarshal(raw, &rec); err != nil {
				writeJSON(rw, http.StatusBadRequest, ingestResponse{Error: "invalid record: " + err.Error()})
				return
			}
			if err := validate(rec); err != nil {
				writeJSON(rw, http.StatusBadRequest, ingestResponse{Error: fmt.Sprintf("record %d: %v", i, err)})
				return
			}
			items[i] = item{
				station: rec.StationID,
				eventID: rec.EventID,
				version: rec.Version,
				line:    append([]byte(nil), raw...),
				done:    make(chan result, 1),
			}
		}

		for _, it := range items {
			w.ch <- it
		}

		resp := ingestResponse{}
		for _, it := range items {
			res := <-it.done
			switch {
			case res.err != nil:
				writeJSON(rw, http.StatusInternalServerError, ingestResponse{Error: res.err.Error()})
				return
			case res.duplicate:
				resp.Duplicates++
			default:
				resp.Accepted++
			}
		}
		writeJSON(rw, http.StatusOK, resp)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func main() {
	addr := flag.String("addr", ":8090", "listen address")
	compactOnly := flag.Bool("compact", false, "run one compaction pass and exit")
	retention := flag.Duration("retention", 72*time.Hour, "how long raw readings are kept before folding into rollups")
	dir := flag.String("dir", "logs", "WAL directory (same one the readers use)")
	sync := flag.Bool("sync", true, "fsync before acknowledging (disable only for load tests)")
	maxBatch := flag.Int("max-batch", 512, "max records per group commit")
	maxDelay := flag.Duration("max-delay", 5*time.Millisecond, "max wait to fill a batch")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatalf("data dir: %v", err)
	}

	// Maintenance mode: fold old readings into rollups and prune the raw WAL.
	if *compactOnly {
		for _, r := range CompactAll(*dir, *retention, time.Now()) {
			if r.Station < 0 {
				log.Printf("station %d: compaction failed", -r.Station)
				continue
			}
			log.Printf("station %d: folded=%d kept=%d rollup_rows=%d", r.Station, r.Folded, r.Kept, r.RollupRows)
		}
		return
	}
	w := NewWriter(*dir, *maxBatch, *maxDelay, *sync)
	t0 := time.Now()
	if err := w.Recover(); err != nil {
		log.Fatalf("recovery: %v", err)
	}
	log.Printf("recovered %d records in %s; fsync=%v batch=%d delay=%s",
		w.Stats.Recovered.Load(), time.Since(t0).Round(time.Millisecond), *sync, *maxBatch, *maxDelay)

	go w.Run()

	mux := http.NewServeMux()
	mux.Handle("/ingest", ingestHandler(w))
	mux.HandleFunc("/healthz", func(rw http.ResponseWriter, _ *http.Request) {
		rw.Write([]byte("ok"))
	})
	mux.HandleFunc("/stats", func(rw http.ResponseWriter, _ *http.Request) {
		writeJSON(rw, 200, map[string]uint64{
			"accepted":   w.Stats.Accepted.Load(),
			"duplicates": w.Stats.Duplicates.Load(),
			"fsyncs":     w.Stats.Fsyncs.Load(),
			"batches":    w.Stats.Batches.Load(),
			"recovered":  w.Stats.Recovered.Load(),
		})
	})

	srv := &http.Server{Addr: *addr, Handler: mux}
	go func() {
		log.Printf("ingest on %s (dir %s)", *addr, *dir)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down: draining commits")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	w.Close() // drains the queue; Run() syncs and closes files
	log.Printf("stopped; accepted=%d duplicates=%d fsyncs=%d",
		w.Stats.Accepted.Load(), w.Stats.Duplicates.Load(), w.Stats.Fsyncs.Load())
}
