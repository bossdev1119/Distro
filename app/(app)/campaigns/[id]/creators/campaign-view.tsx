"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { canStartSearch, isStuck } from "@/lib/campaign-status";
import type { CampaignOverview } from "@/lib/db/types";
import { CreatorsTable } from "./creators-table";
import { DemandCards } from "./demand-cards";
import { formatCompact, pipelineProgress, RUNNING_STAGES, STAGE_LABEL } from "./format";
import { QueryReview } from "./query-review";

const POLL_MS = 3000;

/** Re-fetches the overview every few seconds while jobs run (or while queries are being generated). */
function useCampaignOverview(initial: CampaignOverview) {
  const [overview, setOverview] = useState(initial);
  const id = initial.campaign.id;
  const { stage } = overview.campaign;
  const waitingForQueries = stage === "awaiting_queries" && overview.context?.status !== "ready" && overview.context?.status !== "failed";
  const shouldPoll = RUNNING_STAGES.includes(stage) || stage === "paused_quota" || waitingForQueries;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${id}`, { cache: "no-store" });
      if (res.ok) setOverview((await res.json()) as CampaignOverview);
    } catch {
      // Network blip: the next poll will try again.
    }
  }, [id]);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, refresh]);

  return { overview, refresh };
}

export function CampaignView({ initial }: { initial: CampaignOverview }) {
  const { overview, refresh } = useCampaignOverview(initial);
  const { campaign, startup, context, quota } = overview;
  const running = RUNNING_STAGES.includes(campaign.stage);
  const progress = pipelineProgress(campaign.stage, campaign.batches_done, campaign.batches_total);
  const showResults = campaign.stage !== "awaiting_queries";

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link href={`/startups/${startup.id}/profile`} className="text-sm text-muted-foreground hover:underline">
              ← {startup.name ?? startup.url}
            </Link>
            <h1 className="text-2xl font-semibold">Audience &amp; Creators</h1>
          </div>
          <Badge variant={campaign.stage === "failed" ? "destructive" : "secondary"}>{STAGE_LABEL[campaign.stage]}</Badge>
        </div>
        {showResults && (
          <div className="flex flex-col gap-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all duration-500" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {campaign.stage === "scoring_creators" || campaign.stage === "done"
                ? `Batch ${campaign.batches_done}/${campaign.batches_total} scored`
                : STAGE_LABEL[campaign.stage]}
              {" · "}Today: YouTube {quota.usedToday.toLocaleString()} / {quota.stopAt.toLocaleString()} units
              {quota.embedProvider === "gemini"
                ? ` · Gemini embeddings ${quota.embedsToday.toLocaleString()} / ${quota.embedStopAt.toLocaleString()}`
                : " · Embeddings: local model (no limit)"}
            </p>
          </div>
        )}
      </div>

      {/* Problems */}
      {campaign.stage === "paused_quota" && (
        <Card>
          <CardHeader>
            <CardTitle>Daily free quota reached, continuing tomorrow</CardTitle>
            <CardDescription>
              {campaign.stage_error ? `${campaign.stage_error}. ` : ""}
              The run will resume automatically
              {campaign.resume_at ? ` around ${new Date(campaign.resume_at).toLocaleString()}` : " after midnight Pacific time"}.
              Nothing is lost: finished work is saved. Keep `npm run inngest` running so it can wake up.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      {campaign.stage === "failed" && (
        <Card>
          <CardHeader>
            <CardTitle>Something went wrong</CardTitle>
            <CardDescription className="break-words">{campaign.stage_error ?? "Unknown error."}</CardDescription>
          </CardHeader>
        </Card>
      )}
      {context?.status === "failed" && (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t prepare the search</CardTitle>
            <CardDescription className="break-words">{context.error ?? "Unknown error."}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {isStuck(campaign) && (
        <Card>
          <CardHeader>
            <CardTitle>This run seems stuck</CardTitle>
            <CardDescription>
              No progress for a while. This usually means the Inngest dev server was restarted mid-run. Use
              &quot;Search again&quot; below: finished searches come from the cache (0 quota) and only missing work is redone.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Step 1: review queries */}
      {canStartSearch(campaign) && (
        <QueryReview campaignId={campaign.id} overview={overview} onStarted={refresh} />
      )}

      {/* Funnel: where candidates drop out */}
      {showResults && Object.keys(campaign.stats).length > 0 && <Funnel stats={campaign.stats} />}

      {/* Step 2: demand */}
      {overview.demand.length > 0 && <DemandCards demand={overview.demand} />}

      {/* Step 3: creators */}
      {showResults && (
        <CreatorsTable
          campaignId={campaign.id}
          // Changes whenever a batch finishes, so the table re-fetches new rows.
          refreshKey={`${campaign.stage}-${campaign.batches_done}`}
          running={running}
        />
      )}
    </div>
  );
}

function Funnel({ stats }: { stats: CampaignOverview["campaign"]["stats"] }) {
  const steps: [string, number | undefined][] = [
    ["Videos found", stats.videos_found],
    ["Relevant videos", stats.relevant_videos],
    ["Channels", stats.channels],
    ["5k–200k subs", stats.in_subscriber_range],
    ["Active (60 days)", stats.active],
    ["With email", stats.with_email],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {steps
        .filter(([, n]) => n !== undefined)
        .map(([label, n], i) => (
          <span key={label}>
            {i > 0 && <span className="mr-2">→</span>}
            <span className="font-medium text-foreground">{formatCompact(n)}</span> {label}
          </span>
        ))}
    </div>
  );
}
