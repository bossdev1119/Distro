"use server";

import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const loginSchema = z.object({
  email: z.email(),
  next: z.string().optional(),
});

/** Only allow same-site relative redirects after login. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  const callback = new URL("/auth/callback", serverEnv().NEXT_PUBLIC_SITE_URL);
  callback.searchParams.set("next", safeNext(parsed.data.next));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: callback.toString() },
  });
  if (error) return { status: "error", message: error.message };

  return { status: "sent", message: `Check ${parsed.data.email} for a sign-in link.` };
}
