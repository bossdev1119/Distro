import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseBody } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({ removed: z.boolean() });

/** Remove (or restore) a creator from the list. Removed rows are hidden, never deleted. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  const { id, matchId } = await params;
  const body = await parseBody(request, bodySchema);
  if ("response" in body) return body.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("matches")
    .update({ removed_at: body.data.removed ? new Date().toISOString() : null })
    .eq("id", matchId)
    .eq("campaign_id", id)
    .select("id")
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Not found", 404);
  return NextResponse.json({ ok: true });
}
