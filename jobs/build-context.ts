import { contextBuilt, inngest, profileConfirmed, profileConfirmedData } from "@/inngest/client";
import { buildContextText } from "@/lib/analysis/context";
import { embed, toPgVector } from "@/lib/llm/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadConfirmedProfile, runQuotaStep, toInngestError } from "./helpers";

/** Step 1: profile.confirmed → embed "what this startup is about" into startup_context. */
export const buildContextJob = inngest.createFunction(
  {
    id: "build-context",
    triggers: [profileConfirmed],
    retries: 3,
    concurrency: { key: "event.data.startupId", limit: 1 },
    onFailure: async ({ event, error }) => {
      const { startupId } = profileConfirmedData.parse(event.data.event.data);
      await createAdminClient()
        .from("startup_context")
        .update({ status: "failed", error: error.message.slice(0, 1000) })
        .eq("startup_id", startupId);
    },
  },
  async ({ event, step }) => {
    const { startupId } = event.data;

    const contextText = await step.run("build-context-text", async () => {
      const text = buildContextText(await loadConfirmedProfile(startupId));
      // Upsert: one row per startup. Re-confirming the profile replaces it.
      const { error } = await createAdminClient()
        .from("startup_context")
        .upsert({ startup_id: startupId, context_text: text, status: "embedding", error: null }, { onConflict: "startup_id" });
      if (error) throw new Error(error.message);
      return text;
    });

    await runQuotaStep(step, "embed-context", null, async () => {
      try {
        const vector = await embed(contextText);
        const { error } = await createAdminClient()
          .from("startup_context")
          .update({ embedding: toPgVector(vector), status: "generating_queries" })
          .eq("startup_id", startupId);
        if (error) throw new Error(error.message);
        return { dimensions: vector.length };
      } catch (error) {
        throw toInngestError(error);
      }
    });

    await step.sendEvent("emit-context-built", contextBuilt.create({ startupId }));
  },
);
