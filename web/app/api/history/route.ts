import { loadHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const station = parseInt(url.searchParams.get("station") ?? "", 10);
  if (!station) {
    return Response.json({ error: "need ?station=<id>" }, { status: 400 });
  }
  try {
    let hist = await loadHistory(station);
    const lim = parseInt(url.searchParams.get("limit") ?? "", 10);
    if (lim > 0 && hist.length > lim) hist = hist.slice(hist.length - lim);
    return Response.json(hist);
  } catch {
    return Response.json({ error: "no data for station" }, { status: 404 });
  }
}
