// Ranking formulas. Kept here, alone, so they're easy to find, test and tune.

export type RankInput = { avgRelevance: number; relevantViews: number; subscribers: number };

/**
 * rank_score = avg_relevance × log10(relevant_views + subscribers)
 * log10 squashes size: 10k → 4, 100k → 5, 1M → 6. So a channel 10× bigger only scores ~1.25×
 * higher, and relevance (0–1) matters as much as raw size. Good for finding SMALL creators.
 */
export function rankScore({ avgRelevance, relevantViews, subscribers }: RankInput): number {
  const reach = Math.max(1, relevantViews + subscribers); // log10(1) = 0; never log10(0) = -Infinity
  return avgRelevance * Math.log10(reach);
}

export type FinalScoreInput = {
  rankScore: number;
  /** Highest rank_score among this campaign's candidates, for normalizing to 0–1. */
  maxRankScore: number;
  /** LLM fit, 0–100. */
  fit: number;
  weights: { readonly rank: number; readonly fit: number };
};

/** final_score (0–1) = w_rank × (rank / max rank) + w_fit × (fit / 100). */
export function finalScore({ rankScore, maxRankScore, fit, weights }: FinalScoreInput): number {
  const rankNorm = maxRankScore > 0 ? rankScore / maxRankScore : 0;
  const fitNorm = Math.min(100, Math.max(0, fit)) / 100;
  return weights.rank * rankNorm + weights.fit * fitNorm;
}
