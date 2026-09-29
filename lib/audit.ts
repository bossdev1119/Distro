import "server-only";
import type { Json } from "@/lib/db/json";
import { createAdminClient } from "@/lib/supabase/admin";

export type AuditEntry = {
  startupId: string;
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, Json>;
};

/** Appends to audit_log. Runs as the service role because clients cannot write the log. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  const { error } = await createAdminClient()
    .from("audit_log")
    .insert({
      startup_id: entry.startupId,
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      details: entry.details ?? {},
    });
  if (error) throw new Error(`audit_log insert failed: ${error.message}`);
}
