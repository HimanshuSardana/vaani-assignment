package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Rollups are what make "history" affordable forever: raw readings are kept for
// a retention window, and everything older is folded into fixed-width aggregates
// (per minute, per hour). A year of 60s readings collapses from ~500k rows to
// ~8.8k hourly rows per station.
type rollupLine struct {
	Bucket int64   `json:"bucket"` // unix seconds, truncated to the resolution
	N      int     `json:"n"`
	Mean   float64 `json:"mean"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
}

type walRecord struct {
	Ts    string  `json:"ts"`
	Value float64 `json:"value"`
}

// Resolutions we maintain, in seconds.
var resolutions = []int64{60, 3600}

func rollupPath(dir string, station int, res int64) string {
	return filepath.Join(dir, fmt.Sprintf("rollup-%d-%d.jsonl", station, res))
}

// truncate aligns a unix time down to a resolution boundary.
func truncate(sec int64, res int64) int64 { return sec - sec%res }

type acc struct {
	n             int
	sum, min, max float64
}

func (a *acc) add(v float64) {
	if a.n == 0 {
		a.min, a.max = v, v
	} else {
		if v < a.min {
			a.min = v
		}
		if v > a.max {
			a.max = v
		}
	}
	a.n++
	a.sum += v
}

// CompactResult reports what a compaction pass did.
type CompactResult struct {
	Station    int
	Folded     int // records moved into rollups
	Kept       int // records left in the raw WAL
	RollupRows int
}

/*
Compact folds every reading older than `retention` into rollups, then rewrites
the raw WAL without those readings.

Crash safety: rollups are written and fsynced *before* the WAL is rewritten, and
the cutoff is aligned to the coarsest resolution boundary. That makes the fold
idempotent — a crash between the two steps just re-folds the same whole buckets
on the next pass and produces identical aggregate values, so no data is lost and
nothing is double counted.
*/
func Compact(dir string, station int, retention time.Duration, now time.Time) (CompactResult, error) {
	res := CompactResult{Station: station}
	wal := filepath.Join(dir, fmt.Sprintf("wal-%d.jsonl", station))

	f, err := os.Open(wal)
	if err != nil {
		return res, err
	}
	defer f.Close()

	// Align the cutoff so buckets are folded whole.
	cutoff := truncate(now.Add(-retention).Unix(), resolutions[len(resolutions)-1])

	buckets := make(map[int64]map[int64]*acc, len(resolutions))
	for _, r := range resolutions {
		buckets[r] = map[int64]*acc{}
	}

	var kept [][]byte
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var rec walRecord
		if json.Unmarshal(line, &rec) != nil {
			kept = append(kept, append([]byte(nil), line...)) // unparseable: keep, never destroy
			continue
		}
		ts, err := time.Parse(time.RFC3339, rec.Ts)
		if err != nil || ts.Unix() >= cutoff {
			kept = append(kept, append([]byte(nil), line...))
			continue
		}
		res.Folded++
		for _, r := range resolutions {
			b := truncate(ts.Unix(), r)
			if buckets[r][b] == nil {
				buckets[r][b] = &acc{}
			}
			buckets[r][b].add(rec.Value)
		}
	}
	if err := sc.Err(); err != nil {
		return res, err
	}
	res.Kept = len(kept)
	if res.Folded == 0 {
		return res, nil // nothing to do; leave files untouched
	}

	// 1. Rollups first (idempotent upsert), fsynced.
	for _, r := range resolutions {
		if err := upsertRollups(dir, station, r, buckets[r]); err != nil {
			return res, fmt.Errorf("rollup %ds: %w", r, err)
		}
	}

	// 2. Then drop the folded rows from the raw WAL, atomically.
	if err := rewriteAtomic(wal, kept); err != nil {
		return res, fmt.Errorf("rewrite wal: %w", err)
	}

	res.RollupRows = len(buckets[resolutions[0]])
	return res, nil
}

// upsertRollups merges computed buckets into the existing rollup file, replacing
// any bucket we recomputed (replace, not add, is what makes replays safe).
func upsertRollups(dir string, station int, res int64, fresh map[int64]*acc) error {
	path := rollupPath(dir, station, res)
	existing := map[int64]rollupLine{}

	if f, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var l rollupLine
			if json.Unmarshal(sc.Bytes(), &l) == nil && l.N > 0 {
				existing[l.Bucket] = l
			}
		}
		f.Close()
	}

	for b, a := range fresh {
		if a.n == 0 {
			continue
		}
		existing[b] = rollupLine{
			Bucket: b,
			N:      a.n,
			Mean:   a.sum / float64(a.n),
			Min:    a.min,
			Max:    a.max,
		}
	}

	keys := make([]int64, 0, len(existing))
	for k := range existing {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	var out []byte
	for _, k := range keys {
		l := existing[k]
		out = append(out, []byte(fmt.Sprintf(
			`{"bucket":%d,"n":%d,"mean":%g,"min":%g,"max":%g}`+"\n",
			l.Bucket, l.N, l.Mean, l.Min, l.Max))...)
	}
	return rewriteAtomicBytes(path, out)
}

// rewriteAtomic replaces path with data via tmp + fsync + rename, so a reader
// never observes a half-written file.
func rewriteAtomicBytes(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	// The rename itself needs a directory sync to survive a crash.
	return SyncDir(filepath.Dir(path))
}

func rewriteAtomic(path string, lines [][]byte) error {
	var out []byte
	for _, l := range lines {
		out = append(out, l...)
		out = append(out, '\n')
	}
	return rewriteAtomicBytes(path, out)
}

// CompactAll runs a pass for every station present in dir.
func CompactAll(dir string, retention time.Duration, now time.Time) []CompactResult {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []CompactResult
	for _, e := range entries {
		var station int
		if n, err := fmt.Sscanf(e.Name(), "wal-%d.jsonl", &station); n != 1 || err != nil {
			continue
		}
		r, err := Compact(dir, station, retention, now)
		if err != nil {
			r.Station = -station // negative marks failure
		}
		out = append(out, r)
	}
	return out
}
