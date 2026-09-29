import "server-only";
import { serverEnv } from "@/lib/env";

const JINA_READER = "https://r.jina.ai/";
const TIMEOUT_MS = 30_000;

export class PageNotFoundError extends Error {}

/**
 * Fetches a URL as markdown via Jina Reader. Works without an API key (lower rate limit).
 * Throws PageNotFoundError for 404-ish pages so callers can skip optional pages like /pricing.
 */
export async function fetchMarkdown(url: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "text/plain",
    "X-Return-Format": "markdown",
    "X-Retain-Images": "none",
  };
  const key = serverEnv().JINA_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${JINA_READER}${url}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });

  if (res.status === 404 || res.status === 410 || res.status === 422) {
    throw new PageNotFoundError(`${url} returned ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`Reader failed for ${url}: ${res.status} ${await res.text().catch(() => "")}`.trim());
  }

  const text = await res.text();
  if (/^\s*(Warning: Target URL returned error 404|404 Not Found)/im.test(text)) {
    throw new PageNotFoundError(`${url} returned 404`);
  }
  return text.trim();
}

/** Normalizes user input like "acme.com" to "https://acme.com" (no trailing slash). */
export function normalizeUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const u = new URL(withScheme);
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** Homepage, /pricing and /about on the startup's origin. */
export function profilePageUrls(startupUrl: string): string[] {
  const origin = new URL(startupUrl).origin;
  return [startupUrl, `${origin}/pricing`, `${origin}/about`].filter((u, i, all) => all.indexOf(u) === i);
}
