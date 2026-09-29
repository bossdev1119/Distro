import { NextResponse } from "next/server";
import { z } from "zod";
import { inngest, startupCreated } from "@/inngest/client";
import { jsonError, parseBody } from "@/lib/api";
import { normalizeUrl } from "@/lib/fetch/reader";
import { createClient } from "@/lib/supabase/server";

const createStartupSchema = z.object({
  url: z
    .string()
    .trim()
    .min(3)
    .max(2048)
    .transform((value, ctx) => {
      try {
        const url = normalizeUrl(value);
        const host = new URL(url).hostname;
        if (!host.includes(".") || host === "localhost") throw new Error("not public");
        return url;
      } catch {
        ctx.addIssue({ code: "custom", message: "Enter a valid public website URL" });
        return z.NEVER;
      }
    }),
  notes: z.string().trim().max(5000).optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, createStartupSchema);
  if ("response" in body) return body.response;

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return jsonError("Unauthorized", 401);

  const { url, notes } = body.data;
  const { data: startup, error } = await supabase
    .from("startups")
    .insert({
      owner_id: userId,
      url,
      notes: notes || null,
      name: new URL(url).hostname.replace(/^www\./, ""),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !startup) return jsonError(error?.message ?? "Could not create startup", 500);

  try {
    await inngest.send(startupCreated.create({ startupId: startup.id }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("startups")
      .update({ profile_status: "failed", profile_error: `Could not queue profile job: ${message}` })
      .eq("id", startup.id);
    return jsonError("Could not start profile job. Is the Inngest dev server running?", 502);
  }

  return NextResponse.json({ id: startup.id }, { status: 201 });
}
