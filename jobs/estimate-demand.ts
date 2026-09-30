import { demandEstimated, inngest, relevanceScored } from "@/inngest/client";
import { estimateDemand, type DemandInput } from "@/lib/analysis/demand";
import { DISCOVERY } from "@/lib/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { markCampaignFailed, setStage } from "./helpers";

type ItemRow = { video_id: string; niche: string | null; views: number; comments: number | null; relevance: number };

/** Step 5: estimate the interested audience per niche from relevant videos. */
export const estimateDemandJob = inngest.createFunction(
  {
    id: "estimate-demand",
    triggers: [relevanceScored],
    retries: 3,
    concurrency: { key: "event.data.campaignId", limit: 1 },
    onFailure: markCampaignFailed,
  },
  async ({ event, step }) => {
    const { campaignId, startupId } = event.data;

    const niches = await step.run("estimate-demand", async () => {
      await setStage(campaignId, "estimating_demand");
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("content_items")
        .select("video_id, niche, views, comments, relevance")
        .eq("startup_id", startupId)
        .not("relevance", "is", null)
        .returns<ItemRow[]>();
      if (error) throw new Error(error.message);

      const items: DemandInput[] = data.map((r) => ({
        videoId: r.video_id,
        niche: r.niche,
        views: Number(r.views),
        comments: r.comments === null ? null : Number(r.comments),
        relevance: r.relevance,
      }));
      const demand = estimateDemand(items, DISCOVERY.relevanceThreshold, DISCOVERY.evidenceVideosPerNiche);

      // Replace this startup's estimates with the fresh ones.
      const { error: delError } = await admin.from("demand_estimates").delete().eq("startup_id", startupId);
      if (delError) throw new Error(delError.message);
      if (demand.length > 0) {
        const { error: insError } = await admin.from("demand_estimates").insert(
          demand.map((d) => ({
            startup_id: startupId,
            niche: d.niche,
            interested_estimate: d.interestedEstimate,
            relevant_videos: d.relevantVideos,
            total_comments: d.totalComments,
            top_video_ids: d.topVideoIds,
          })),
        );
        if (insError) throw new Error(insError.message);
      }
      return demand.length;
    });

    await step.sendEvent("emit-demand-estimated", demandEstimated.create({ campaignId, startupId }));
    return { niches };
  },
);
