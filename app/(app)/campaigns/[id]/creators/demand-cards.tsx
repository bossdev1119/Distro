import Image from "next/image";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { NicheDemandCard } from "@/lib/db/types";
import { formatCompact } from "./format";

/** One card per niche: the estimate, how much evidence backs it, and the top evidence videos. */
export function DemandCards({ demand }: { demand: NicheDemandCard[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Where your audience is</h2>
        <p className="text-sm text-muted-foreground">
          Estimated interest = views on relevant videos, weighted by how relevant each video is. It&apos;s an estimate, not a
          head count: the same person can watch many videos, and a viewer isn&apos;t a buyer.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {demand.map((d) => (
          <Card key={d.niche}>
            <CardHeader>
              <CardDescription>{d.niche}</CardDescription>
              <CardTitle className="text-2xl">
                ~{formatCompact(d.interested_estimate)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">estimated interested views</span>
              </CardTitle>
              <CardDescription>
                {d.relevant_videos} relevant videos · {formatCompact(d.total_comments)} comments
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {d.evidence.map((v) => (
                <a key={v.video_id} href={v.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-md hover:bg-muted/50">
                  {v.thumbnail_url ? (
                    <Image src={v.thumbnail_url} alt="" width={80} height={45} className="h-[45px] w-20 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-[45px] w-20 shrink-0 rounded bg-muted" />
                  )}
                  <span className="min-w-0 text-sm">
                    <span className="line-clamp-2">{v.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {v.channel_title} · {formatCompact(v.views)} views
                    </span>
                  </span>
                </a>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
