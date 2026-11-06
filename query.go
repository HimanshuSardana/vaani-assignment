// query.go — query a station's canonical history from local WAL files.
//
// Usage:
//   go run query.go --station 3
//   go run query.go --station 3 --from 2026-11-06T12:00:00Z --to 2026-11-06T13:00:00Z --limit 5 --format json
//   go run query.go --similar-to 1 --top-k 3
//
// History = one station's records, deduplicated on event_id (highest
// version wins, so corrections override), sorted by event time (ts).
// This is the same canonicalization the future ingest service must do
// on write; here we do it at read time over logs/wal-<id>.jsonl.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Record is one generator output line (data lines only).
type Record struct {
	StationID int     `json:"station_id"`
	EventID   string  `json:"event_id"`
	Seq       int     `json:"seq"`
	Version   int     `json:"version"`
	Ts        string  `json:"ts"`
	Value     float64 `json:"value"`
	Archetype string  `json:"archetype"`
}

// ParsedTime parses the record's event timestamp.
func (r Record) ParsedTime() (time.Time, error) {
	return time.Parse(time.RFC3339, r.Ts)
}

// loadHistory reads dir/wal-<station>.jsonl, applies dedupe +
// highest-version-wins, and returns records sorted by event time.
func loadHistory(dir string, station int) ([]Record, error) {
	path := filepath.Join(dir, fmt.Sprintf("wal-%d.jsonl", station))
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w (are generators running? try ./start-generators.sh 10)", path, err)
	}
	defer f.Close()

	byEvent := map[string]Record{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var r Record
		if err := json.Unmarshal(line, &r); err != nil {
			continue
		}
		if r.EventID == "" {
			continue // lifecycle line (station up/outage), not data
		}
		if cur, ok := byEvent[r.EventID]; !ok || r.Version > cur.Version {
			byEvent[r.EventID] = r
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}

	out := make([]Record, 0, len(byEvent))
	for _, r := range byEvent {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ts < out[j].Ts })
	return out, nil
}

func parseBound(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("bad time %q: use RFC3339 (2026-11-06T12:00:00Z) or YYYY-MM-DD", s)
}

// bucketMeans resamples a history into mean values per fixed time bucket.
// This is the downsampling step that makes histories comparable (and is
// what a memory-constrained system would store instead of raw points).
func bucketMeans(hist []Record, bucket time.Duration) map[int64]float64 {
	sum := map[int64]float64{}
	n := map[int64]int{}
	for _, r := range hist {
		t, err := r.ParsedTime()
		if err != nil {
			continue
		}
		b := t.Unix() / int64(bucket.Seconds())
		sum[b] += r.Value
		n[b]++
	}
	means := map[int64]float64{}
	for b, s := range sum {
		means[b] = s / float64(n[b])
	}
	return means
}

// pearson returns the Pearson correlation of two equal-length series.
func pearson(a, b []float64) float64 {
	n := float64(len(a))
	var sa, sb float64
	for i := range a {
		sa += a[i]
		sb += b[i]
	}
	ma, mb := sa/n, sb/n
	var num, da, db float64
	for i := range a {
		x, y := a[i]-ma, b[i]-mb
		num += x * y
		da += x * x
		db += y * y
	}
	if da == 0 || db == 0 {
		return 0
	}
	return num / (math.Sqrt(da) * math.Sqrt(db))
}

