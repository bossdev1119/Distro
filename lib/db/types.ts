import type { StartupProfile } from "@/lib/llm/schemas";

export type ProfileStatus = "pending" | "building" | "ready" | "failed" | "confirmed";

export type StartupRow = {
  id: string;
  owner_id: string;
  url: string;
  name: string | null;
  notes: string | null;
  profile_json: StartupProfile | null;
  profile_status: ProfileStatus;
  profile_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Shape returned by GET /api/startups/:id, used by the profile editor to poll. */
export type StartupStatusResponse = Pick<
  StartupRow,
  "id" | "url" | "name" | "profile_json" | "profile_status" | "profile_error"
>;

// ── Milestone 2 ──────────────────────────────────────────────────────────────

export type CampaignStage =
  | "awaiting_queries"
  | "searching"
  | "paused_quota"
  | "scoring_relevance"
  | "estimating_demand"
  | "building_creators"
  | "scoring_creators"
  | "done"
  | "failed";

export type ContextStatus = "embedding" | "generating_queries" | "ready" | "failed";
export type QueryStatus = "pending" | "queued" | "searched" | "cached" | "failed";

export type CampaignStats = Partial<
  Record<
    | "queries"
    | "queries_cached"
    | "videos_found"
    | "videos_scored"
    | "relevant_videos"
    | "channels"
    | "in_subscriber_range"
    | "active"
    | "candidates"
    | "with_email",
    number
  >
>;

export type SearchQueryItem = { id: string; niche: string; query: string; status: QueryStatus; found: number };

export type EvidenceVideo = {
  video_id: string;
  title: string;
  url: string;
  thumbnail_url: string | null;
  channel_title: string | null;
  views: number;
};

export type NicheDemandCard = {
  niche: string;
  interested_estimate: number;
  relevant_videos: number;
  total_comments: number;
  evidence: EvidenceVideo[];
};

/** GET /api/campaigns/:id — everything the creators page shows except the table. */
export type CampaignOverview = {
  campaign: {
    id: string;
    name: string;
    stage: CampaignStage;
    stage_error: string | null;
    resume_at: string | null;
    updated_at: string;
    budget_n: number;
    batches_done: number;
    batches_total: number;
    stats: CampaignStats;
  };
  startup: { id: string; name: string | null; url: string };
  context: { status: ContextStatus; error: string | null } | null;
  queries: SearchQueryItem[];
  demand: NicheDemandCard[];
  quota: { usedToday: number; stopAt: number; embedsToday: number; embedStopAt: number };
};

/** One row of the creators table (from the campaign_creators view). */
export type CreatorTableRow = {
  match_id: string;
  final_rank: number;
  final_score: number | null;
  fit_score: number | null;
  fit_reason: string | null;
  rank_score: number | null;
  relevant_views: number;
  relevant_video_count: number;
  channel_id: string;
  display_name: string | null;
  profile_url: string | null;
  thumbnail_url: string | null;
  subscribers: number | null;
  has_email: boolean;
};

export const CREATOR_SORT_COLUMNS = [
  "final_rank",
  "subscribers",
  "relevant_video_count",
  "relevant_views",
  "fit_score",
  "display_name",
] as const;
export type CreatorSortColumn = (typeof CREATOR_SORT_COLUMNS)[number];

/** GET /api/campaigns/:id/creators */
export type CreatorsPage = { rows: CreatorTableRow[]; total: number; page: number; pageSize: number };
