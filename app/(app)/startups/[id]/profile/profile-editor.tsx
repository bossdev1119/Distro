"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ProfileStatus, StartupStatusResponse } from "@/lib/db/types";
import { startupProfileSchema, type StartupProfile } from "@/lib/llm/schemas";

const POLL_MS = 2000;
const IN_PROGRESS: ProfileStatus[] = ["pending", "building"];

type TextField = "one_liner" | "problem" | "icp" | "tone" | "creator_offer";
type ListField = "use_cases" | "competitors" | "keywords";

// List fields are edited as one item per line.
type FormState = Record<TextField | ListField, string>;

const TEXT_FIELDS: { key: TextField; label: string; multiline: boolean; hint?: string }[] = [
  { key: "one_liner", label: "One-liner", multiline: false },
  { key: "problem", label: "Problem", multiline: true },
  { key: "icp", label: "Ideal customer (ICP)", multiline: true },
  { key: "tone", label: "Tone", multiline: false, hint: "How your outreach should sound." },
  { key: "creator_offer", label: "Offer for creators", multiline: true, hint: "What you'll give creators who feature you." },
];

const LIST_FIELDS: { key: ListField; label: string }[] = [
  { key: "use_cases", label: "Use cases" },
  { key: "keywords", label: "Keywords" },
  { key: "competitors", label: "Competitors" },
];

function toForm(p: StartupProfile): FormState {
  return {
    one_liner: p.one_liner,
    problem: p.problem,
    icp: p.icp,
    tone: p.tone,
    creator_offer: p.creator_offer,
    use_cases: p.use_cases.join("\n"),
    keywords: p.keywords.join("\n"),
    competitors: p.competitors.join("\n"),
  };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function fromForm(f: FormState) {
  return startupProfileSchema.safeParse({
    one_liner: f.one_liner.trim(),
    problem: f.problem.trim(),
    icp: f.icp.trim(),
    tone: f.tone.trim(),
    creator_offer: f.creator_offer.trim(),
    use_cases: lines(f.use_cases),
    keywords: lines(f.keywords),
    competitors: lines(f.competitors),
  });
}

/** Polls the startup while the build-profile job runs; stops once it settles. */
function useStartupStatus(initial: StartupStatusResponse): StartupStatusResponse {
  const [startup, setStartup] = useState(initial);
  const inProgress = IN_PROGRESS.includes(startup.profile_status);

  useEffect(() => {
    if (!inProgress) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/startups/${initial.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as StartupStatusResponse;
        if (!cancelled) setStartup(next);
      } catch {
        // Transient network error; keep polling.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [inProgress, initial.id]);

  return startup;
}

export function ProfileEditor({ initial }: { initial: StartupStatusResponse }) {
  const startup = useStartupStatus(initial);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{startup.name ?? startup.url}</h1>
          <a href={startup.url} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground hover:underline">
            {startup.url}
          </a>
        </div>
        <Badge variant={startup.profile_status === "failed" ? "destructive" : "secondary"}>{startup.profile_status}</Badge>
      </div>

      {IN_PROGRESS.includes(startup.profile_status) && (
        <Card>
          <CardHeader>
            <CardTitle>Building your profile…</CardTitle>
            <CardDescription>
              Reading your homepage, pricing and about pages, then drafting a profile. This usually takes under a
              minute. You can leave this page open.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {startup.profile_status === "failed" && (
        <Card>
          <CardHeader>
            <CardTitle>We couldn&apos;t build the profile</CardTitle>
            <CardDescription className="break-words">{startup.profile_error ?? "Unknown error."}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {startup.profile_json && (startup.profile_status === "ready" || startup.profile_status === "confirmed") && (
        <ProfileForm
          startupId={startup.id}
          profile={startup.profile_json}
          confirmed={startup.profile_status === "confirmed"}
        />
      )}
    </div>
  );
}

function ProfileForm({
  startupId,
  profile,
  confirmed: initiallyConfirmed,
}: {
  startupId: string;
  profile: StartupProfile;
  confirmed: boolean;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(profile));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState<"save" | "confirm" | null>(null);
  const [confirmed, setConfirmed] = useState(initiallyConfirmed);

  function update(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function submit(mode: "save" | "confirm") {
    const parsed = fromForm(form);
    if (!parsed.success) {
      const fieldErrors: Partial<Record<keyof FormState, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormState;
        fieldErrors[key] ??= issue.code === "too_small" ? "Required" : issue.message;
      }
      setErrors(fieldErrors);
      toast.error("Please fill in the highlighted fields.");
      return;
    }

    setSaving(mode);
    try {
      const res = await fetch(`/api/startups/${startupId}/profile`, {
        method: mode === "confirm" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: parsed.data }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      if (mode === "confirm") {
        setConfirmed(true);
        toast.success("Profile confirmed. Next up: finding where your customers hang out.");
      } else {
        toast.success("Saved.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Product profile</CardTitle>
        <CardDescription>
          Review and edit what we inferred. This drives channel mapping, creator scoring and outreach drafts.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {TEXT_FIELDS.map(({ key, label, multiline, hint }) => (
          <div key={key} className="flex flex-col gap-2">
            <Label htmlFor={key}>{label}</Label>
            {multiline ? (
              <Textarea
                id={key}
                rows={3}
                value={form[key]}
                onChange={(e) => update(key, e.target.value)}
                aria-invalid={Boolean(errors[key])}
              />
            ) : (
              <Input id={key} value={form[key]} onChange={(e) => update(key, e.target.value)} aria-invalid={Boolean(errors[key])} />
            )}
            {errors[key] ? (
              <p className="text-xs text-destructive">{errors[key]}</p>
            ) : (
              hint && <p className="text-xs text-muted-foreground">{hint}</p>
            )}
          </div>
        ))}
        <div className="grid gap-5 sm:grid-cols-3">
          {LIST_FIELDS.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-2">
              <Label htmlFor={key}>{label}</Label>
              <Textarea
                id={key}
                rows={7}
                value={form[key]}
                onChange={(e) => update(key, e.target.value)}
                aria-invalid={Boolean(errors[key])}
              />
              <p className={errors[key] ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {errors[key] ?? "One per line."}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => submit("save")} disabled={saving !== null}>
          {saving === "save" ? "Saving…" : "Save draft"}
        </Button>
        <Button onClick={() => submit("confirm")} disabled={saving !== null}>
          {saving === "confirm" ? "Confirming…" : confirmed ? "Save & re-confirm" : "Confirm profile"}
        </Button>
      </CardFooter>
    </Card>
  );
}
