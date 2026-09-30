import { notFound } from "next/navigation";
import { loadCampaignOverview } from "@/lib/campaigns";
import { createClient } from "@/lib/supabase/server";
import { CampaignView } from "./campaign-view";

/** Server component: loads the first snapshot (fast first paint), then the client polls. */
export default async function CreatorsPage({ params }: PageProps<"/campaigns/[id]/creators">) {
  const { id } = await params;
  const overview = await loadCampaignOverview(await createClient(), id);
  if (!overview) notFound();
  return <CampaignView initial={overview} />;
}
