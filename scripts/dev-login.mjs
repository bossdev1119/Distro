// DEV ONLY: sign in without sending an email (avoids Supabase's built-in email rate limit).
// Asks Supabase (with the secret key) for a magic-link token and prints a URL that goes straight
// to our /auth/callback, which verifies it with verifyOtp({ token_hash }).
//
// Usage:  npm run dev:login -- you@example.com
//
// Never turn this into an API route or run it against production: anyone holding the secret key
// can sign in as any user.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2];
if (!email || !email.includes("@")) {
  console.error("Usage: npm run dev:login -- you@example.com");
  process.exit(1);
}

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);

const siteUrl = env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(siteUrl)) {
  console.error(`Refusing to run: NEXT_PUBLIC_SITE_URL is ${siteUrl}, not localhost. This script is for local dev only.`);
  process.exit(1);
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
if (error) {
  console.error(`Supabase error: ${error.message}`);
  console.error("If the user doesn't exist yet, request one magic link from /login first (that creates the user).");
  process.exit(1);
}

const url = new URL("/auth/callback", siteUrl);
url.searchParams.set("token_hash", data.properties.hashed_token);
url.searchParams.set("type", "magiclink");
url.searchParams.set("next", "/onboarding");

console.log("\nOpen this link in your browser (single use, expires in about an hour):\n");
console.log(url.toString());
console.log("");
