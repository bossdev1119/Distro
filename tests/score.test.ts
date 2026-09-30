import { describe, expect, it } from "vitest";
import { finalScore, rankScore } from "@/lib/analysis/score";

describe("rankScore", () => {
  it("is avg_relevance × log10(relevant_views + subscribers)", () => {
    // 0.8 × log10(90,000 + 10,000) = 0.8 × 5 = 4
    expect(rankScore({ avgRelevance: 0.8, relevantViews: 90_000, subscribers: 10_000 })).toBeCloseTo(4, 10);
  });

  it("grows slowly with size: 10× the reach adds only +1 before relevance", () => {
    const small = rankScore({ avgRelevance: 1, relevantViews: 0, subscribers: 10_000 });
    const big = rankScore({ avgRelevance: 1, relevantViews: 0, subscribers: 100_000 });
    expect(big - small).toBeCloseTo(1, 10);
  });

  it("lets a clearly more relevant small channel beat a vaguer channel 7× its size", () => {
    const smallRelevant = rankScore({ avgRelevance: 0.95, relevantViews: 20_000, subscribers: 8_000 });
    const bigVague = rankScore({ avgRelevance: 0.76, relevantViews: 50_000, subscribers: 150_000 });
    expect(smallRelevant).toBeGreaterThan(bigVague);
  });

  it("(known trade-off) at 0.90 vs 0.76 relevance, 7× the reach narrowly wins", () => {
    // 0.90 × log10(28k) ≈ 4.00 vs 0.76 × log10(200k) ≈ 4.03. Tune the formula if this matters.
    const smallRelevant = rankScore({ avgRelevance: 0.9, relevantViews: 20_000, subscribers: 8_000 });
    const bigVague = rankScore({ avgRelevance: 0.76, relevantViews: 50_000, subscribers: 150_000 });
    expect(bigVague).toBeGreaterThan(smallRelevant);
  });

  it("never returns -Infinity or NaN for zero reach", () => {
    expect(rankScore({ avgRelevance: 0.9, relevantViews: 0, subscribers: 0 })).toBe(0);
  });
});

describe("finalScore", () => {
  const weights = { rank: 0.5, fit: 0.5 };

  it("mixes normalized rank and fit", () => {
    // rank 2/4 = 0.5, fit 80/100 = 0.8 → 0.5×0.5 + 0.5×0.8 = 0.65
    expect(finalScore({ rankScore: 2, maxRankScore: 4, fit: 80, weights })).toBeCloseTo(0.65, 10);
  });

  it("gives 1 for the top-ranked creator with perfect fit", () => {
    expect(finalScore({ rankScore: 4, maxRankScore: 4, fit: 100, weights })).toBeCloseTo(1, 10);
  });

  it("handles a zero max rank and clamps fit to 0-100", () => {
    expect(finalScore({ rankScore: 0, maxRankScore: 0, fit: 150, weights })).toBeCloseTo(0.5, 10);
  });
});
