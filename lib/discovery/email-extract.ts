// Finds a business email in text a creator published themselves (their channel description).
// No other sites are fetched. Pure function: no network, easy to unit test.

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Placeholder or system addresses that are never a real contact.
const IGNORED_DOMAINS = ["example.com", "email.com", "domain.com", "sentry.io", "youtube.com"];
const IGNORED_LOCAL = /^(no-?reply|donotreply|mailer-daemon)$/i;

// Words near an email that suggest it's for business inquiries.
const BUSINESS_HINT = /business|inquir|enquir|sponsor|collab|partner|contact|booking|press|brand/i;

/**
 * Undoes common anti-spam spellings: "name [at] domain [dot] com", "name (at) domain.com".
 * Creators write emails this way so bots can't harvest them.
 */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, "@")
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, ".")
    .replace(/\s+at\s+(?=[a-z0-9-]+\s*(\.|\s+dot\s+))/gi, "@")
    .replace(/\s+dot\s+(?=[a-z]{2,}\b)/gi, ".");
}

/** Returns the most business-like email in `text`, lowercased, or null if none. */
export function extractBusinessEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = deobfuscate(text);
  const candidates: { email: string; score: number }[] = [];

  for (const match of clean.matchAll(EMAIL)) {
    const email = match[0].toLowerCase().replace(/\.+$/, ""); // drop a sentence-ending "."
    const [local, domain] = email.split("@");
    if (!local || !domain || IGNORED_LOCAL.test(local) || IGNORED_DOMAINS.includes(domain)) continue;
    // Look at ~60 characters before the email for a hint like "Business inquiries:".
    const before = clean.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
    candidates.push({ email, score: BUSINESS_HINT.test(before) ? 2 : BUSINESS_HINT.test(local) ? 1 : 0 });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.email ?? null;
}
