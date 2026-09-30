import { NonRetriableError } from "inngest";
import { inngest, relevanceScored, youtubeSearched } from "@/inngest/client";
import { DISCOVERY } from "@/lib/config";
import { embedMany, toPgVector } from "@/lib/llm/client";
import { GEMINI_EMBED_BATCH } from "@/lib/llm/providers/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import { markCampaignFailed, mergeCampaignStats, runQuotaStep, setStage, toInngestError } from "./helpers";

const MAX_EMBED_BATCHES = 60; // safety stop: 60 × 100 = 6,000 videos per run

/** Step 4: embed each new video's title + description, then relevance = cosine similarity in SQL. */
export const scoreRelevanceJob = inngest.createFunction(
  {
    id: "score-relevance",
    triggers: [youtubeSearched],
    retries: 3,
    concurrency: { key: "event.data.campaignId", limit: 1 },
    onFailure: markCampaignFailed,
  },
  async ({ event, step }) => {
    const { campaignId, startupId } = event.data;
    await step.run("set-stage", () => setStage(campaignId, "scoring_relevance"));

    // Only videos without an embedding yet: already-embedded ones are never paid for twice.
    let embedded = 0;
    for (let batch = 1; batch <= MAX_EMBED_BATCHES; batch++) {
      const count = await runQuotaStep(step, `embed-batch-${batch}`, { campaignId, resumeStage: "scoring_relevance" }, async () => {
        const admin = createAdminClient();
        const { data, error } = await admin
          .from("content_items")
          .select("id, title, description")
          .eq("startup_id", startupId)
          .is("embedding", null)
          .limit(GEMINI_EMBED_BATCH)
          .returns<{ id: string; title: string; description: string }[]>();
        if (error) throw new Error(error.message);
        if (data.length === 0) return 0;

        const texts = data.map((v) => `${v.title}\n${v.description.slice(0, DISCOVERY.descriptionCharsForEmbedding)}`);
        let vectors: number[][];
        try {
          vectors = await embedMany(texts);
        } catch (err) {
          throw toInngestError(err);
        }
        const { error: saveError } = await admin.rpc("set_content_embeddings", {
          p_ids: data.map((v) => v.id),
          p_embeddings: vectors.map(toPgVector),
        });
        if (saveError) throw new Error(saveError.message);
        return data.length;
      });
      embedded += count;
      if (count === 0) break;
    }

    const scored = await step.run("score-relevance", async () => {
      const admin = createAdminClient();
      const { data: context, error: ctxError } = await admin
        .from("startup_context")
        .select("status")
        .eq("startup_id", startupId)
        .maybeSingle<{ status: string }>();
      if (ctxError) throw new Error(ctxError.message);
      if (!context) throw new NonRetriableError("No startup context yet: confirm the profile first");

      // The actual math runs in Postgres: relevance = 1 - (video.embedding <=> context.embedding).
      const { data, error } = await admin.rpc("score_content_relevance", { p_startup_id: startupId });
      if (error) throw new Error(error.message);

      const { count, error: countError } = await admin
        .from("content_items")
        .select("id", { count: "exact", head: true })
        .eq("startup_id", startupId)
        .gte("relevance", DISCOVERY.relevanceThreshold);
      if (countError) throw new Error(countError.message);

      await mergeCampaignStats(campaignId, { videos_scored: Number(data), relevant_videos: count ?? 0 });
      return { scored: Number(data), relevant: count ?? 0 };
    });

    await step.sendEvent("emit-relevance-scored", relevanceScored.create({ campaignId, startupId }));
    return { embedded, ...scored };
  },
);
