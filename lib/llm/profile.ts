import "server-only";
import { generateJson, MODELS } from "./client";
import { startupProfileSchema, type StartupProfile } from "./schemas";

export type ProfilePage = { url: string; markdown: string };

const SYSTEM = `You are a go-to-market analyst helping an early-stage startup find creators to partner with.
From the startup's own website content, produce a concise, factual product profile.

Guidelines:
- Base every field on the provided pages and founder notes. Do not invent features, pricing or customers.
  If something is not stated, make a cautious inference and keep it general.
- "icp" should be specific enough to find where these people spend time online (role, company size, context).
- "keywords" are terms a YouTuber, newsletter writer or X account in this niche would use in titles and bios —
  not internal product jargon.
- "competitors" should be real, named products only when clearly implied; otherwise return an empty list.
- "creator_offer" is a realistic offer an early-stage startup could make a small creator (e.g. free
  lifetime plan, affiliate commission, early access, a small paid integration). Use pricing info if present.
- "tone" describes how outreach from this founder should sound, inferred from the site's voice.`;

// Keep each page bounded so a huge docs page can't crowd out the others.
const MAX_CHARS_PER_PAGE = 30_000;

export async function buildProfile(input: {
  url: string;
  notes: string | null;
  pages: ProfilePage[];
}): Promise<StartupProfile> {
  const pages = input.pages
    .map((p) => `<page url="${p.url}">\n${p.markdown.slice(0, MAX_CHARS_PER_PAGE)}\n</page>`)
    .join("\n\n");

  const user = `Startup URL: ${input.url}

<founder_notes>
${input.notes?.trim() || "(none)"}
</founder_notes>

<website>
${pages || "(no pages could be fetched — rely on the URL and founder notes)"}
</website>

Return the product profile.`;

  return generateJson({ model: MODELS.profile, system: SYSTEM, user, schema: startupProfileSchema });
}
