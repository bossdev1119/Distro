import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StartupRow } from "@/lib/db/types";
import { createClient } from "@/lib/supabase/server";

type StartupListItem = Pick<StartupRow, "id" | "url" | "name" | "profile_status" | "created_at">;

export default async function HomePage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("startups")
    .select("id, url, name, profile_status, created_at")
    .order("created_at", { ascending: false })
    .returns<StartupListItem[]>();
  if (error) throw new Error(error.message);

  if (!data.length) redirect("/onboarding");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your startups</h1>
        <Link href="/onboarding" className={buttonVariants()}>
          Add startup
        </Link>
      </div>
      <div className="grid gap-3">
        {data.map((s) => (
          <Link key={s.id} href={`/startups/${s.id}/profile`}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>{s.name ?? s.url}</span>
                  <Badge variant="secondary">{s.profile_status}</Badge>
                </CardTitle>
                <CardDescription>{s.url}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
