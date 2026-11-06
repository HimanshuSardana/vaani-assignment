package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestServer(t *testing.T, sync bool) (*httptest.Server, *Writer, string) {
	t.Helper()
	dir := t.TempDir()
	w := NewWriter(dir, 256, 2*time.Millisecond, sync)
	if err := w.Recover(); err != nil {
		t.Fatalf("recover: %v", err)
	}
	go w.Run()
	mux := http.NewServeMux()
	mux.Handle("/ingest", ingestHandler(w))
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Close(); w.Close() })
	return srv, w, dir
}

func post(t *testing.T, url, body string) (int, ingestResponse) {
	t.Helper()
	res, err := http.Post(url+"/ingest", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	var out ingestResponse
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func rec(station int, event string, version int, value float64, ts string) string {
	return fmt.Sprintf(`{"station_id":%d,"event_id":%q,"version":%d,"ts":%q,"value":%f,"extra":"kept"}`,
		station, event, version, ts, value)
}

func lines(t *testing.T, dir string, station int) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("wal-%d.jsonl", station)))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatalf("read wal: %v", err)
	}
	var out []string
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(l) > 0 {
			out = append(out, string(l))
		}
	}
	return out
}

const ts = "2026-11-06T12:00:00.000Z"

func TestDuplicateIsIdempotent(t *testing.T) {
	srv, _, dir := newTestServer(t, true)
	body := rec(1, "1:a:1", 1, 21.5, ts)

	code, r1 := post(t, srv.URL, body)
	if code != 200 || r1.Accepted != 1 {
		t.Fatalf("first post: code=%d %+v", code, r1)
	}
	// Same request again (a retry): acknowledged, but not stored twice.
	code, r2 := post(t, srv.URL, body)
	if code != 200 || r2.Accepted != 0 || r2.Duplicates != 1 {
		t.Fatalf("retry should be a duplicate: code=%d %+v", code, r2)
	}
	if got := len(lines(t, dir, 1)); got != 1 {
		t.Fatalf("want 1 stored line, got %d", got)
	}
}

func TestVersionWinsHighest(t *testing.T) {
	srv, _, dir := newTestServer(t, true)

	if code, r := post(t, srv.URL, rec(2, "2:a:1", 1, 10, ts)); code != 200 || r.Accepted != 1 {
		t.Fatalf("v1: code=%d %+v", code, r)
	}
	// A correction (v2) must be accepted.
	if code, r := post(t, srv.URL, rec(2, "2:a:1", 2, 11, ts)); code != 200 || r.Accepted != 1 {
		t.Fatalf("v2 correction: code=%d %+v", code, r)
	}
	// A stale replay (v1 again) must be rejected as a duplicate.
	if code, r := post(t, srv.URL, rec(2, "2:a:1", 1, 10, ts)); code != 200 || r.Duplicates != 1 {
		t.Fatalf("stale v1: code=%d %+v", code, r)
	}
	if got := len(lines(t, dir, 2)); got != 2 {
		t.Fatalf("want v1+v2 stored (readers pick the winner), got %d lines", got)
	}
}

func TestAckMeansDurable(t *testing.T) {
	srv, _, dir := newTestServer(t, true)
	if code, r := post(t, srv.URL, rec(3, "3:a:1", 1, 20, ts)); code != 200 || r.Accepted != 1 {
		t.Fatalf("post: code=%d %+v", code, r)
	}
	// The moment we have the response, the record must already be on disk.
	got := lines(t, dir, 3)
	if len(got) != 1 {
		t.Fatalf("ack returned but %d lines on disk", len(got))
	}
	if !strings.Contains(got[0], "3:a:1") {
		t.Fatalf("unexpected stored line: %s", got[0])
	}
}

func TestUnknownFieldsSurvive(t *testing.T) {
	srv, _, dir := newTestServer(t, true)
	post(t, srv.URL, rec(4, "4:a:1", 1, 20, ts))
	got := lines(t, dir, 4)
	if len(got) != 1 || !strings.Contains(got[0], `"extra":"kept"`) {
		t.Fatalf("format evolution broken, stored: %v", got)
	}
}

func TestBatchIsAtomic(t *testing.T) {
	srv, _, dir := newTestServer(t, true)
	body := "[" + rec(5, "5:a:1", 1, 1, ts) + `,{"station_id":5,"event_id":"5:a:2","version":0,"ts":"` + ts + `","value":2}]`
	code, r := post(t, srv.URL, body)
	if code != 400 {
		t.Fatalf("batch with an invalid record should be rejected wholesale: code=%d %+v", code, r)
	}
	if got := lines(t, dir, 5); len(got) != 0 {
		t.Fatalf("no part of a rejected batch may be written, got %d lines", len(got))
	}
}

