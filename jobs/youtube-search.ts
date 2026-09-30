import { inngest, queriesConfirmed, youtubeSearched } from "@/inngest/client";
import { chunk, unique } from "@/lib/array";
import { DISCOVERY } from "@/lib/config";
import { getVideoStats, searchVideos } from "@/lib/discovery/youtube";
import { createAdminClient } from "@/lib/supabase/admin";
import { daysAgo } from "@/lib/time";
import { markCampaignFailed, mergeCampaignStats, runQuotaStep, setStage } from "./helpers";

type QueuedQuery = { id: string; niche: string; query: string; query_norm: string };

/** Step 3: queries.confirmed → search YouTube for each query, then fetch video stats. */
export const youtubeSearchJob = inngest.createFunction(
  {
    id: "youtube-search",
    triggers: [queriesConfirmed],
    retries: 3,
    // One search run per campaign at a time; quota is shared, so also cap total concurrency.
    concurrency: [{ key: "event.data.campaignId", limit: 1 }, { limit: 2 }],
    onFailure: markCampaignFailed,
  },
  async ({ event, step }) => {
    const { campaignId, startupId } = event.data;

    const queries = await step.run("load-queued-queries", async () => {
      await setStage(campaignId, "searching", { batches_done: 0, batches_total: 0, stats: {} });
      const { data, error } = await createAdminClient()
        .from("search_queries")
        .select("id, niche, query, query_norm")
        .eq("startup_id", startupId)
        .eq("status", "queued")
        .order("created_at")
        .returns<QueuedQuery[]>();
      if (error) throw new Error(error.message);
      return data;
    });

    const publishedAfter = await step.run("compute-published-after", () => {
      const date = new Date();
      date.setMonth(date.getMonth() - DISCOVERY.searchLookbackMonths);
      return date.toISOString();
    });

    // One step per query: if query 7 fails, queries 1-6 are not searched (or paid for) again.
    let cachedCount = 0;
    for (const q of queries) {
      const result = await runQuotaStep(step, `search-${q.id}`, { campaignId, resumeStage: "searching" }, async () => {
        const admin = createAdminClient();

        // Cache: the same query for this startup within 7 days reuses the earlier results (0 units).
        const { data: previous, error: cacheError } = await admin
          .from("search_queries")
          .select("video_ids, searched_at")
          .eq("startup_id", startupId)
          .eq("query_norm", q.query_norm)
          .in("status", ["searched", "cached"])
          .gte("searched_at", daysAgo(DISCOVERY.queryCacheDays).toISOString())
          .neq("id", q.id)
          .order("searched_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ video_ids: string[]; searched_at: string }>();
        if (cacheError) throw new Error(cacheError.message);

        const cached = previous !== null;
        const videoIds = cached ? previous.video_ids : await searchVideos(q.query, new Date(publishedAfter));
        const { error } = await admin
          .from("search_queries")
          .update({
            status: cached ? "cached" : "searched",
            video_ids: videoIds,
            searched_at: cached ? previous.searched_at : new Date().toISOString(),
            error: null,
          })
          .eq("id", q.id);
        if (error) throw new Error(error.message);
        return { cached, found: videoIds.length };
      });
      if (result.cached) cachedCount++;
    }

    // Collect every video id found, remembering which niche found it first.
    const videoNiches = await step.run("collect-video-ids", async () => {
      const { data, error } = await createAdminClient()
        .from("search_queries")
        .select("niche, video_ids")
        .in("id", queries.map((q) => q.id))
        .returns<{ niche: string; video_ids: string[] }[]>();
      if (error) throw new Error(error.message);
      const niches: Record<string, string> = {};
      for (const row of data) for (const id of row.video_ids) niches[id] ??= row.niche;
      return niches;
    });

    // Stats in groups of 200 ids per step (4 calls × 1 unit): small steps, cheap retries.
    const ids = unique(Object.keys(videoNiches));
    const groups = chunk(ids, 200);
    for (const [i, group] of groups.entries()) {
      await runQuotaStep(step, `video-stats-${i + 1}`, { campaignId, resumeStage: "searching" }, async () => {
        const videos = await getVideoStats(group);
        const rows = videos.map((v) => ({
          startup_id: startupId,
          platform: v.platform,
          video_id: v.externalId,
          url: v.url,
          title: v.title,
          description: v.description,
          channel_id: v.authorId,
          channel_title: v.authorName,
          thumbnail_url: v.thumbnailUrl,
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          published_at: v.publishedAt,
          niche: videoNiches[v.externalId] ?? null,
        }));
        // Upsert: insert new videos, update stats of ones we already have (unique startup+platform+video).
        const { error } = await createAdminClient()
          .from("content_items")
          .upsert(rows, { onConflict: "startup_id,platform,video_id" });
        if (error) throw new Error(error.message);
        return rows.length;
      });
    }

    await step.run("save-search-stats", () =>
      mergeCampaignStats(campaignId, { queries: queries.length, queries_cached: cachedCount, videos_found: ids.length }),
    );
    await step.sendEvent("emit-youtube-searched", youtubeSearched.create({ campaignId, startupId }));
    return { queries: queries.length, cached: cachedCount, videos: ids.length };
  },
);
