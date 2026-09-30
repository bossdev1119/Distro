"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { CampaignOverview } from "@/lib/db/types";
import { startSearchSchema, type ReviewedQuery } from "@/lib/discovery/schemas";

type Row = ReviewedQuery & { key: string };

let nextKey = 0;
const withKey = (q: ReviewedQuery): Row => ({ ...q, key: `q${nextKey++}` });

/** Pending queries if there are any; otherwise the last run's queries (deduplicated) to edit and re-run. */
function initialRows(overview: CampaignOverview): Row[] {
  const pending = overview.queries.filter((q) => q.status === "pending");
  const source = pending.length > 0 ? pending : overview.queries;
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const q of source) {
    const norm = q.query.trim().toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    rows.push(withKey({ niche: q.niche, query: q.query }));
  }
  return rows;
}

export function QueryReview({
  campaignId,
  overview,
  onStarted,
}: {
  campaignId: string;
  overview: CampaignOverview;
  onStarted: () => void;
}) {
  const rerun = overview.campaign.stage !== "awaiting_queries";
  const hasQueries = overview.queries.length > 0;
  const generating = !hasQueries && overview.context?.status !== "failed";

  // Key the form on the query ids so it resets when freshly generated queries arrive.
  const formKey = overview.queries.map((q) => q.id).join(",");

  if (generating) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Preparing search queries…</CardTitle>
          <CardDescription>
            Turning your profile into an embedding and writing YouTube searches in your customers&apos; words.
            This takes under a minute.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!hasQueries) return null;

  const form = <QueryForm key={formKey} campaignId={campaignId} initial={initialRows(overview)} rerun={rerun} onStarted={onStarted} />;
  if (!rerun) return form;
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">Edit queries &amp; search again</summary>
      <div className="mt-4">{form}</div>
    </details>
  );
}

function QueryForm({
  campaignId,
  initial,
  rerun,
  onStarted,
}: {
  campaignId: string;
  initial: Row[];
  rerun: boolean;
  onStarted: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [starting, setStarting] = useState(false);

  // Keep niches in first-seen order.
  const niches = useMemo(() => [...new Set(rows.map((r) => r.niche))], [rows]);
  const estimatedUnits = rows.length * 100;

  function update(key: string, query: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, query } : r)));
  }
  function remove(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }
  function add(niche: string) {
    setRows((rs) => [...rs, withKey({ niche, query: "" })]);
  }

  async function start() {
    const parsed = startSearchSchema.safeParse({
      queries: rows.map(({ niche, query }) => ({ niche, query })).filter((q) => q.query.trim()),
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check your queries.");
      return;
    }
    setStarting(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      toast.success("Search started.");
      onStarted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{rerun ? "Search queries" : "Review your search queries"}</CardTitle>
        <CardDescription>
          These are what we&apos;ll type into YouTube. Good queries sound like a viewer with the problem, not like an ad.
          Each query costs 100 of today&apos;s ~10,000 free YouTube units; repeats within 7 days are free (cached).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {niches.map((niche) => (
          <div key={niche} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{niche}</h3>
            {rows
              .filter((r) => r.niche === niche)
              .map((r) => (
                <div key={r.key} className="flex gap-2">
                  <Input value={r.query} onChange={(e) => update(r.key, e.target.value)} maxLength={200} aria-label={`Query in ${niche}`} />
                  <Button variant="ghost" size="sm" onClick={() => remove(r.key)} aria-label="Remove query">
                    ✕
                  </Button>
                </div>
              ))}
            <Button variant="link" size="sm" className="self-start px-0" onClick={() => add(niche)}>
              + Add query
            </Button>
          </div>
        ))}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {rows.length} queries · up to ~{estimatedUnits.toLocaleString()} units
        </span>
        <Button onClick={start} disabled={starting || rows.length === 0}>
          {starting ? "Starting…" : rerun ? "Search again" : "Start search"}
        </Button>
      </CardFooter>
    </Card>
  );
}
