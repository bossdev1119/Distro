import { NextResponse } from "next/server";
import { z } from "zod";
import { inngest, profileConfirmed } from "@/inngest/client";
import { jsonError, parseBody } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import type { ProfileStatus } from "@/lib/db/types";
import { startupProfileSchema } from "@/lib/llm/schemas";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ profile: startupProfileSchema });
const EDITABLE: ProfileStatus[] = ["ready", "confirmed"];

async function loadEditable(id: string) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return { response: jsonError("Unauthorized", 401) } as const;

  const { data: startup, error } = await supabase
    .from("startups")
    .select("id, profile_status")
    .eq("id", id)
    .maybeSingle<{ id: string; profile_status: ProfileStatus }>();
  if (error) return { response: jsonError(error.message, 500) } as const;
  if (!startup) return { response: jsonError("Not found", 404) } as const;
  if (!EDITABLE.includes(startup.profile_status)) {
    return { response: jsonError(`Profile is ${startup.profile_status} and cannot be edited yet`, 409) } as const;
  }
  return { supabase, userId, startup } as const;
}

/** Save edits without confirming. */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const body = await parseBody(request, bodySchema);
  if ("response" in body) return body.response;

  const ctx = await loadEditable(id);
  if ("response" in ctx) return ctx.response;

  const { error } = await ctx.supabase.from("startups").update({ profile_json: body.data.profile }).eq("id", id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true, profile_status: ctx.startup.profile_status });
}

/** Save and confirm; emits profile.confirmed for the next pipeline stage. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = await parseBody(request, bodySchema);
  if ("response" in body) return body.response;

  const ctx = await loadEditable(id);
  if ("response" in ctx) return ctx.response;

  const { error } = await ctx.supabase
    .from("startups")
    .update({ profile_json: body.data.profile, profile_status: "confirmed" })
    .eq("id", id);
  if (error) return jsonError(error.message, 500);

  await writeAudit({
    startupId: id,
    actorId: ctx.userId,
    action: "profile.confirmed",
    entityType: "startup",
    entityId: id,
  });
  await inngest.send(profileConfirmed.create({ startupId: id, userId: ctx.userId }));

  return NextResponse.json({ ok: true, profile_status: "confirmed" });
}
