import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import type { StartupStatusResponse } from "@/lib/db/types";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // RLS limits this to the owner; anyone else gets "not found".
  const { data, error } = await supabase
    .from("startups")
    .select("id, url, name, profile_json, profile_status, profile_error")
    .eq("id", id)
    .maybeSingle<StartupStatusResponse>();

  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Not found", 404);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
