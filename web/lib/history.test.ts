// Read-path tests against the real module (no mocks, no copies of the logic).
//
//   node --experimental-strip-types --test lib/history.test.ts
//
// Each test writes a synthetic WAL into a temp DATA_DIR, so the assertions are
// about the same code the HTTP routes call.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
let m: typeof import("./history.ts");

const rfc = (t: number) => new Date(t).toISOString();

function writing(station: number, rows: Array<{ id: string; v: number }>, baseTs: number, stepMs = 1000) {
  const lines = rows.map((r, i) =>
    JSON.stringify({
      station_id: station,
      event_id: r.id,
      version: 1,
      ts: rfc(baseTs + i * stepMs),
      value: r.v,
    })
  );
  writeFileSync(path.join(dir, `wal-${station}.jsonl`), lines.join("\n") + "\n");
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "vaani-test-"));
  process.env.DATA_DIR = dir;
  m = await import("./history.ts");
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("canonical history", () => {
  it("dedupes on event_id keeping the highest version", async () => {
    writeFileSync(
      path.join(dir, "wal-9.jsonl"),
      [
        JSON.stringify({ station_id: 9, event_id: "a", version: 1, ts: "2026-01-01T00:00:00.000Z", value: 1 }),
        JSON.stringify({ station_id: 9, event_id: "a", version: 2, ts: "2026-01-01T00:00:00.000Z", value: 9 }),
        JSON.stringify({ station_id: 9, event_id: "b", version: 1, ts: "2026-01-01T00:00:02.000Z", value: 2 }),
      ].join("\n") + "\n"
    );
    const rows = await m.loadHistory(9);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.event_id === "a")!.value, 9);
  });

  it("orders by event time, not arrival order", async () => {
    writeFileSync(
      path.join(dir, "wal-8.jsonl"),
      [
        JSON.stringify({ station_id: 8, event_id: "late", version: 1, ts: "2026-01-01T00:00:00.000Z", value: 1 }),
        JSON.stringify({ station_id: 8, event_id: "early", version: 1, ts: "2026-01-01T00:00:05.000Z", value: 2 }),
      ].join("\n") + "\n"
    );
    const rows = await m.loadHistory(8);
    assert.deepEqual(rows.map((r) => r.event_id), ["late", "early"]);
  });

  it("survives torn and non-JSON lines", async () => {
    writeFileSync(
      path.join(dir, "wal-7.jsonl"),
      [
        '{"station_id":7,"event_id":"ok","version":1,"ts":"2026-01-01T00:00:00.000Z","value":5}',
        '{"station_id":7,"event_id":"torn","vers',
        "not json at all",
      ].join("\n") + "\n"
    );
    const rows = await m.loadHistory(7);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, "ok");
  });
});

describe("tail reads", () => {
  it("returns exactly the newest N, matching the full read", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, v: i }));
    writing(5, rows, base);

    const full = await m.loadHistory(5);
    for (const n of [1, 10, 250, 500]) {
      const tail = await m.loadTailHistory(5, n);
      assert.equal(tail.length, Math.min(n, full.length), `limit ${n}`);
      assert.deepEqual(
        tail.map((r) => r.event_id),
        full.slice(-n).map((r) => r.event_id),
        `limit ${n} must equal the tail of the full read`
      );
    }
  });

  it("reads a small tail from a file with long lines", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const pad = "x".repeat(2000);
    const lines = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ station_id: 6, event_id: `e${i}`, version: 1, ts: rfc(base + i * 1000), value: i, pad })
    );
    writeFileSync(path.join(dir, "wal-6.jsonl"), lines.join("\n") + "\n");
    const tail = await m.loadTailHistory(6, 3);
    assert.deepEqual(tail.map((r) => r.event_id), ["e197", "e198", "e199"]);
  });
});

