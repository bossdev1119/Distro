import { eventType, Inngest } from "inngest";
import { z } from "zod";

export const inngest = new Inngest({ id: "distro" });

// ── Milestone 1 ──────────────────────────────────────────────────────────────
export const startupCreatedData = z.object({ startupId: z.uuid() });
export const startupCreated = eventType("startup.created", { schema: startupCreatedData });

export const profileConfirmedData = z.object({ startupId: z.uuid(), userId: z.uuid() });
export const profileConfirmed = eventType("profile.confirmed", { schema: profileConfirmedData });

// ── Milestone 2: YouTube discovery chain ─────────────────────────────────────
// profile.confirmed → build-context → context.built → generate-queries
// (founder reviews queries) → queries.confirmed → youtube-search → youtube.searched
// → score-relevance → relevance.scored → estimate-demand → demand.estimated
// → build-creators → creators.built → score-creators

export const contextBuiltData = z.object({ startupId: z.uuid() });
export const contextBuilt = eventType("context.built", { schema: contextBuiltData });

export const campaignStepData = z.object({ campaignId: z.uuid(), startupId: z.uuid() });
export const queriesConfirmed = eventType("queries.confirmed", { schema: campaignStepData });
export const youtubeSearched = eventType("youtube.searched", { schema: campaignStepData });
export const relevanceScored = eventType("relevance.scored", { schema: campaignStepData });
export const demandEstimated = eventType("demand.estimated", { schema: campaignStepData });
export const creatorsBuilt = eventType("creators.built", { schema: campaignStepData });
