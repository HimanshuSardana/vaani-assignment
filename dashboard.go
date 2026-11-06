// dashboard.go — live dashboard server for station readings.
//
// Serves dashboard.html plus a JSON/SSE API backed by the generator WALs.
// Stdlib only.
//
//   go run dashboard.go                # serves on :8080
//   go run dashboard.go --addr :9090 --dir logs
//
// Endpoints:
//   GET /                    dashboard page
//   GET /api/stations        [1,2,...] (from wal-*.jsonl in --dir)
//   GET /api/history?station=3[&limit=500]   canonical history JSON
//   GET /api/stream          SSE: every new WAL line as `data: {...}`
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Record is one generator data line.
type Record struct {
	StationID int     `json:"station_id"`
	EventID   string  `json:"event_id"`
	Seq       int     `json:"seq"`
	Version   int     `json:"version"`
	Ts        string  `json:"ts"`
	Value     float64 `json:"value"`
	Archetype string  `json:"archetype"`
}

var dataDir string

func listStations() []int {
	files, _ := filepath.Glob(filepath.Join(dataDir, "wal-*.jsonl"))
	var ids []int
	for _, f := range files {
		var id int
		if _, err := fmt.Sscanf(filepath.Base(f), "wal-%d.jsonl", &id); err == nil {
			ids = append(ids, id)
		}
	}
	sort.Ints(ids)
	return ids
}

// loadHistory returns canonical history: dedupe on event_id,
// highest version wins, sorted by event time.
func loadHistory(station int) ([]Record, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, fmt.Sprintf("wal-%d.jsonl", station)))
	if err != nil {
		return nil, err
	}
	byEvent := map[string]Record{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var r Record
		if err := json.Unmarshal([]byte(line), &r); err != nil || r.EventID == "" {
			continue
		}
		if cur, ok := byEvent[r.EventID]; !ok || r.Version > cur.Version {
			byEvent[r.EventID] = r
		}
	}
	out := make([]Record, 0, len(byEvent))
	for _, r := range byEvent {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ts < out[j].Ts })
	return out, nil
}

func handleStations(w http.ResponseWriter, r *http.Request) {
	ids := listStations()
	if ids == nil {
		ids = []int{}
	}
	writeJSON(w, ids)
}

func handleHistory(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.URL.Query().Get("station"))
	if err != nil {
		http.Error(w, "need ?station=<id>", http.StatusBadRequest)
		return
	}
	hist, err := loadHistory(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if lim, _ := strconv.Atoi(r.URL.Query().Get("limit")); lim > 0 && len(hist) > lim {
		hist = hist[len(hist)-lim:] // most recent
	}
	writeJSON(w, hist)
}

// handleStream tails every wal-*.jsonl and forwards new lines as SSE.
func handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	offsets := map[string]int64{}
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	sendNew := func() {
		for _, id := range listStations() {
			path := filepath.Join(dataDir, fmt.Sprintf("wal-%d.jsonl", id))
			f, err := os.Open(path)
			if err != nil {
				continue
			}
			fi, err := f.Stat()
			if err != nil {
				f.Close()
				continue
			}
			off := offsets[path]
			if fi.Size() < off {
				off = 0 // truncated/rotated
			}
			if _, err := f.Seek(off, io.SeekStart); err != nil {
				f.Close()
				continue
			}
			buf, _ := io.ReadAll(f)
			f.Close()
			if len(buf) == 0 {
				continue
			}
			// Only forward complete lines; keep partial tail for next tick.
			upto := strings.LastIndexByte(string(buf), '\n')
			if upto < 0 {
				continue
			}
			offsets[path] = off + int64(upto) + 1
			for _, line := range strings.Split(string(buf[:upto]), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "{") || !strings.Contains(line, "event_id") {
					continue
				}
				fmt.Fprintf(w, "data: %s\n\n", line)
			}
			fl.Flush()
		}
	}
	sendNew()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			sendNew()
		case <-ping.C:
			fmt.Fprintf(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dir := flag.String("dir", "logs", "directory holding wal-<id>.jsonl files")
	flag.Parse()
	dataDir = *dir

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "dashboard.html")
	})
	http.HandleFunc("/api/stations", handleStations)
	http.HandleFunc("/api/history", handleHistory)
	http.HandleFunc("/api/stream", handleStream)

	log.Printf("dashboard on http://localhost%s (data dir: %s)", *addr, dataDir)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
