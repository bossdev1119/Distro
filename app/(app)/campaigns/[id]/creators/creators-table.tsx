"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CreatorSortColumn, CreatorsPage } from "@/lib/db/types";
import { formatCompact } from "./format";

type Sort = { column: CreatorSortColumn; dir: "asc" | "desc" };

const COLUMNS: { key: CreatorSortColumn | null; label: string; className?: string }[] = [
  { key: "final_rank", label: "#" },
  { key: "display_name", label: "Channel" },
  { key: "subscribers", label: "Subscribers", className: "text-right" },
  { key: "relevant_video_count", label: "Relevant videos", className: "text-right" },
  { key: "relevant_views", label: "Relevant views", className: "text-right" },
  { key: "fit_score", label: "Fit", className: "text-right" },
  { key: null, label: "Why" },
  { key: null, label: "Email" },
  { key: null, label: "" },
];

export function CreatorsTable({ campaignId, refreshKey, running }: { campaignId: string; refreshKey: string; running: boolean }) {
  const [sort, setSort] = useState<Sort>({ column: "final_rank", dir: "asc" });
  const [page, setPage] = useState(1);
  const [hasEmail, setHasEmail] = useState(false);
  const [data, setData] = useState<CreatorsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after "Remove" to force a re-fetch.
  const [reloadTick, setReloadTick] = useState(0);

  // Re-fetch when the page/sort/filter changes, a scoring batch finishes (refreshKey), or after a removal.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), sort: sort.column, dir: sort.dir, hasEmail: hasEmail ? "1" : "0" });
    fetch(`/api/campaigns/${campaignId}/creators?${params}`, { cache: "no-store" })
      .then((res) => res.json() as Promise<CreatorsPage | { error: string }>)
      .then((body) => {
        if (cancelled) return; // a newer request replaced this one
        if ("error" in body) throw new Error(body.error);
        setData(body);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load creators");
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, page, sort, hasEmail, refreshKey, reloadTick]);

  function toggleSort(column: CreatorSortColumn) {
    setPage(1);
    setSort((s) =>
      s.column === column
        ? { column, dir: s.dir === "asc" ? "desc" : "asc" }
        : { column, dir: column === "final_rank" || column === "display_name" ? "asc" : "desc" },
    );
  }

  async function remove(matchId: string) {
    const res = await fetch(`/api/campaigns/${campaignId}/creators/${matchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removed: true }),
    });
    if (!res.ok) {
      toast.error("Couldn't remove creator.");
      return;
    }
    toast.success("Removed from the list.");
    setReloadTick((t) => t + 1);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Top creators</h2>
          <p className="text-sm text-muted-foreground">
            Small channels (5k–200k subscribers) active in the last 60 days, ranked by relevance, reach and AI fit.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasEmail}
            onChange={(e) => {
              setHasEmail(e.target.checked);
              setPage(1);
            }}
          />
          Has email only
        </label>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && data.rows.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
          {running ? "Creators will appear here as each batch is scored…" : hasEmail ? "No creators with an email yet." : "No creators matched the filters. Try more or broader queries."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                {COLUMNS.map((c, i) => (
                  <th key={i} className={`px-3 py-2 font-medium whitespace-nowrap ${c.className ?? ""}`}>
                    {c.key ? (
                      <button type="button" onClick={() => toggleSort(c.key!)} className="hover:underline">
                        {c.label}
                        {sort.column === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => (
                <tr key={r.match_id} className="border-t align-top">
                  <td className="px-3 py-2 text-muted-foreground">{r.final_rank}</td>
                  <td className="px-3 py-2">
                    <a href={r.profile_url ?? "#"} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:underline">
                      {r.thumbnail_url ? (
                        <Image src={r.thumbnail_url} alt="" width={28} height={28} className="size-7 shrink-0 rounded-full" />
                      ) : (
                        <div className="size-7 shrink-0 rounded-full bg-muted" />
                      )}
                      <span className="font-medium">{r.display_name ?? r.channel_id}</span>
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right">{formatCompact(r.subscribers)}</td>
                  <td className="px-3 py-2 text-right">{r.relevant_video_count}</td>
                  <td className="px-3 py-2 text-right">{formatCompact(r.relevant_views)}</td>
                  <td className="px-3 py-2 text-right font-medium">{r.fit_score ?? "—"}</td>
                  <td className="min-w-64 px-3 py-2 text-muted-foreground">{r.fit_reason}</td>
                  <td className="px-3 py-2">{r.has_email ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">
                    <Button variant="ghost" size="sm" onClick={() => remove(r.match_id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
            Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
