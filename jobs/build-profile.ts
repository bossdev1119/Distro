import { NonRetriableError } from "inngest";
import { inngest, startupCreated, startupCreatedData } from "@/inngest/client";
import { fetchMarkdown, PageNotFoundError, profilePageUrls } from "@/lib/fetch/reader";
import { LlmOutputError } from "@/lib/llm/client";
import { buildProfile, type ProfilePage } from "@/lib/llm/profile";
import { createAdminClient } from "@/lib/supabase/admin";

// Bound what we persist in step state; profile.ts applies the same cap before prompting.
const MAX_PAGE_CHARS = 30_000;

async function setStatus(startupId: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await createAdminClient().from("startups").update(fields).eq("id", startupId);
  if (error) throw new Error(`Failed to update startup ${startupId}: ${error.message}`);
}

export const buildProfileJob = inngest.createFunction(
  {
    id: "build-profile",
    triggers: [startupCreated],
    retries: 3,
    concurrency: { key: "event.data.startupId", limit: 1 },
    onFailure: async ({ event, error }) => {
      // The failure payload wraps the original event untyped; re-validate it.
      const { startupId } = startupCreatedData.parse(event.data.event.data);
      await setStatus(startupId, { profile_status: "failed", profile_error: error.message.slice(0, 1000) });
    },
  },
  async ({ event, step }) => {
    const { startupId } = event.data;

    const startup = await step.run("load-startup", async () => {
      const { data, error } = await createAdminClient()
        .from("startups")
        .select("id, url, notes")
        .eq("id", startupId)
        .single<{ id: string; url: string; notes: string | null }>();
      if (error || !data) throw new NonRetriableError(`Startup ${startupId} not found`);
      await setStatus(startupId, { profile_status: "building", profile_error: null });
      return data;
    });

    const [homeUrl, ...optionalUrls] = profilePageUrls(startup.url);

    // Homepage is required: errors propagate so Inngest retries the step.
    const home = await step.run("fetch-homepage", async (): Promise<ProfilePage> => {
      const markdown = await fetchMarkdown(homeUrl);
      return { url: homeUrl, markdown: markdown.slice(0, MAX_PAGE_CHARS) };
    });

    // /pricing and /about are optional: a missing page is skipped, not retried.
    const optional = await Promise.all(
      optionalUrls.map((url) =>
        step.run(`fetch-${new URL(url).pathname.replace(/\W+/g, "") || "page"}`, async (): Promise<ProfilePage | null> => {
          try {
            const markdown = await fetchMarkdown(url);
            return { url, markdown: markdown.slice(0, MAX_PAGE_CHARS) };
          } catch (error) {
            if (error instanceof PageNotFoundError) return null;
            throw error;
          }
        }),
      ),
    );

    const pages = [home, ...optional].filter((p): p is ProfilePage => p !== null && p.markdown.length > 0);

    const profile = await step.run("generate-profile", async () => {
      try {
        return await buildProfile({ url: startup.url, notes: startup.notes, pages });
      } catch (error) {
        // generateJson already retried once on bad output; retrying the step won't help.
        if (error instanceof LlmOutputError) throw new NonRetriableError(error.message, { cause: error });
        throw error;
      }
    });

    await step.run("save-profile", async () => {
      await setStatus(startupId, { profile_json: profile, profile_status: "ready", profile_error: null });
    });

    return { startupId, pages: pages.map((p) => p.url) };
  },
);
