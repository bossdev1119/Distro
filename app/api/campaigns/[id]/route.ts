import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { loadCampaignOverview } from "@/lib/campaigns";
import { createClient } from "@/lib/supabase/server";

/** Polled by the creators page while jobs run. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  try {
    const overview = await loadCampaignOverview(supabase, id);
    if (!overview) return jsonError("Not found", 404);
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load campaign", 500);
  }
}
