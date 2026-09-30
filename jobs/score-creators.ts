import { creatorsBuilt, inngest } from "@/inngest/client";
import { finalScore } from "@/lib/analysis/score";
import { DISCOVERY } from "@/lib/config";
import { scoreCreatorFit } from "@/lib/llm/fit";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadConfirmedProfile, markCampaignFailed, runQuotaStep, setStage, toInngestError, updateCampaign } from "./helpers";

type CandidateRow = {
  id: string;
  rank_score: number;
  creators: { id: string; display_name: string | null; bio: string | null; metadata: { recent_titles?: string[] } | null };
};

const MAX_BATCHES = 25; // safety stop

/**
 * Step 7: LLM fit scoring in batches of 20, until the campaign has `budget_n` scored creators.
 * Each batch is its own step and saves its results immediately:
 * - a failure in batch 2 never redoes batch 1 (the step's result is memoized by Inngest)
 * - each batch picks "unscored" matches from the DB, so even a brand-new run resumes correctly
 *   (idempotent: running it twice gives the same end state as running it once)
 */
export const scoreCreatorsJob = inngest.createFunction(
  {
    id: "score-creators",
    triggers: [creatorsBuilt],
    retries: 4,
    concurrency: { key: "event.data.campaignId", limit: 1 },
    onFailure: markCampaignFailed,
  },
  async ({ event, step }) => {
    const { campaignId, startupId } = event.data;

    const setup = await step.run("prepare", async () => {
      const admin = createAdminClient();
      const { data: campaign, error } = await admin.from("campaigns").select("budget_n").eq("id", campaignId).single<{ budget_n: number }>();
      if (error) throw new Error(error.message);
      const { data: top, error: topError } = await admin
        .from("matches")
        .select("rank_score")
        .eq("campaign_id", campaignId)
        .is("removed_at", null)
        .not("rank_score", "is", null)
        .order("rank_score", { ascending: false })
        .limit(1)
        .maybeSingle<{ rank_score: number }>();
      if (topError) throw new Error(topError.message);
      await setStage(campaignId, "scoring_creators");
      return { budget: campaign.budget_n, maxRank: top?.rank_score ?? 0 };
    });

    const profile = await step.run("load-profile", () => loadConfirmedProfile(startupId));

    let batchesDone = 0;
    for (let batch = 1; batch <= MAX_BATCHES; batch++) {
      const result = await runQuotaStep(step, `score-batch-${batch}`, { campaignId, resumeStage: "scoring_creators" }, async () => {
        const admin = createAdminClient();
        const { count: scored, error: countError } = await admin
          .from("matches")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaignId)
          .is("removed_at", null)
          .not("fit_score", "is", null);
        if (countError) throw new Error(countError.message);

        const need = Math.min(DISCOVERY.scoringBatchSize, setup.budget - (scored ?? 0));
        if (need <= 0) return { scored: 0, done: true };

        const { data: candidates, error } = await admin
          .from("matches")
          .select("id, rank_score, creators(id, display_name, bio, metadata)")
          .eq("campaign_id", campaignId)
          .is("removed_at", null)
          .is("fit_score", null)
          .order("rank_score", { ascending: false })
          .limit(need)
          .returns<CandidateRow[]>();
        if (error) throw new Error(error.message);
        if (candidates.length === 0) return { scored: 0, done: true };

        let fits;
        try {
          fits = await scoreCreatorFit(
            profile,
            candidates.map((c) => ({
              creatorId: c.creators.id,
              title: c.creators.display_name ?? "",
              description: c.creators.bio ?? "",
              recentTitles: c.creators.metadata?.recent_titles ?? [],
            })),
          );
        } catch (err) {
          throw toInngestError(err); // 429 → wait and retry this batch only
        }

        const now = new Date().toISOString();
        for (const c of candidates) {
          const fit = fits.find((f) => f.creatorId === c.creators.id);
          if (!fit) continue;
          const { error: saveError } = await admin
            .from("matches")
            .update({
              fit_score: fit.fit,
              fit_reason: fit.reason,
              final_score: finalScore({ rankScore: c.rank_score, maxRankScore: setup.maxRank, fit: fit.fit, weights: DISCOVERY.finalScoreWeights }),
              scored_at: now,
            })
            .eq("id", c.id);
          if (saveError) throw new Error(saveError.message);
        }
        await updateCampaign(campaignId, { batches_done: batch });
        return { scored: candidates.length, done: candidates.length < need };
      });
      if (result.scored > 0) batchesDone = batch;
      if (result.done) break;
    }

    await step.run("finish", () => setStage(campaignId, "done"));
    return { batchesDone };
  },
);
