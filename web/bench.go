// bench.go — benchmark the history + similar-stations endpoints.
//
//	go run bench.go --base http://localhost:3000 --station 1 --limit 500
//	go run bench.go --station 1 --concurrency 8 --json
//
// What it measures
//   /api/history        serial latency of a real payload (warmup excluded)
//   /api/history (304)  cost of an ETag revalidation — the poll path clients use
//   /api/history (load) N concurrent workers, reported as throughput + latency
//   /api/similar        ranking latency
//
// Stdlib only.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type stats struct {
	N                  int     `json:"n"`
	Min                float64 `json:"min_ms"`
	P50                float64 `json:"p50_ms"`
	P95                float64 `json:"p95_ms"`
	P99                float64 `json:"p99_ms"`
	Max                float64 `json:"max_ms"`
	Mean               float64 `json:"mean_ms"`
	Stdev              float64 `json:"stdev_ms"`
	Bytes              int     `json:"bytes"`
	RPS                float64 `json:"rps"`
	Status             int     `json:"status"`
	Note               string  `json:"note,omitempty"`
}

func summarize(xs []float64, wall float64) stats {
	s := stats{N: len(xs)}
	if len(xs) == 0 {
		return s
	}
	sorted := append([]float64(nil), xs...)
	sort.Float64s(sorted)
	q := func(p float64) float64 {
		i := int(p * float64(len(sorted)))
		if i >= len(sorted) {
			i = len(sorted) - 1
		}
		return sorted[i]
	}
	var sum float64
	for _, v := range sorted {
		sum += v
	}
	s.Min = sorted[0]
	s.Max = sorted[len(sorted)-1]
	s.Mean = sum / float64(len(sorted))
	s.P50, s.P95, s.P99 = q(0.50), q(0.95), q(0.99)
	var varsum float64
	for _, v := range sorted {
		varsum += (v - s.Mean) * (v - s.Mean)
	}
	s.Stdev = math.Sqrt(varsum / float64(len(sorted)))
	if wall > 0 {
		s.RPS = float64(len(sorted)) / wall
	}
	return s
}

type resp struct {
	ms     float64
	status int
	bytes  int
	body   []byte
	header http.Header
}

func get(client *http.Client, url string, hdr map[string]string) resp {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return resp{status: -1}
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	t0 := time.Now()
	r, err := client.Do(req)
	if err != nil {
		return resp{status: -1}
	}
	defer r.Body.Close()
	body, _ := io.ReadAll(r.Body)
	return resp{
		ms:     float64(time.Since(t0).Microseconds()) / 1000,
		status: r.StatusCode,
		bytes:  len(body),
		body:   body,
		header: r.Header,
	}
}

// run issues n sequential requests and returns the sample set.
func run(client *http.Client, url string, hdr map[string]string, n int) ([]float64, resp) {
	var xs []float64
	var last resp
	for i := 0; i < n; i++ {
		r := get(client, url, hdr)
		xs = append(xs, r.ms)
		last = r
	}
	return xs, last
}

// load drives c concurrent workers issuing n total requests.
func load(client *http.Client, url string, c, n int) ([]float64, float64) {
	var mu sync.Mutex
	var xs []float64
	sem := make(chan struct{}, c)
	var wg sync.WaitGroup
	t0 := time.Now()
	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			r := get(client, url, nil)
			mu.Lock()
			xs = append(xs, r.ms)
			mu.Unlock()
		}()
	}
	wg.Wait()
	return xs, time.Since(t0).Seconds()
}

