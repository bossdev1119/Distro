import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./public-env";

/** Supabase client for Client Components. Subject to RLS as the signed-in user. */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}
