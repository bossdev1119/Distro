import "server-only";
import { z } from "zod";
import { generateJson } from "./client";
import type { StartupProfile } from "./schemas";

export type FitCandidate = {
  creatorId: string;
  title: string;
  description: string;
  recentTitles: string[];
};

export type FitResult = { creatorId: string; fit: number; reason: string };

const SYSTEM = `You judge how well YouTube creators fit as partners for promoting a startup.
Score each creator's fit from 0 to 100:
- 80-100: their audience clearly has the startup's problem and would plausibly buy
- 50-79: related audience, weaker or indirect fit
- 0-49: different audience, or content only shares keywords
Judge from their channel description and recent video titles, not their size.
Give one short, specific sentence of reasoning per creator.`;

/**
 * Scores up to ~20 creators in one call. Creators are labelled c1, c2... instead of UUIDs:
 * shorter for the model, and the schema only allows those exact labels, so it can't invent ids.
 */
export async function scoreCreatorFit(profile: StartupProfile, candidates: FitCandidate[]): Promise<FitResult[]> {
  if (candidates.length === 0) return [];
  const labels = candidates.map((_, i) => `c${i + 1}`);
  const schema = z.object({
    scores: z
      .array(
        z.object({
          creator: z.enum(labels as [string, ...string[]]),
          fit: z.number().int().min(0).max(100),
          reason: z.string().min(1).max(300),
        }),
      )
      .length(candidates.length),
  });

  const creators = candidates
    .map(
      (c, i) => `<creator id="${labels[i]}">
Channel: ${c.title}
Description: ${c.description.slice(0, 600) || "(none)"}
Recent videos: ${c.recentTitles.join(" | ") || "(unknown)"}
</creator>`,
    )
    .join("\n");

  const user = `<startup>
${profile.one_liner}
Problem: ${profile.problem}
Ideal customer: ${profile.icp}
</startup>

Score every creator below exactly once.
${creators}`;

  const result = await generateJson({ task: "scoring", system: SYSTEM, user, schema, maxTokens: 6000 });
  const byLabel = new Map(result.scores.map((s) => [s.creator, s]));
  if (byLabel.size !== candidates.length) throw new Error("Fit scoring returned the same creator twice");
  return candidates.map((c, i) => {
    const s = byLabel.get(labels[i])!;
    return { creatorId: c.creatorId, fit: s.fit, reason: s.reason };
  });
}
