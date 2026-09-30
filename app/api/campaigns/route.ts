import { NextResponse } from "next/server";
import { z } from "zod";
import { inngest, profileConfirmed } from "@/inngest/client";
import { jsonError, parseBody } from "@/lib/api";
import { DISCOVERY } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({ startupId: z.uuid() });

/**
 * "Find creators": returns the startup's latest campaign, or creates one.
 * If the discovery context was never built (profile confirmed before M2 existed), starts it.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, bodySchema);
  if ("response" in body) return body.response;
  const { startupId } = body.data;

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return jsonError("Unauthorized", 401);

  // RLS: returns nothing unless this user owns the startup.
  const { data: startup, error } = await supabase
    .from("startups")
    .select("id, profile_status")
    .eq("id", startupId)
    .maybeSingle<{ id: string; profile_status: string }>();
  if (error) return jsonError(error.message, 500);
  if (!startup) return jsonError("Not found", 404);
  if (startup.profile_status !== "confirmed") return jsonError("Confirm the profile first", 409);

  const { data: context } = await supabase.from("startup_context").select("status").eq("startup_id", startupId).maybeSingle();
  if (!context) await inngest.send(profileConfirmed.create({ startupId, userId }));

  const { data: existing } = await supabase
    .from("campaigns")
    .select("id")
    .eq("startup_id", startupId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (existing) return NextResponse.json({ id: existing.id });

  const { data: created, error: insertError } = await supabase
    .from("campaigns")
    .insert({ startup_id: startupId, name: "YouTube creators", budget_n: DISCOVERY.campaignSize })
    .select("id")
    .single<{ id: string }>();
  if (insertError) return jsonError(insertError.message, 500);
  return NextResponse.json({ id: created.id }, { status: 201 });
}