func TestRecoveryRebuildsDedupeIndex(t *testing.T) {
	srv, w, dir := newTestServer(t, true)
	post(t, srv.URL, rec(6, "6:a:1", 1, 5, ts))
	srv.Close()
	w.Close()
	time.Sleep(20 * time.Millisecond)

	// A fresh process against the same directory must remember the event.
	w2 := NewWriter(dir, 256, 2*time.Millisecond, true)
	if err := w2.Recover(); err != nil {
		t.Fatalf("recover: %v", err)
	}
	if w2.Stats.Recovered.Load() != 1 {
		t.Fatalf("expected 1 recovered record, got %d", w2.Stats.Recovered.Load())
	}
	go w2.Run()
	defer w2.Close()
	mux := http.NewServeMux()
	mux.Handle("/ingest", ingestHandler(w2))
	srv2 := httptest.NewServer(mux)
	defer srv2.Close()

	if code, r := post(t, srv2.URL, rec(6, "6:a:1", 1, 5, ts)); code != 200 || r.Duplicates != 1 {
		t.Fatalf("after recovery the replayed record must be a duplicate: code=%d %+v", code, r)
	}
	if got := len(lines(t, dir, 6)); got != 1 {
		t.Fatalf("recovery must not append the duplicate, got %d lines", got)
	}
}

func TestConcurrentPostsLoseNothing(t *testing.T) {
	srv, _, dir := newTestServer(t, true)
	const workers, perWorker = 8, 150

	var wg sync.WaitGroup
	for wk := 0; wk < workers; wk++ {
		wg.Add(1)
		go func(wk int) {
			defer wg.Done()
			var sb strings.Builder
			sb.WriteString("[")
			for i := 0; i < perWorker; i++ {
				if i > 0 {
					sb.WriteString(",")
				}
				sb.WriteString(rec(7, fmt.Sprintf("7:w%d:%d", wk, i), 1, float64(i), ts))
			}
			sb.WriteString("]")
			if code, r := post(t, srv.URL, sb.String()); code != 200 || r.Accepted != perWorker {
				t.Errorf("worker %d: code=%d %+v", wk, code, r)
			}
		}(wk)
	}
	wg.Wait()

	got := lines(t, dir, 7)
	if len(got) != workers*perWorker {
		t.Fatalf("want %d lines, got %d", workers*perWorker, len(got))
	}
	seen := make(map[string]bool, len(got))
	for _, l := range got {
		var r struct {
			EventID string `json:"event_id"`
		}
		if err := json.Unmarshal([]byte(l), &r); err != nil {
			t.Fatalf("corrupt line: %q", l)
		}
		if seen[r.EventID] {
			t.Fatalf("duplicate event written: %s", r.EventID)
		}
		seen[r.EventID] = true
	}
}

func TestRejectsBadInput(t *testing.T) {
	srv, _, _ := newTestServer(t, true)
	cases := []string{
		``,
		`{}`,
		`{"station_id":1,"event_id":"","version":1,"ts":"` + ts + `","value":1}`,
		`{"station_id":1,"event_id":"x","version":0,"ts":"` + ts + `","value":1}`,
		`{"station_id":1,"event_id":"x","version":1,"ts":"nope","value":1}`,
		`{"station_id":1,"event_id":"x","version":1,"ts":"` + ts + `"}`,
		`not json`,
	}
	for _, body := range cases {
		if code, _ := post(t, srv.URL, body); code != 400 {
			t.Errorf("want 400 for %q, got %d", body, code)
		}
	}
}

// BenchmarkGroupCommit measures end-to-end HTTP throughput with fsync enabled,
// which is the number that matters on a cheap cloud machine.
func BenchmarkGroupCommit(b *testing.B) {
	dir := b.TempDir()
	w := NewWriter(dir, 512, 5*time.Millisecond, true)
	w.Recover()
	go w.Run()
	defer w.Close()
	mux := http.NewServeMux()
	mux.Handle("/ingest", ingestHandler(w))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	const batch = 50
	body := make([]byte, 0, batch*160)
	body = append(body, '[')
	for i := 0; i < batch; i++ {
		if i > 0 {
			body = append(body, ',')
		}
		body = append(body, []byte(fmt.Sprintf(
			`{"station_id":1,"event_id":"1:bench:%d","version":1,"ts":%q,"value":1.0}`, i, ts))...)
	}
	body = append(body, ']')

	b.ResetTimer()
	b.SetBytes(int64(len(body)))
	for i := 0; i < b.N; i++ {
		res, err := http.Post(srv.URL+"/ingest", "application/json", bytes.NewReader(body))
		if err != nil {
			b.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			b.Fatalf("status %d", res.StatusCode)
		}
	}
	elapsed := b.Elapsed().Seconds()
	b.ReportMetric(float64(b.N*batch)/elapsed, "records/s")
	b.ReportMetric(float64(b.N)/elapsed, "batches/s")
}

