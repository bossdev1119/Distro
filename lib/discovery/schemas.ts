import { z } from "zod";

// Shared by the query review form (browser) and POST /api/campaigns/:id/start (server).

export const reviewedQuerySchema = z.object({
  niche: z.string().trim().min(1).max(80),
  query: z.string().trim().min(2).max(200),
});

export const startSearchSchema = z.object({
  queries: z.array(reviewedQuerySchema).min(1, "Add at least one query").max(40, "At most 40 queries (quota!)"),
});

export type ReviewedQuery = z.infer<typeof reviewedQuerySchema>;
