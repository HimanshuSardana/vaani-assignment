import { listStations } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await listStations());
}