/* ---------------- compaction / rollups ---------------- */

func writeWAL(t *testing.T, dir string, station int, recs []string) {
	t.Helper()
	path := filepath.Join(dir, fmt.Sprintf("wal-%d.jsonl", station))
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, r := range recs {
		f.WriteString(r + "\n")
	}
}

func readRollups(t *testing.T, dir string, station int, res int64) map[int64]rollupLine {
	t.Helper()
	out := map[int64]rollupLine{}
	b, err := os.ReadFile(rollupPath(dir, station, res))
	if err != nil {
		return out
	}
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var l rollupLine
		if err := json.Unmarshal(line, &l); err != nil {
			t.Fatalf("bad rollup line %q", line)
		}
		out[l.Bucket] = l
	}
	return out
}

func TestCompactFoldsAndPrunes(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	old := now.Add(-10 * 24 * time.Hour)
	recent := now.Add(-1 * time.Hour)

	writeWAL(t, dir, 1, []string{
		fmt.Sprintf(`{"station_id":1,"event_id":"a","version":1,"ts":%q,"value":10}`, old.Format(time.RFC3339)),
		fmt.Sprintf(`{"station_id":1,"event_id":"b","version":1,"ts":%q,"value":20}`, old.Add(time.Minute).Format(time.RFC3339)),
		fmt.Sprintf(`{"station_id":1,"event_id":"c","version":1,"ts":%q,"value":30}`, recent.Format(time.RFC3339)),
	})

	res, err := Compact(dir, 1, 72*time.Hour, now)
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if res.Folded != 2 || res.Kept != 1 {
		t.Fatalf("want folded=2 kept=1, got %+v", res)
	}

	// Raw WAL keeps only the recent reading.
	if got := lines(t, dir, 1); len(got) != 1 || !strings.Contains(got[0], `"event_id":"c"`) {
		t.Fatalf("raw WAL should hold only recent data, got %v", got)
	}

	// Minute rollups: two separate buckets with the right means.
	min := readRollups(t, dir, 1, 60)
	if len(min) != 2 {
		t.Fatalf("want 2 minute buckets, got %d", len(min))
	}
	for _, l := range min {
		if l.N != 1 {
			t.Fatalf("each bucket has 1 sample, got %+v", l)
		}
	}

	// Hour rollups: both samples in one bucket, mean 15.
	hr := readRollups(t, dir, 1, 3600)
	if len(hr) != 1 {
		t.Fatalf("want 1 hour bucket, got %d", len(hr))
	}
	for _, l := range hr {
		if l.N != 2 || l.Mean != 15 || l.Min != 10 || l.Max != 20 {
			t.Fatalf("bad hour aggregate: %+v", l)
		}
	}
}

func TestCompactIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	old := now.Add(-10 * 24 * time.Hour)
	writeWAL(t, dir, 2, []string{
		fmt.Sprintf(`{"station_id":2,"event_id":"a","version":1,"ts":%q,"value":10}`, old.Format(time.RFC3339)),
		fmt.Sprintf(`{"station_id":2,"event_id":"b","version":1,"ts":%q,"value":30}`, old.Add(time.Minute).Format(time.RFC3339)),
	})

	// Simulate a crash after rollups were written but before the WAL rewrite by
	// running compaction twice: the second pass must not double count.
	if _, err := Compact(dir, 2, 72*time.Hour, now); err != nil {
		t.Fatal(err)
	}
	first := readRollups(t, dir, 2, 3600)
	if _, err := Compact(dir, 2, 72*time.Hour, now); err != nil {
		t.Fatal(err)
	}
	second := readRollups(t, dir, 2, 3600)

	if len(first) != len(second) {
		t.Fatalf("rollup count changed on replay: %d -> %d", len(first), len(second))
	}
	for k, v := range second {
		if first[k].N != v.N || first[k].Mean != v.Mean {
			t.Fatalf("replay changed aggregate for bucket %d: %+v -> %+v", k, first[k], v)
		}
	}
	// And the raw WAL is empty, so nothing is left to fold again.
	if got := lines(t, dir, 2); len(got) != 0 {
		t.Fatalf("expected pruned WAL, got %d lines", len(got))
	}
}

func TestCompactKeepsEverythingWhenNothingIsOld(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeWAL(t, dir, 3, []string{
		fmt.Sprintf(`{"station_id":3,"event_id":"a","version":1,"ts":%q,"value":1}`, now.Format(time.RFC3339)),
	})
	before := len(lines(t, dir, 3))
	res, err := Compact(dir, 3, 24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if res.Folded != 0 || len(lines(t, dir, 3)) != before {
		t.Fatalf("nothing should be folded: %+v", res)
	}
	if _, err := os.Stat(rollupPath(dir, 3, 60)); !os.IsNotExist(err) {
		t.Fatalf("no rollup file should be created when nothing is folded")
	}
}
