import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/api";
import { DISCOVERY } from "@/lib/config";
import { CREATOR_SORT_COLUMNS, type CreatorTableRow, type CreatorsPage } from "@/lib/db/types";
import { createClient } from "@/lib/supabase/server";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Whitelist: only known columns can be sorted on, so the URL can't inject anything.
  sort: z.enum(CREATOR_SORT_COLUMNS).default("final_rank"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  hasEmail: z.enum(["0", "1"]).default("0"),
});

/** The ranked creators table: 20 per page, sortable, optional "has email" filter. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return jsonError("Invalid query", 400, parsed.error.flatten());
  const { page, sort, dir, hasEmail } = parsed.data;
  const pageSize = DISCOVERY.creatorsPerPage;

  const supabase = await createClient();
  // The view runs with the caller's permissions (security_invoker), so RLS still applies.
  let query = supabase
    .from("campaign_creators")
    .select(
      "match_id, final_rank, final_score, fit_score, fit_reason, rank_score, relevant_views, relevant_video_count, channel_id, display_name, profile_url, thumbnail_url, subscribers, has_email",
      { count: "exact" },
    )
    .eq("campaign_id", id)
    .is("removed_at", null)
    .not("final_score", "is", null)
    .lte("final_rank", DISCOVERY.campaignSize);
  if (hasEmail === "1") query = query.eq("has_email", true);

  // Pagination with range(from, to): rows 0-19 are page 1, 20-39 page 2...
  const from = (page - 1) * pageSize;
  const { data, count, error } = await query
    .order(sort, { ascending: dir === "asc", nullsFirst: false })
    .order("final_rank", { ascending: true })
    .range(from, from + pageSize - 1)
    .returns<CreatorTableRow[]>();
  if (error) return jsonError(error.message, 500);

  const body: CreatorsPage = {
    rows: data.map((r) => ({ ...r, relevant_views: Number(r.relevant_views) })),
    total: count ?? 0,
    page,
    pageSize,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
