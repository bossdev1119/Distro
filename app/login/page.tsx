import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Distro</CardTitle>
          <CardDescription>We&apos;ll email you a magic link. No password needed.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm
            next={typeof next === "string" ? next : undefined}
            error={typeof error === "string" ? error : undefined}
          />
        </CardContent>
      </Card>
    </main>
  );
}
