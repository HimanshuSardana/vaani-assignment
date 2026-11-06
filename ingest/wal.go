package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// item is one accepted-at-HTTP, not-yet-durable record.
type item struct {
	station int
	eventID string
	version int
	line    []byte // stored verbatim: unknown fields survive format changes
	done    chan result
}

type result struct {
	duplicate bool
	err       error
}

// Counters are exposed on /stats for the write-up and for load tests.
type Counters struct {
	Accepted   atomic.Uint64
	Duplicates atomic.Uint64
	Fsyncs     atomic.Uint64
	Batches    atomic.Uint64
	Recovered  atomic.Uint64
}

// Writer performs group commit: many concurrent requests share one write+fsync
// per station per batch, which is what makes durability affordable.
type Writer struct {
	dir       string
	ch        chan item
	idx       map[int]map[string]int // station -> event_id -> highest durable version
	files     map[int]*os.File
	maxBatch  int
	maxDelay  time.Duration
	doSync    bool
	closeOnce sync.Once
	Stats     Counters
}

func NewWriter(dir string, maxBatch int, maxDelay time.Duration, doSync bool) *Writer {
	return &Writer{
		dir:      dir,
		ch:       make(chan item, maxBatch*4),
		idx:      make(map[int]map[string]int),
		files:    make(map[int]*os.File),
		maxBatch: maxBatch,
		maxDelay: maxDelay,
		doSync:   doSync,
	}
}

func (w *Writer) walPath(station int) string {
	return filepath.Join(w.dir, fmt.Sprintf("wal-%d.jsonl", station))
}

func (w *Writer) file(station int) (*os.File, error) {
	if f, ok := w.files[station]; ok {
		return f, nil
	}
	f, err := os.OpenFile(w.walPath(station), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	// fsync(file) does not make a *newly created* directory entry durable.
	// Without this, the first acknowledged records of a brand-new station can
	// vanish on power loss even though their bytes were synced.
	if err := SyncDir(w.dir); err != nil {
		f.Close()
		return nil, err
	}
	w.files[station] = f
	return f, nil
}

// SyncDir flushes a directory's entries, making creations/renames durable.
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Recover rebuilds the dedupe index from the WALs on startup, so idempotency
// survives a crash: an acknowledged record is on disk, and its event_id is
// known again without a separate database.
func (w *Writer) Recover() error {
	entries, err := os.ReadDir(w.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return os.MkdirAll(w.dir, 0o755)
		}
		return err
	}
	for _, e := range entries {
		var station int
		if n, err := fmt.Sscanf(e.Name(), "wal-%d.jsonl", &station); n != 1 || err != nil {
			continue
		}
		f, err := os.Open(filepath.Join(w.dir, e.Name()))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		m := make(map[string]int, 1<<12)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 || line[0] != '{' {
				continue
			}
			var head struct {
				EventID string `json:"event_id"`
				Version int    `json:"version"`
			}
			if json.Unmarshal(line, &head) != nil || head.EventID == "" {
				continue
			}
			if cur, ok := m[head.EventID]; !ok || head.Version > cur {
				m[head.EventID] = head.Version
			}
			w.Stats.Recovered.Add(1)
		}
		f.Close()
		w.idx[station] = m
	}
	return nil
}

// Run is the single goroutine that owns all WAL writes.
func (w *Writer) Run() {
	for it := range w.ch {
		batch := []item{it}
		timer := time.NewTimer(w.maxDelay)
	collect:
		for len(batch) < w.maxBatch {
			select {
			case next, ok := <-w.ch:
				if !ok {
					break collect
				}
				batch = append(batch, next)
			case <-timer.C:
				break collect
			}
		}
		timer.Stop()
		w.commit(batch)
	}
	// Channel closed: everything handed to us has been committed.
	for _, f := range w.files {
		f.Sync()
		f.Close()
	}
}

func (w *Writer) commit(batch []item) {
	results := make([]result, len(batch))
	// Pending versions are applied only after a successful fsync, so the index
	// never claims durability we don't have.
	pending := make(map[int]map[string]int)
	writes := make(map[int][]int)

	for i := range batch {
		it := &batch[i]
		effective := func() int {
			if p, ok := pending[it.station][it.eventID]; ok {
				return p
			}
			return w.idx[it.station][it.eventID]
		}
		known := w.idx[it.station] != nil
		_, inPending := pending[it.station][it.eventID]
		if (known || inPending) && it.version <= effective() {
			results[i] = result{duplicate: true}
			continue
		}
		if pending[it.station] == nil {
			pending[it.station] = make(map[string]int)
		}
		pending[it.station][it.eventID] = it.version
		writes[it.station] = append(writes[it.station], i)
	}

	for station, idxs := range writes {
		f, err := w.file(station)
		if err != nil {
			for _, i := range idxs {
				results[i] = result{err: err}
			}
			continue
		}
		var buf bytes.Buffer
		for _, i := range idxs {
			buf.Write(batch[i].line)
			buf.WriteByte('\n')
		}
		if _, err := f.Write(buf.Bytes()); err != nil {
			for _, i := range idxs {
				results[i] = result{err: err}
			}
			continue
		}
		// Point of no return: after this returns, the records are on stable
		// storage and only then do we acknowledge them.
		if w.doSync {
			if err := f.Sync(); err != nil {
				for _, i := range idxs {
					results[i] = result{err: err}
				}
				continue
			}
			w.Stats.Fsyncs.Add(1)
		}
		for _, i := range idxs {
			results[i] = result{}
		}
	}

	// Commit the dedupe index for everything that actually hit disk.
	for station, m := range pending {
		if w.idx[station] == nil {
			w.idx[station] = make(map[string]int)
		}
		for id, v := range m {
			if v > w.idx[station][id] {
				w.idx[station][id] = v
			}
		}
	}

	w.Stats.Batches.Add(1)
	for i := range batch {
		if results[i].duplicate {
			w.Stats.Duplicates.Add(1)
		} else if results[i].err == nil {
			w.Stats.Accepted.Add(1)
		}
		batch[i].done <- results[i]
	}
}

// Close stops accepting work and drains the commit loop. Safe to call twice
// (shutdown paths are easy to double up); the second call is a no-op.
func (w *Writer) Close() {
	w.closeOnce.Do(func() { close(w.ch) })
}