describe("historyPayload", () => {
  it("returns a stable ETag and reflects the data", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    writing(4, [{ id: "a", v: 1 }], base);
    const p1 = await m.historyPayload(4, 100);
    const p2 = await m.historyPayload(4, 100);
    assert.ok(p1 && p2);
    assert.equal(p1!.etag, p2!.etag);
    assert.equal(p2!.cached, true, "second read should be a cache hit");
    assert.equal(JSON.parse(p1!.body).length, 1);
  });

  it("invalidates the cache when the WAL changes", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    writing(3, [{ id: "a", v: 1 }], base);
    const p1 = await m.historyPayload(3, 100);
    writeFileSync(
      path.join(dir, "wal-3.jsonl"),
      JSON.stringify({ station_id: 3, event_id: "a", version: 1, ts: rfc(base), value: 1 }) +
        "\n" +
        JSON.stringify({ station_id: 3, event_id: "b", version: 1, ts: rfc(base + 1000), value: 2 }) +
        "\n"
    );
    const p2 = await m.historyPayload(3, 100);
    assert.notEqual(p1!.etag, p2!.etag);
    assert.equal(JSON.parse(p2!.body).length, 2);
    assert.equal(p2!.cached, false);
  });

  it("projects away unused fields to keep payloads small", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    writeFileSync(
      path.join(dir, "wal-2.jsonl"),
      JSON.stringify({
        station_id: 2,
        event_id: "a",
        version: 1,
        ts: rfc(base),
        value: 1,
        emitted_at: rfc(base),
        archetype: "standard",
        seq: 42,
      }) + "\n"
    );
    const p = await m.historyPayload(2, 10);
    const row = JSON.parse(p!.body)[0];
    assert.equal(row.event_id, "a");
    assert.equal(row.value, 1);
    assert.equal(row.emitted_at, undefined);
    assert.equal(row.archetype, undefined);
  });
});

describe("similarity", () => {
  it("scores identical series at 1 and inverted series at -1", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const up = Array.from({ length: 60 }, (_, i) => ({ id: `u${i}`, v: Math.sin(i / 5) }));
    const down = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, v: -Math.sin(i / 5) }));
    // 30s spacing == one reading per bucket, which is what the metric compares.
    writing(11, up, base, 30_000);
    writing(12, up, base, 30_000);
    writing(13, down, base, 30_000);

    const same = await m.ewmaCorrelation(11, 12, 30, 0.99);
    const inv = await m.ewmaCorrelation(11, 13, 30, 0.99);
    assert.ok(same.score > 0.999, `identical should be ~1, got ${same.score}`);
    assert.ok(inv.score < -0.999, `inverted should be ~-1, got ${inv.score}`);
    assert.equal(same.samples, 60);
  });

  it("weights recent behaviour more heavily", async () => {
    // a: rises then falls. b: tracks a early, diverges late.
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const a = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, v: i < 20 ? i : 40 - i }));
    const b = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, v: i < 20 ? i : 20 + (i % 2) }));
    writing(21, a, base, 30_000);
    writing(22, b, base, 30_000);

    const slow = await m.ewmaCorrelation(21, 22, 30, 0.999); // long memory
    const fast = await m.ewmaCorrelation(21, 22, 30, 0.8); // short memory: last few buckets only
    assert.notEqual(slow.score.toFixed(4), fast.score.toFixed(4));
  });

  it("reports how much evidence a score rests on", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    writing(31, Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, v: i })), base, 30_000);
    writing(32, Array.from({ length: 4 }, (_, i) => ({ id: `y${i}`, v: i })), base, 30_000);
    const r = await m.ewmaCorrelation(31, 32, 30, 0.99);
    assert.equal(r.samples, 4, "only overlapping buckets count");
  });
});

describe("rollups", () => {
  it("reads buckets back in order, honouring the limit", async () => {
    const rows = [
      { bucket: 3600, n: 60, mean: 1.5, min: 1, max: 2 },
      { bucket: 7200, n: 60, mean: 2.5, min: 2, max: 3 },
      { bucket: 10800, n: 60, mean: 3.5, min: 3, max: 4 },
    ];
    writeFileSync(path.join(dir, "rollup-41-3600.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const all = await m.loadRollups(41, 3600, 0);
    assert.deepEqual(all.map((r) => r.bucket), [3600, 7200, 10800]);
    const last2 = await m.loadRollups(41, 3600, 2);
    assert.deepEqual(last2.map((r) => r.bucket), [7200, 10800]);
  });
});
