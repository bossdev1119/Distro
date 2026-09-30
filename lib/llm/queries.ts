import "server-only";
import { z } from "zod";
import { generateJson } from "./client";
import type { StartupProfile } from "./schemas";

export const searchPlanSchema = z.object({
  niches: z
    .array(
      z.object({
        name: z.string().min(1).describe("Short niche name, 2-5 words, e.g. 'Freelance invoicing'."),
        queries: z
          .array(z.string().min(2).max(120))
          .min(4)
          .max(6)
          .describe("4-6 YouTube searches a real viewer in this niche would type."),
      }),
    )
    .min(3)
    .max(5),
});

export type SearchPlan = z.infer<typeof searchPlanSchema>;

const SYSTEM = `You plan YouTube searches to find videos watched by a startup's potential customers.
Write queries the way real viewers type into YouTube search, not how marketers talk:
- pain points ("why do my clients pay late", "stop forgetting follow ups")
- "how to" tasks ("how to send invoices as a freelancer")
- tool comparisons and alternatives ("quickbooks vs wave for freelancers", "notion alternatives")
Never use the startup's own brand name or marketing slogans. Keep each query under 8 words.
Group queries into 3-5 distinct niches (different audiences or angles), 4-6 queries each.`;

/** Uses the fast model ("scoring" task): this is a small, cheap task. */
export async function generateSearchPlan(profile: StartupProfile): Promise<SearchPlan> {
  const user = `<profile>
One-liner: ${profile.one_liner}
Problem: ${profile.problem}
Ideal customer: ${profile.icp}
Use cases: ${profile.use_cases.join("; ")}
Keywords: ${profile.keywords.join(", ")}
Competitors: ${profile.competitors.join(", ") || "unknown"}
</profile>`;
  return generateJson({ task: "scoring", system: SYSTEM, user, schema: searchPlanSchema, maxTokens: 4000 });
}
