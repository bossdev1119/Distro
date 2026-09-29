import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // The proxy already redirects, but verify here too so pages never render without a user.
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims.sub) redirect("/login");
  const email = typeof data.claims.email === "string" ? data.claims.email : "";

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between px-4">
          <Link href="/" className="font-semibold">
            Distro
          </Link>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{email}</span>
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
