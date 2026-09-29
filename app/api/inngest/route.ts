import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/jobs";

// Jobs call Claude and fetch pages; give them room beyond the default function timeout.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