func main() {
	station := flag.Int("station", 0, "station ID whose history to show")
	similarTo := flag.Int("similar-to", 0, "rank stations by similarity to this station ID")
	topK := flag.Int("top-k", 3, "how many similar stations to show")
	dir := flag.String("dir", "logs", "directory holding wal-<id>.jsonl files")
	from := flag.String("from", "", "start of time range (RFC3339 or YYYY-MM-DD)")
	to := flag.String("to", "", "end of time range (RFC3339 or YYYY-MM-DD)")
	limit := flag.Int("limit", 20, "max rows to print (0 = all)")
	format := flag.String("format", "table", "table or json")
	flag.Parse()

	fromT, err := parseBound(*from)
	if err != nil {
		fatal(err)
	}
	toT, err := parseBound(*to)
	if err != nil {
		fatal(err)
	}
	inRange := func(r Record) bool {
		t, err := r.ParsedTime()
		if err != nil {
			return false
		}
		if !fromT.IsZero() && t.Before(fromT) {
			return false
		}
		if !toT.IsZero() && !t.Before(toT) {
			return false
		}
		return true
	}

	// --- similarity mode ---
	if *similarTo != 0 {
		runSimilar(*dir, *similarTo, *topK)
		return
	}

	// --- history mode ---
	if *station == 0 {
		fmt.Fprintln(os.Stderr, "need --station <id> or --similar-to <id>")
		flag.Usage()
		os.Exit(1)
	}
	hist, err := loadHistory(*dir, *station)
	if err != nil {
		fatal(err)
	}
	filtered := hist[:0]
	for _, r := range hist {
		if inRange(r) {
			filtered = append(filtered, r)
		}
	}
	hist = filtered
	if *limit > 0 && len(hist) > *limit {
		hist = hist[:*limit]
	}

	switch *format {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		for _, r := range hist {
			if err := enc.Encode(r); err != nil {
				fatal(err)
			}
		}
	default:
		fmt.Printf("station %d history: %d readings (deduped, by event time)\n", *station, len(hist))
		fmt.Printf("%-26s %-12s %-4s %s\n", "TS", "EVENT_ID", "VER", "VALUE")
		for _, r := range hist {
			fmt.Printf("%-26s %-12s %-4d %.3f\n", r.Ts, r.EventID, r.Version, r.Value)
		}
	}
}

// runSimilar ranks all other stations by Pearson correlation of their
// per-minute bucket means against the target station, over shared buckets.
func runSimilar(dir string, target, topK int) {
	files, _ := filepath.Glob(filepath.Join(dir, "wal-*.jsonl"))
	if len(files) == 0 {
		fatal(fmt.Errorf("no WAL files in %s", dir))
	}
	targetHist, err := loadHistory(dir, target)
	if err != nil {
		fatal(err)
	}
	const bucket = 30 * time.Second
	const minOverlap = 3
	tm := bucketMeans(targetHist, bucket)

	type scored struct {
		id    int
		score float64
		n     int
		arch  string
	}
	var out []scored
	for _, f := range files {
		var id int
		if _, err := fmt.Sscanf(filepath.Base(f), "wal-%d.jsonl", &id); err != nil {
			continue
		}
		if id == target {
			continue
		}
		h, err := loadHistory(dir, id)
		if err != nil || len(h) == 0 {
			continue
		}
		om := bucketMeans(h, bucket)
		var a, b []float64
		for k, v := range tm {
			if w, ok := om[k]; ok {
				a = append(a, v)
				b = append(b, w)
			}
		}
		if len(a) < minOverlap {
			continue // not enough overlap to judge
		}
		arch := h[0].Archetype
		out = append(out, scored{id, pearson(a, b), len(a), arch})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].score > out[j].score })
	if topK > 0 && len(out) > topK {
		out = out[:topK]
	}
	tArch := ""
	if len(targetHist) > 0 {
		tArch = targetHist[0].Archetype
	}
	if len(out) == 0 {
		fmt.Printf("not enough overlapping data to judge similarity yet (need %d shared 30s buckets) — let generators run longer.\n", minOverlap)
		return
	}
	fmt.Printf("stations most like %d (archetype %q), by correlation of per-30s means:\n", target, tArch)
	fmt.Printf("%-8s %-10s %-10s %s\n", "STATION", "ARCHETYPE", "OVERLAP", "SCORE")
	for _, s := range out {
		fmt.Printf("%-8d %-10s %-10d %.4f\n", s.id, s.arch, s.n, s.score)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
