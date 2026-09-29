"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type CreateResponse = { id: string } | { error: string; details?: { fieldErrors?: Record<string, string[]> } };

export function OnboardingForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/startups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.get("url"), notes: form.get("notes") || undefined }),
      });
      const body = (await res.json()) as CreateResponse;
      if ("id" in body) {
        router.push(`/startups/${body.id}/profile`);
        return;
      }
      setError(body.details?.fieldErrors?.url?.[0] ?? body.error);
    } catch {
      setError("Network error. Please try again.");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="url">Website URL</Label>
        <Input id="url" name="url" required placeholder="https://yourstartup.com" inputMode="url" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          name="notes"
          rows={4}
          maxLength={5000}
          placeholder="Anything the site doesn't say: who your best customers are, what you can offer creators, competitors…"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Starting…" : "Build my profile"}
      </Button>
    </form>
  );
}
