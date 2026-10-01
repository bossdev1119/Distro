import { NonRetriableError } from "inngest";
import { inngest, relevanceScored, youtubeSearched } from "@/inngest/client";
import { DISCOVERY } from "@/lib/config";
import { embed, embeddingModelId, embedMany, toPgVector } from "@/lib/llm/client";
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

    // The model in use right now. Saved in a step so every replay uses the same value.
    const model = await step.run("embedding-model", () => embeddingModelId());

    // The startup context must be embedded by the SAME model as the videos (different models =
    // different "maps"). If the model changed since the profile was confirmed, re-embed it.
    await runQuotaStep(step, "ensure-context-embedding", { campaignId, resumeStage: "scoring_relevance" }, async () => {
      const admin = createAdminClient();
      const { data: context, error } = await admin
        .from("startup_context")
        .select("context_text, embedding_model")
        .eq("startup_id", startupId)
        .maybeSingle<{ context_text: string; embedding_model: string | null }>();
      if (error) throw new Error(error.message);
      if (!context) throw new NonRetriableError("No startup context yet: confirm the profile first");
      if (context.embedding_model === model) return { reembedded: false };
      try {
        const vector = await embed(context.context_text);
        const { error: saveError } = await admin
          .from("startup_context")
          .update({ embedding: toPgVector(vector), embedding_model: model })
          .eq("startup_id", startupId);
        if (saveError) throw new Error(saveError.message);
        return { reembedded: true };
      } catch (err) {
        throw toInngestError(err);
      }
    });

    // Videos with no embedding, or one made by a different model. Never embedded twice per model.
    let embedded = 0;
    for (let batch = 1; batch <= MAX_EMBED_BATCHES; batch++) {
      const count = await runQuotaStep(step, `embed-batch-${batch}`, { campaignId, resumeStage: "scoring_relevance" }, async () => {
        const admin = createAdminClient();
        const { data, error } = await admin
          .from("content_items")
          .select("id, title, description")
          .eq("startup_id", startupId)
          // embedding_model is null (never embedded) OR not the current model. Quoted: the id contains "/" and "@".
          .or(`embedding_model.is.null,embedding_model.neq."${model}"`)
          .limit(DISCOVERY.embedBatchPerStep)
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
          p_model: model,
        });
        if (saveError) throw new Error(saveError.message);
        return data.length;
      });
      embedded += count;
      if (count === 0) break;
    }

    const scored = await step.run("score-relevance", async () => {
      const admin = createAdminClient();
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
