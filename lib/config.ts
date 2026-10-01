// Every tunable number for discovery lives here. Change a value, restart `npm run dev`, re-run.
// This file has no secrets and no server-only imports, so both server and UI can read it.

export const DISCOVERY = {
  /** How many creators a campaign ends up with (top N by final score). */
  campaignSize: 30,
  /** Creators sent to the LLM per fit-scoring call. */
  scoringBatchSize: 20,

  // ── Search ──────────────────────────────────────────────────────────────
  /** Only videos published within this many months. */
  searchLookbackMonths: 12,
  /** Results per search call (YouTube's maximum is 50). */
  searchResultsPerPage: 50,
  /** Result pages per query. Each extra page is another 100-unit search call. */
  searchPagesPerQuery: 1,
  /** A query already searched for this startup within this many days is not searched again. */
  queryCacheDays: 7,
  /** Stop calling YouTube once today's usage reaches this (the real daily limit is 10,000). */
  youtubeDailyUnitStop: 9_000,

  // ── Relevance ───────────────────────────────────────────────────────────
  /**
   * Minimum cosine similarity between a video and the startup context to count as relevant.
   * DEPENDS ON THE EMBEDDING MODEL — re-measure whenever EMBED_PROVIDER / the model changes.
   * - local bge-base-en-v1.5 (q8), measured on 825 real videos: ≥0.60 all on-topic, ~0.55 mixed,
   *   ≤0.50 junk (Roblox, news). Related pair 0.73, unrelated pair 0.29.
   * - gemini-embedding-001: related 0.84, unrelated 0.67; use ~0.80 there.
   */
  relevanceThreshold: 0.6,
  /** Characters of the video description included in its embedding. */
  descriptionCharsForEmbedding: 500,
  /**
   * Only used when EMBED_PROVIDER=gemini.
   * Gemini's free tier allows 1,000 embedded texts per day per project, and EVERY text counts
   * (a batch of 100 = 100). We stop a little early and resume after midnight Pacific time.
   * One search run of 20 queries finds ~700-900 videos, so budget roughly one startup per day
   * (or lower searchResultsPerPage to fit more).
   */
  geminiEmbedDailyStop: 950,
  /** Videos embedded per Inngest step (local: ~10 s per 100 on a laptop CPU). */
  embedBatchPerStep: 100,
  /** Must match the vector(768) columns in supabase/migrations/0002_youtube_discovery.sql. */
  embeddingDimensions: 768,

  // ── Creator filters ─────────────────────────────────────────────────────
  subscribers: { min: 5_000, max: 200_000 },
  /** Channel must have uploaded within this many days. */
  activeWithinDays: 60,
  /** Channel must have at least this many relevant videos. */
  minRelevantVideos: 1,
  /** Recent video titles per channel given to the LLM for fit scoring. */
  recentTitlesForScoring: 10,

  // ── Final score ─────────────────────────────────────────────────────────
  /** final = rank × normalized rank_score + fit × (fit / 100). Should add up to 1. */
  finalScoreWeights: { rank: 0.5, fit: 0.5 },

  // ── UI ──────────────────────────────────────────────────────────────────
  creatorsPerPage: 20,
  evidenceVideosPerNiche: 3,
} as const;
