import { contextBuilt, contextBuiltData, inngest } from "@/inngest/client";
import { generateSearchPlan } from "@/lib/llm/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadConfirmedProfile, runQuotaStep, toInngestError } from "./helpers";

/** Step 2: context.built → ask the LLM for viewer-style search queries, saved as "pending" for review. */
export const generateQueriesJob = inngest.createFunction(
  {
    id: "generate-queries",
    triggers: [contextBuilt],
    retries: 3,
    concurrency: { key: "event.data.startupId", limit: 1 },
    onFailure: async ({ event, error }) => {
      const { startupId } = contextBuiltData.parse(event.data.event.data);
      await createAdminClient()
        .from("startup_context")
        .update({ status: "failed", error: error.message.slice(0, 1000) })
        .eq("startup_id", startupId);
    },
  },
  async ({ event, step }) => {
    const { startupId } = event.data;

    const plan = await runQuotaStep(step, "generate-search-plan", null, async () => {
      try {
        return await generateSearchPlan(await loadConfirmedProfile(startupId));
      } catch (error) {
        throw toInngestError(error);
      }
    });

    const saved = await step.run("save-queries", async () => {
      const admin = createAdminClient();
      // Replace queries still waiting for review. Searched ones stay: they're the 7-day cache.
      const { error: delError } = await admin.from("search_queries").delete().eq("startup_id", startupId).eq("status", "pending");
      if (delError) throw new Error(delError.message);

      const rows = plan.niches.flatMap((n) => n.queries.map((query) => ({ startup_id: startupId, niche: n.name, query, status: "pending" })));
      const { error } = await admin.from("search_queries").insert(rows);
      if (error) throw new Error(error.message);

      const { error: ctxError } = await admin.from("startup_context").update({ status: "ready" }).eq("startup_id", startupId);
      if (ctxError) throw new Error(ctxError.message);
      return rows.length;
    });

    return { niches: plan.niches.length, queries: saved };
  },
);
