import type { CampaignStage } from "@/lib/db/types";

// Shared by the start API (server) and the creators page (browser), so both agree.

const RUNNING: CampaignStage[] = ["searching", "scoring_relevance", "estimating_demand", "building_creators", "scoring_creators"];
const STUCK_AFTER_MS = 30 * 60_000;

type StatusFields = { stage: CampaignStage; updated_at: string; resume_at: string | null };

/**
 * True when a run should have moved on but didn't — e.g. the Inngest dev server was stopped
 * mid-run (its runs live in memory), or a job crashed without reaching its failure handler.
 * - running stage: no progress for 30 minutes
 * - paused for quota: 30 minutes past the planned resume time
 */
export function isStuck(c: StatusFields, now: Date = new Date()): boolean {
  if (RUNNING.includes(c.stage)) return now.getTime() - new Date(c.updated_at).getTime() > STUCK_AFTER_MS;
  if (c.stage === "paused_quota" && c.resume_at) return now.getTime() - new Date(c.resume_at).getTime() > STUCK_AFTER_MS;
  return false;
}

/** Whether "Start search" / "Search again" is allowed right now. */
export function canStartSearch(c: StatusFields, now: Date = new Date()): boolean {
  return c.stage === "awaiting_queries" || c.stage === "done" || c.stage === "failed" || isStuck(c, now);
}
