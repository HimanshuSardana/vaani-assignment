import { promises as fs } from "fs";
import path from "path";
import { dataDir, listStations } from "@/lib/history";

export const dynamic = "force-dynamic";

// Offsets are per-connection: a new client tails from "now" and backfills via
// /api/history. Sharing offsets across clients meant the second client skipped
// records, and starting at 0 meant the first client received the whole archive
// as a flood of events.

export async function GET() {
  const dir = dataDir();
  const encoder = new TextEncoder();
  let poll: NodeJS.Timeout | undefined;
  let beat: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const offsets = new Map<string, number>();

      const pump = async () => {
        try {
          for (const id of await listStations()) {
            const p = path.join(dir, `wal-${id}.jsonl`);
            let fh;
            try {
              fh = await fs.open(p, "r");
            } catch {
              continue;
            }
            try {
              const st = await fh.stat();
              if (!offsets.has(p)) {
                offsets.set(p, st.size); // start at the end: only live data
                continue;
              }
              let off = offsets.get(p)!;
              if (st.size < off) off = 0; // truncated / rotated
              const len = st.size - off;
              if (len <= 0) continue;
              const buf = Buffer.alloc(len);
              await fh.read(buf, 0, len, off);
              const upto = buf.lastIndexOf(0x0a);
              if (upto < 0) continue; // only a partial line so far
              offsets.set(p, off + upto + 1);
              for (const line of buf
                .subarray(0, upto + 1)
                .toString("utf8")
                .split("\n")) {
                const t = line.trim();
                if (t.startsWith("{") && t.includes("event_id")) {
                  controller.enqueue(encoder.encode(`data: ${t}\n\n`));
                }
              }
            } finally {
              await fh.close();
            }
          }
        } catch {
          /* keep the stream alive on transient errors */
        }
      };
      await pump();
      poll = setInterval(pump, 500);
      beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* client gone; cancel() will clean up */
        }
      }, 15000);
    },
    cancel() {
      if (poll) clearInterval(poll);
      if (beat) clearInterval(beat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
