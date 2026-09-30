import { NextResponse } from "next/server";
import { inngest, queriesConfirmed } from "@/inngest/client";
import { jsonError, parseBody } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { canStartSearch } from "@/lib/campaign-status";
import type { CampaignStage } from "@/lib/db/types";
import { startSearchSchema } from "@/lib/discovery/schemas";
import { createClient } from "@/lib/supabase/server";

/** "Start search": saves the reviewed queries and emits queries.confirmed. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseBody(request, startSearchSchema);
  if ("response" in body) return body.response;

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return jsonError("Unauthorized", 401);

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select("id, startup_id, stage, updated_at, resume_at")
    .eq("id", id)
    .maybeSingle<{ id: string; startup_id: string; stage: CampaignStage; updated_at: string; resume_at: string | null }>();
  if (error) return jsonError(error.message, 500);
  if (!campaign) return jsonError("Not found", 404);
  // From review, after done/failed, or when a run is stuck (see lib/campaign-status.ts).
  if (!canStartSearch(campaign)) return jsonError(`A search is already running (${campaign.stage})`, 409);

  // Replace unsearched queries with the reviewed list. Searched rows stay as the 7-day cache.
  const { error: delError } = await supabase
    .from("search_queries")
    .delete()
    .eq("startup_id", campaign.startup_id)
    .in("status", ["pending", "queued"]);
  if (delError) return jsonError(delError.message, 500);

  const rows = body.data.queries.map((q) => ({ startup_id: campaign.startup_id, niche: q.niche, query: q.query, status: "queued" }));
  const { error: insError } = await supabase.from("search_queries").insert(rows);
  if (insError) return jsonError(insError.message, 500);

  const { error: updError } = await supabase
    .from("campaigns")
    .update({ stage: "searching", stage_error: null, batches_done: 0, batches_total: 0 })
    .eq("id", id);
  if (updError) return jsonError(updError.message, 500);

  await writeAudit({
    startupId: campaign.startup_id,
    actorId: userId,
    action: "search.started",
    entityType: "campaign",
    entityId: id,
    details: { queries: rows.length },
  });
  await inngest.send(queriesConfirmed.create({ campaignId: id, startupId: campaign.startup_id }));
  return NextResponse.json({ ok: true, queries: rows.length });
}
