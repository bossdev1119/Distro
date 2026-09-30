import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DISCOVERY } from "@/lib/config";
import type { CampaignOverview, EvidenceVideo, NicheDemandCard, SearchQueryItem } from "@/lib/db/types";
import { QUOTA, quotaUsedToday } from "@/lib/quota";

type CampaignRow = CampaignOverview["campaign"] & {
  startup_id: string;
  startups: { id: string; name: string | null; url: string };
};

/**
 * Everything the creators page shows except the table. `supabase` is the signed-in user's
 * client, so RLS decides access: someone else's campaign simply returns null.
 */
export async function loadCampaignOverview(supabase: SupabaseClient, campaignId: string): Promise<CampaignOverview | null> {
  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select("id, name, stage, stage_error, resume_at, updated_at, budget_n, batches_done, batches_total, stats, startup_id, startups(id, name, url)")
    .eq("id", campaignId)
    .maybeSingle<CampaignRow>();
  if (error) throw new Error(error.message);
  if (!campaign) return null;
  const startupId = campaign.startup_id;

  const [context, queries, demand, usedToday, embedsToday] = await Promise.all([
    supabase
      .from("startup_context")
      .select("status, error")
      .eq("startup_id", startupId)
      .maybeSingle<CampaignOverview["context"]>(),
    supabase
      .from("search_queries")
      .select("id, niche, query, status, video_ids")
      .eq("startup_id", startupId)
      .order("created_at", { ascending: false })
      .limit(80)
      .returns<(Omit<SearchQueryItem, "found"> & { video_ids: string[] })[]>(),
    supabase
      .from("demand_estimates")
      .select("niche, interested_estimate, relevant_videos, total_comments, top_video_ids")
      .eq("startup_id", startupId)
      .order("interested_estimate", { ascending: false })
      .returns<(Omit<NicheDemandCard, "evidence"> & { top_video_ids: string[] })[]>(),
    quotaUsedToday(QUOTA.youtube),
    quotaUsedToday(QUOTA.geminiEmbed),
  ]);
  for (const r of [context, queries, demand]) if (r.error) throw new Error(r.error.message);

  // Evidence videos for all niches in one query.
  const evidenceIds = (demand.data ?? []).flatMap((d) => d.top_video_ids);
  const videos = new Map<string, EvidenceVideo>();
  if (evidenceIds.length > 0) {
    const { data, error: vError } = await supabase
      .from("content_items")
      .select("video_id, title, url, thumbnail_url, channel_title, views")
      .eq("startup_id", startupId)
      .in("video_id", evidenceIds)
      .returns<EvidenceVideo[]>();
    if (vError) throw new Error(vError.message);
    for (const v of data) videos.set(v.video_id, { ...v, views: Number(v.views) });
  }

  // Fetched newest first (so the limit keeps recent ones); shown oldest first.
  const queryItems = (queries.data ?? []).reverse().map(({ video_ids, ...q }) => ({ ...q, found: video_ids.length }));

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      stage: campaign.stage,
      stage_error: campaign.stage_error,
      resume_at: campaign.resume_at,
      updated_at: campaign.updated_at,
      budget_n: campaign.budget_n,
      batches_done: campaign.batches_done,
      batches_total: campaign.batches_total,
      stats: campaign.stats ?? {},
    },
    startup: campaign.startups,
    context: context.data ?? null,
    queries: queryItems,
    demand: (demand.data ?? []).map(({ top_video_ids, ...d }) => ({
      ...d,
      interested_estimate: Number(d.interested_estimate),
      total_comments: Number(d.total_comments),
      evidence: top_video_ids.map((id) => videos.get(id)).filter((v): v is EvidenceVideo => Boolean(v)),
    })),
    quota: {
      usedToday,
      stopAt: DISCOVERY.youtubeDailyUnitStop,
      embedsToday,
      embedStopAt: DISCOVERY.geminiEmbedDailyStop,
    },
  };
}
