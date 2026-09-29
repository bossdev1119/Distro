import type { StartupProfile } from "@/lib/llm/schemas";

export type ProfileStatus = "pending" | "building" | "ready" | "failed" | "confirmed";

export type StartupRow = {
  id: string;
  owner_id: string;
  url: string;
  name: string | null;
  notes: string | null;
  profile_json: StartupProfile | null;
  profile_status: ProfileStatus;
  profile_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Shape returned by GET /api/startups/:id, used by the profile editor to poll. */
export type StartupStatusResponse = Pick<
  StartupRow,
  "id" | "url" | "name" | "profile_json" | "profile_status" | "profile_error"
>;
