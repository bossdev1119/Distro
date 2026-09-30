"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Creates (or reopens) the startup's campaign and goes to its creators page. */
export function FindCreatorsButton({ startupId, disabled }: { startupId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startupId }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `Request failed (${res.status})`);
      router.push(`/campaigns/${body.id}/creators`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <Button variant="secondary" onClick={onClick} disabled={disabled || pending} className="mr-auto">
      {pending ? "Opening…" : "Find creators →"}
    </Button>
  );
}
