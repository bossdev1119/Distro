import { NonRetriableError, RetryAfterError, type GetStepTools } from "inngest";
import { campaignStepData, inngest } from "@/inngest/client";
import type { CampaignStage } from "@/lib/db/types";
import { DiscoveryConfigError } from "@/lib/discovery/types";
import { LlmOutputError, LlmRateLimitError } from "@/lib/llm/client";
import { QuotaExhaustedError } from "@/lib/quota";
import { startupProfileSchema, type StartupProfile } from "@/lib/llm/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { nextPacificMidnight } from "@/lib/time";

export type Step = GetStepTools<typeof inngest>;

export async function updateCampaign(campaignId: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await createAdminClient().from("campaigns").update(fields).eq("id", campaignId);
  if (error) throw new Error(`Failed to update campaign ${campaignId}: ${error.message}`);
}

export function setStage(campaignId: string, stage: CampaignStage, extra: Record<string, unknown> = {}): Promise<void> {
  return updateCampaign(campaignId, { stage, stage_error: null, resume_at: null, ...extra });
}

/** Shared onFailure for campaign jobs: after all retries, show the error on the page. */
export async function markCampaignFailed({ event, error }: { event: { data: { event: { data: unknown } } }; error: Error }) {
  const { campaignId } = campaignStepData.parse(event.data.event.data);
  await updateCampaign(campaignId, { stage: "failed", stage_error: error.message.slice(0, 1000) });
}

export async function loadConfirmedProfile(startupId: string): Promise<StartupProfile> {
  const { data, error } = await createAdminClient()
    .from("startups")
    .select("profile_json, profile_status")
    .eq("id", startupId)
    .maybeSingle<{ profile_json: unknown; profile_status: string }>();
  if (error) throw new Error(error.message);
  if (!data) throw new NonRetriableError(`Startup ${startupId} not found`);
  const parsed = startupProfileSchema.safeParse(data.profile_json);
  if (!parsed.success) throw new NonRetriableError(`Startup ${startupId} has no valid profile`);
  return parsed.data;
}

/**
 * Converts errors thrown inside a step into what Inngest should do with them:
 * - LLM rate limit (429) → RetryAfterError: wait, then retry this step only
 * - bad LLM output / bad config → NonRetriableError: retrying the same thing won't help
 * - everything else → rethrow: normal retries with backoff
 */
export function toInngestError(error: unknown): unknown {
  if (error instanceof LlmRateLimitError) return new RetryAfterError(error.message, error.retryAfterMs, { cause: error });
  if (error instanceof LlmOutputError || error instanceof DiscoveryConfigError) {
    return new NonRetriableError(error.message, { cause: error });
  }
  return error;
}

type QuotaAttempt<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Which campaign to show as paused, and which stage to show again after waking up. */
export type PauseTarget = { campaignId: string; resumeStage: CampaignStage } | null;

/**
 * Runs a step that spends a daily free-tier quota (YouTube units, Gemini embeddings/requests).
 * If a daily budget is used up, the campaign (if any) shows "paused_quota", the function
 * SLEEPS until midnight Pacific time (Inngest keeps it paused for free), then retries the same
 * work under a new step id. Finished steps are never repeated.
 */
export async function runQuotaStep<T>(step: Step, id: string, target: PauseTarget, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const stepId = attempt === 0 ? id : `${id}-retry-${attempt}`;
    const result = (await step.run(stepId, async (): Promise<QuotaAttempt<T>> => {
      try {
        return { ok: true, value: await work() };
      } catch (error) {
        if (error instanceof QuotaExhaustedError) return { ok: false, reason: error.message };
        throw toInngestError(error);
      }
    })) as QuotaAttempt<T>;
    if (result.ok) return result.value;

    // Compute "tomorrow" inside a step: its result is saved, so replays use the same time.
    const resumeAt = await step.run(`${stepId}-pause`, async () => {
      const at = new Date(nextPacificMidnight().getTime() + 5 * 60_000).toISOString();
      if (target) await updateCampaign(target.campaignId, { stage: "paused_quota", stage_error: result.reason, resume_at: at });
      return at;
    });
    await step.sleepUntil(`${stepId}-wait`, resumeAt);
    if (target) await step.run(`${stepId}-resume`, () => setStage(target.campaignId, target.resumeStage));
  }
}

/** Merges numbers into campaigns.stats (the funnel shown on the page). */
export async function mergeCampaignStats(campaignId: string, stats: Record<string, number>): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("campaigns").select("stats").eq("id", campaignId).single<{ stats: Record<string, number> }>();
  if (error) throw new Error(error.message);
  await updateCampaign(campaignId, { stats: { ...data.stats, ...stats } });
}
