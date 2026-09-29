import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * Magic-link landing. Supports both the default PKCE link (?code=) and the
 * token-hash template (?token_hash=&type=) so either Supabase email template works.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();
  let errorMessage: string | undefined;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    errorMessage = error?.message;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    errorMessage = error?.message;
  } else {
    errorMessage = searchParams.get("error_description") ?? "Missing sign-in code";
  }

  if (errorMessage) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", errorMessage);
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(new URL(next, origin));
}
