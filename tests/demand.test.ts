import { describe, expect, it } from "vitest";
import { estimateDemand, type DemandInput } from "@/lib/analysis/demand";

const video = (videoId: string, niche: string | null, views: number, relevance: number, comments: number | null = 0): DemandInput => ({
  videoId,
  niche,
  views,
  relevance,
  comments,
});

describe("estimateDemand", () => {
  it("sums views × relevance per niche, ignoring videos under the threshold", () => {
    const result = estimateDemand(
      [
        video("a", "Invoicing", 1000, 0.8, 10),
        video("b", "Invoicing", 500, 0.9, 5),
        video("c", "Invoicing", 99_999, 0.5), // below threshold: not counted
      ],
      0.75,
    );
    expect(result).toEqual([{ niche: "Invoicing", interestedEstimate: 1250, relevantVideos: 2, totalComments: 15, topVideoIds: ["a", "b"] }]);
  });

  it("sorts niches by estimate and keeps the top evidence videos", () => {
    const result = estimateDemand(
      [video("x", "Small", 100, 0.8), video("y", "Big", 10_000, 0.8), video("z", "Big", 20_000, 0.8), video("w", "Big", 5, 0.8)],
      0.75,
      2,
    );
    expect(result.map((r) => r.niche)).toEqual(["Big", "Small"]);
    expect(result[0].topVideoIds).toEqual(["z", "y"]);
  });

  it("groups videos without a niche under Other and treats missing comments as 0", () => {
    const [other] = estimateDemand([video("n", null, 10, 1, null)], 0.75);
    expect(other).toMatchObject({ niche: "Other", totalComments: 0 });
  });
});