func main() {
	base := flag.String("base", "http://localhost:3000", "server URL")
	station := flag.Int("station", 1, "station ID")
	limit := flag.Int("limit", 500, "history limit (0 = entire history)")
	topK := flag.Int("top-k", 3, "similar: how many results")
	iters := flag.Int("iterations", 20, "timed sequential requests")
	warmup := flag.Int("warmup", 3, "untimed warmup requests")
	conc := flag.Int("concurrency", 8, "workers for the load test")
	loadN := flag.Int("load-requests", 80, "total requests in the load test")
	asJSON := flag.Bool("json", false, "emit JSON instead of a table")
	flag.Parse()

	client := &http.Client{Timeout: 30 * time.Second}
	if r := get(client, *base+"/api/stations", nil); r.status != 200 {
		fmt.Fprintf(os.Stderr, "error: nothing healthy at %s (run: cd web && npm run dev)\n", *base)
		os.Exit(1)
	}

	histURL := fmt.Sprintf("%s/api/history?station=%d&limit=%d", *base, *station, *limit)
	simURL := fmt.Sprintf("%s/api/similar?station=%d&top_k=%d", *base, *station, *topK)

	var rows []stats

	// 1. history (warmup excluded so caches/JIT reach steady state honestly)
	for i := 0; i < *warmup; i++ {
		get(client, histURL, nil)
	}
	xs, last := run(client, histURL, nil, *iters)
	h := summarize(xs, 0)
	h.Bytes = last.bytes
	h.Status = last.status
	h.RPS = 0
	h.Note = fmt.Sprintf("server:%sms cache:%s",
		last.header.Get("X-History-Time"), orDash(last.header.Get("X-History-Cache")))
	rows = append(rows, h)

	// 2. legacy handler (pre-optimization code, same dataset/server)
	legacyURL := fmt.Sprintf("%s/api/history-legacy?station=%d&limit=%d", *base, *station, *limit)
	if probe := get(client, legacyURL, nil); probe.status == 200 {
		for i := 0; i < *warmup; i++ {
			get(client, legacyURL, nil)
		}
		xsLegacy, lastLegacy := run(client, legacyURL, nil, *iters)
		l := summarize(xsLegacy, 0)
		l.Bytes = lastLegacy.bytes
		l.Status = lastLegacy.status
		l.Note = "pre-optimization, " + lastLegacy.header.Get("X-History-Time") + "ms server"
		rows = append(rows, l)
	}

	// 3. cold path (cache bypassed): isolates parse cost from cache cost
	coldURL := histURL + "&nocache=1"
	for i := 0; i < *warmup; i++ {
		get(client, coldURL, nil)
	}
	xsCold, lastCold := run(client, coldURL, nil, *iters)
	c := summarize(xsCold, 0)
	c.Bytes = lastCold.bytes
	c.Status = lastCold.status
	c.Note = "nocache=1, " + lastCold.header.Get("X-History-Time") + "ms server"
	rows = append(rows, c)

	// 4. 304 revalidation (what a polling client actually costs when idle)
	if etag := last.header.Get("ETag"); etag != "" {
		xs304, last304 := run(client, histURL, map[string]string{"If-None-Match": etag}, *iters)
		s := summarize(xs304, 0)
		s.Bytes = last304.bytes
		s.Status = last304.status
		s.Note = "ETag revalidation, no body"
		rows = append(rows, s)
	}

	// 5. concurrent load
	xsLoad, wall := load(client, histURL, *conc, *loadN)
	s := summarize(xsLoad, wall)
	s.Bytes = last.bytes
	s.Status = 200
	s.Note = fmt.Sprintf("%d workers", *conc)
	rows = append(rows, s)

	// 6. similar
	for i := 0; i < *warmup; i++ {
		get(client, simURL, nil)
	}
	xsSim, lastSim := run(client, simURL, nil, *iters)
	sm := summarize(xsSim, 0)
	sm.Bytes = lastSim.bytes
	sm.Status = lastSim.status
	sm.Note = "ewma-pearson, " + fmt.Sprintf("%d stations", countCompared(lastSim.body))
	rows = append(rows, sm)

	// 7. same ranking with batch (unweighted) Pearson, for comparison
	batchURL := simURL + "&metric=pearson"
	if probe := get(client, batchURL, nil); probe.status == 200 {
		for i := 0; i < *warmup; i++ {
			get(client, batchURL, nil)
		}
		xsBatch, lastBatch := run(client, batchURL, nil, *iters)
		b := summarize(xsBatch, 0)
		b.Bytes = lastBatch.bytes
		b.Status = lastBatch.status
		b.Note = "batch pearson, " + fmt.Sprintf("%d stations", countCompared(lastBatch.body))
		rows = append(rows, b)
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(map[string]any{
			"base":    *base,
			"station": *station,
			"limit":   *limit,
			"results": rows,
		})
		return
	}

	fmt.Printf("base=%s station=%d limit=%d iters=%d warmup=%d\n\n",
		*base, *station, *limit, *iters, *warmup)
	printTable(rows)
}

func countCompared(body []byte) int {
	var v struct {
		Compared []int `json:"compared_against"`
	}
	if json.Unmarshal(body, &v) == nil {
		return len(v.Compared)
	}
	return 0
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

const border = "+-------------------------+------+--------+--------+--------+--------+--------+--------+--------+----------+-------+" +
	"------------------------------+"

var names = map[string]string{
	"history": "history", "304": "history (304)", "load": "history (load)", "similar": "similar",
}

func printTable(rows []stats) {
	labels := []string{"/api/history", "/api/history (legacy)", "/api/history (cold)", "/api/history (304)", "/api/history (load)", "/api/similar (ewma)", "/api/similar (batch)"}
	fmt.Println(border)
	fmt.Printf("| %-23s | %-4s | %6s | %6s | %6s | %6s | %6s | %6s | %8s | %6s | %-28s |\n",
		"endpoint", "n", "p50", "p95", "p99", "max", "mean", "stdev", "bytes", "rps", "note")
	fmt.Println(border)
	for i, r := range rows {
		label := "/api/*"
		if i < len(labels) {
			label = labels[i]
		}
		rps := "-"
		if r.RPS > 0 {
			rps = fmt.Sprintf("%.0f", r.RPS)
		}
		fmt.Printf("| %-23s | %-4d | %6.1f | %6.1f | %6.1f | %6.1f | %6.1f | %6.1f | %8d | %6s | %-28s |\n",
			label, r.N, r.P50, r.P95, r.P99, r.Max, r.Mean, r.Stdev, r.Bytes, rps, clip(r.Note, 28))
	}
	fmt.Println(border)
	fmt.Println("ms; rps only meaningful for the concurrent load row")
}

func clip(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n-1])) + "…"
}
