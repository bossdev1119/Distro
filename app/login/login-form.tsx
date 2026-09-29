"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm({ next, error }: { next?: string; error?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, {
    status: error ? "error" : "idle",
    message: error,
  });

  if (state.status === "sent") {
    return <p className="text-sm text-muted-foreground">{state.message}</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next ?? "/"} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@startup.com" />
      </div>
      {state.status === "error" && <p className="text-sm text-destructive">{state.message}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send magic link"}
      </Button>
    </form>
  );
}
