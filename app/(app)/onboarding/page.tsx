import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OnboardingForm } from "./onboarding-form";

export default function OnboardingPage() {
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardHeader>
        <CardTitle>Let&apos;s find your distribution</CardTitle>
        <CardDescription>
          Paste your startup&apos;s website. We&apos;ll read your homepage, pricing and about pages and draft a
          product profile you can edit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <OnboardingForm />
      </CardContent>
    </Card>
  );
}
