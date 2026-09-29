import { notFound } from "next/navigation";
import type { StartupStatusResponse } from "@/lib/db/types";
import { createClient } from "@/lib/supabase/server";
import { ProfileEditor } from "./profile-editor";

export default async function ProfilePage({ params }: PageProps<"/startups/[id]/profile">) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("startups")
    .select("id, url, name, profile_json, profile_status, profile_error")
    .eq("id", id)
    .maybeSingle<StartupStatusResponse>();
  if (error) throw new Error(error.message);
  if (!data) notFound();

  return <ProfileEditor initial={data} />;
}
