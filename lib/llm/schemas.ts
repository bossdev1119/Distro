import { z } from "zod";

// Shared between the server (LLM output validation, API input) and the profile editor form.

export const startupProfileSchema = z.object({
  one_liner: z.string().min(1).describe("One sentence: what the product does and for whom."),
  problem: z.string().min(1).describe("The core problem the product solves, 1-3 sentences."),
  icp: z.string().min(1).describe("Ideal customer profile: who buys/uses it, role, company type, context."),
  use_cases: z.array(z.string().min(1)).min(1).describe("Concrete use cases, 3-6 short phrases."),
  competitors: z.array(z.string().min(1)).describe("Named competitors or alternatives. Empty if unknown."),
  tone: z.string().min(1).describe("Brand voice for outreach, e.g. 'friendly, technical, no hype'."),
  keywords: z.array(z.string().min(1)).min(1).describe("5-15 search keywords creators in this niche would use."),
  creator_offer: z
    .string()
    .min(1)
    .describe("What we can offer a creator to feature the product (free plan, affiliate %, paid slot...)."),
});

export type StartupProfile = z.infer<typeof startupProfileSchema>;
