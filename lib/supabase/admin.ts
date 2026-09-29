import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

/**
 * Service-role client. BYPASSES RLS — use only in background jobs and trusted server code
 * that has already checked authorization. Never import from client code.
 */
export function createAdminClient() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
