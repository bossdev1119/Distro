import type { CampaignStage } from "@/lib/db/types";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** 1234567 → "1.2M". */
export function formatCompact(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : compact.format(n);
}

export const STAGE_LABEL: Record<CampaignStage, string> = {
  awaiting_queries: "Review search queries",
  searching: "Searching YouTube…",
  paused_quota: "Paused: daily free quota reached",
  scoring_relevance: "Scoring video relevance…",
  estimating_demand: "Estimating audience…",
  building_creators: "Finding creators…",
  scoring_creators: "AI fit scoring…",
  done: "Done",
  failed: "Failed",
};

/** Stages where background jobs are working, so the page should keep polling. */
export const RUNNING_STAGES: CampaignStage[] = [
  "searching",
  "scoring_relevance",
  "estimating_demand",
  "building_creators",
  "scoring_creators",
];

/** Rough position in the pipeline, for the progress bar (0–1). */
export function pipelineProgress(stage: CampaignStage, batchesDone: number, batchesTotal: number): number {
  const order: CampaignStage[] = ["searching", "scoring_relevance", "estimating_demand", "building_creators", "scoring_creators", "done"];
  if (stage === "done") return 1;
  if (stage === "scoring_creators" && batchesTotal > 0) return 0.8 + 0.2 * (batchesDone / batchesTotal);
  const i = order.indexOf(stage === "paused_quota" ? "searching" : stage);
  return i < 0 ? 0 : i / order.length;
}
