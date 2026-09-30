import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { pacificDate } from "@/lib/time";

// Daily budgets for free-tier APIs, counted by us in the quota_usage table.
// Google resets both YouTube and Gemini daily quotas at midnight Pacific time.

export const QUOTA = {
  /** YouTube Data API units (search = 100, list calls = 1). */
  youtube: "youtube",
  /** Gemini embedding texts. Each text counts, even when 100 are sent in one request. */
  geminiEmbed: "gemini_embed",
} as const;

export type QuotaProvider = (typeof QUOTA)[keyof typeof QUOTA];

/** A daily budget is used up. Not worth retrying until the quota resets (midnight Pacific). */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

/**
 * Reserves `units` of today's budget BEFORE making a call. Throws QuotaExhaustedError if that
 * would pass `limit`. Reserving first (not counting after) means a crash mid-call never
 * under-counts, and two jobs running at once can't both overspend (the SQL function locks the row).
 */
export async function reserveQuota(provider: QuotaProvider, units: number, limit: number): Promise<number> {
  const { data, error } = await createAdminClient().rpc("consume_quota", {
    p_provider: provider,
    p_day: pacificDate(),
    p_units: units,
    p_limit: limit,
  });
  if (error) throw new Error(`consume_quota failed: ${error.message}`);
  const total = Number(data);
  if (total < 0) {
    throw new QuotaExhaustedError(`Daily ${provider} budget of ${limit} reached; continuing after midnight Pacific time`);
  }
  return total;
}

/** Units used today (Pacific date). */
export async function quotaUsedToday(provider: QuotaProvider): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("quota_usage")
    .select("units")
    .eq("provider", provider)
    .eq("day", pacificDate())
    .maybeSingle<{ units: number }>();
  if (error) throw new Error(`quota_usage read failed: ${error.message}`);
  return data?.units ?? 0;
}
