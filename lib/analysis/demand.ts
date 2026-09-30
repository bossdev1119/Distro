// Estimates how many people are interested in each niche, from relevant YouTube videos.
// Pure functions: no database, no network.

export type DemandInput = {
  videoId: string;
  niche: string | null;
  views: number;
  comments: number | null;
  relevance: number;
};

export type NicheDemand = {
  niche: string;
  interestedEstimate: number;
  relevantVideos: number;
  totalComments: number;
  topVideoIds: string[];
};

/**
 * Per niche: interested_estimate = Σ (views × relevance) over relevant videos.
 * Weighting by relevance means a view on a loosely related video counts less.
 * It is an ESTIMATE: one person can watch many of these videos, views include bots and
 * rewatches, and a viewer isn't a buyer. The UI must say so and show the evidence.
 */
export function estimateDemand(items: DemandInput[], threshold: number, topN = 3): NicheDemand[] {
  const byNiche = new Map<string, DemandInput[]>();
  for (const item of items) {
    if (item.relevance < threshold) continue;
    const niche = item.niche ?? "Other";
    byNiche.set(niche, [...(byNiche.get(niche) ?? []), item]);
  }

  return [...byNiche.entries()]
    .map(([niche, videos]) => {
      const weighted = videos.map((v) => ({ id: v.videoId, weight: v.views * v.relevance }));
      return {
        niche,
        interestedEstimate: Math.round(weighted.reduce((sum, v) => sum + v.weight, 0)),
        relevantVideos: videos.length,
        totalComments: videos.reduce((sum, v) => sum + (v.comments ?? 0), 0),
        topVideoIds: weighted
          .sort((a, b) => b.weight - a.weight)
          .slice(0, topN)
          .map((v) => v.id),
      };
    })
    .sort((a, b) => b.interestedEstimate - a.interestedEstimate);
}
