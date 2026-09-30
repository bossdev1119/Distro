import { creatorsBuilt, demandEstimated, inngest } from "@/inngest/client";
import { chunk } from "@/lib/array";
import { rankScore } from "@/lib/analysis/score";
import { DISCOVERY } from "@/lib/config";
import { extractBusinessEmail } from "@/lib/discovery/email-extract";
import { getChannelStats, getRecentUploads } from "@/lib/discovery/youtube";
import { createAdminClient } from "@/lib/supabase/admin";
import { daysAgo } from "@/lib/time";
import { markCampaignFailed, mergeCampaignStats, runQuotaStep, setStage } from "./helpers";

type ChannelMetrics = { channelId: string; relevantViews: number; avgRelevance: number; relevantVideos: number };

/** Step 6: group relevant videos by channel → creators (shared pool) → filtered, ranked matches. */
export const buildCreatorsJob = inngest.createFunction(
  {
    id: "build-creators",
    triggers: [demandEstimated],
    retries: 3,
    concurrency: { key: "event.data.campaignId", limit: 1 },
    onFailure: markCampaignFailed,
  },
  async ({ event, step }) => {
    const { campaignId, startupId } = event.data;

    const channels = await step.run("group-by-channel", async (): Promise<ChannelMetrics[]> => {
      await setStage(campaignId, "building_creators");
      const { data, error } = await createAdminClient()
        .from("content_items")
        .select("channel_id, views, relevance")
        .eq("startup_id", startupId)
        .gte("relevance", DISCOVERY.relevanceThreshold)
        .returns<{ channel_id: string; views: number; relevance: number }[]>();
      if (error) throw new Error(error.message);

      const byChannel = new Map<string, { views: number; relevanceSum: number; count: number }>();
      for (const v of data) {
        const c = byChannel.get(v.channel_id) ?? { views: 0, relevanceSum: 0, count: 0 };
        c.views += Number(v.views);
        c.relevanceSum += v.relevance;
        c.count += 1;
        byChannel.set(v.channel_id, c);
      }
      return [...byChannel.entries()].map(([channelId, c]) => ({
        channelId,
        relevantViews: c.views,
        avgRelevance: c.relevanceSum / c.count,
        relevantVideos: c.count,
      }));
    });

    // Channel stats, 50 per call (1 unit). Every channel goes into the shared creators pool.
    const subscribers: Record<string, number | null> = {};
    for (const [i, group] of chunk(channels.map((c) => c.channelId), 50).entries()) {
      const found = await runQuotaStep(step, `channel-stats-${i + 1}`, { campaignId, resumeStage: "building_creators" }, async () => {
        const profiles = await getChannelStats(group);
        const now = new Date().toISOString();
        const rows = profiles.map((p) => ({
          platform: p.platform,
          handle: p.externalId, // the stable channel id (see migration 0002)
          display_name: p.title,
          profile_url: p.url,
          bio: p.description,
          email: extractBusinessEmail(p.description),
          audience_size: p.subscribers,
          total_views: p.totalViews,
          country: p.country,
          thumbnail_url: p.thumbnailUrl,
          stats_updated_at: now,
        }));
        // Upsert on (platform, handle): a channel found by two startups is one creator row.
        const { error } = await createAdminClient().from("creators").upsert(rows, { onConflict: "platform,handle" });
        if (error) throw new Error(error.message);
        return profiles.map((p) => ({ id: p.externalId, subscribers: p.subscribers }));
      });
      for (const f of found) subscribers[f.id] = f.subscribers;
    }

    const { min, max } = DISCOVERY.subscribers;
    const inRange = channels.filter((c) => {
      const subs = subscribers[c.channelId];
      return subs !== null && subs !== undefined && subs >= min && subs <= max;
    });

    // Recent uploads only for in-range channels (1 unit each), 25 channels per step.
    const lastUpload: Record<string, string | null> = {};
    for (const [i, group] of chunk(inRange.map((c) => c.channelId), 25).entries()) {
      const activity = await runQuotaStep(step, `recent-uploads-${i + 1}`, { campaignId, resumeStage: "building_creators" }, async () => {
        const admin = createAdminClient();
        const results: { id: string; lastUploadAt: string | null }[] = [];
        for (const channelId of group) {
          const recent = await getRecentUploads(channelId);
          const { error } = await admin
            .from("creators")
            .update({ last_active_at: recent.lastUploadAt, metadata: { recent_titles: recent.recentTitles } })
            .eq("platform", "youtube")
            .eq("handle", channelId);
          if (error) throw new Error(error.message);
          results.push({ id: channelId, lastUploadAt: recent.lastUploadAt });
        }
        return results;
      });
      for (const a of activity) lastUpload[a.id] = a.lastUploadAt;
    }

    const summary = await step.run("save-matches", async () => {
      const admin = createAdminClient();
      const activeSince = daysAgo(DISCOVERY.activeWithinDays).toISOString();
      const candidates = inRange.filter((c) => {
        const last = lastUpload[c.channelId];
        return last !== null && last !== undefined && last >= activeSince && c.relevantVideos >= DISCOVERY.minRelevantVideos;
      });

      const { data: creators, error } = await admin
        .from("creators")
        .select("id, handle, email")
        .eq("platform", "youtube")
        .in("handle", candidates.length ? candidates.map((c) => c.channelId) : ["none"])
        .returns<{ id: string; handle: string; email: string | null }[]>();
      if (error) throw new Error(error.message);
      const creatorByChannel = new Map(creators.map((c) => [c.handle, c]));

      const rows = candidates.flatMap((c) => {
        const creator = creatorByChannel.get(c.channelId);
        if (!creator) return [];
        return [
          {
            campaign_id: campaignId,
            startup_id: startupId,
            creator_id: creator.id,
            rank_score: rankScore({
              avgRelevance: c.avgRelevance,
              relevantViews: c.relevantViews,
              subscribers: subscribers[c.channelId] ?? 0,
            }),
            relevant_views: c.relevantViews,
            avg_relevance: c.avgRelevance,
            relevant_video_count: c.relevantVideos,
          },
        ];
      });
      if (rows.length > 0) {
        // Upsert on (campaign_id, creator_id): re-running refreshes ranks, keeps fit scores.
        const { error: upsertError } = await admin.from("matches").upsert(rows, { onConflict: "campaign_id,creator_id" });
        if (upsertError) throw new Error(upsertError.message);
      }

      const withEmail = rows.filter((r) => creators.find((c) => c.id === r.creator_id)?.email).length;
      const batchesTotal = Math.ceil(Math.min(DISCOVERY.campaignSize, rows.length) / DISCOVERY.scoringBatchSize);
      await mergeCampaignStats(campaignId, {
        channels: channels.length,
        in_subscriber_range: inRange.length,
        active: candidates.length,
        candidates: rows.length,
        with_email: withEmail,
      });
      await admin.from("campaigns").update({ batches_total: batchesTotal, batches_done: 0 }).eq("id", campaignId);
      return { candidates: rows.length, withEmail, batchesTotal };
    });

    await step.sendEvent("emit-creators-built", creatorsBuilt.create({ campaignId, startupId }));
    return summary;
  },
);
