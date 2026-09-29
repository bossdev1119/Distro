import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./public-env";

const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/inngest", "/c/"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/** Refreshes the Supabase session cookie and redirects unauthenticated requests to /login. */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Do not run code between createServerClient and getClaims — it can cause random logouts.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims.sub);
  const { pathname } = request.nextUrl;

  if (!signedIn && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (signedIn && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
