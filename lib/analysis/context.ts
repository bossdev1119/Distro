import type { StartupProfile } from "@/lib/llm/schemas";

/**
 * The text we embed to represent "what this startup is about". Only fields describing the
 * problem and audience — tone and creator_offer are about outreach, not the topic, and would
 * blur the vector.
 */
export function buildContextText(profile: StartupProfile): string {
  return [
    profile.one_liner,
    `Problem: ${profile.problem}`,
    `Audience: ${profile.icp}`,
    `Use cases: ${profile.use_cases.join("; ")}`,
    `Keywords: ${profile.keywords.join(", ")}`,
  ].join("\n");
}
