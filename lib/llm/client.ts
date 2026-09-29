import "server-only";
import type { z } from "zod";
import { serverEnv } from "@/lib/env";
import { anthropicProvider } from "./providers/anthropic";
import { geminiProvider } from "./providers/gemini";
import { LlmOutputError, type LlmProvider, type LlmTask } from "./providers/types";

export { LlmOutputError, type LlmTask };

const PROVIDERS: Record<"anthropic" | "gemini", LlmProvider> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

/** The provider chosen by LLM_PROVIDER in .env.local. */
function provider(): LlmProvider {
  return PROVIDERS[serverEnv().LLM_PROVIDER];
}

type JsonCallArgs<S extends z.ZodType> = {
  task: LlmTask;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
};

/**
 * Asks the configured LLM for JSON matching `schema`, then validates it with zod.
 * Retries once if the output is missing, truncated or fails validation.
 * API errors (rate limits, 5xx) propagate to the caller (the Inngest step retries them).
 */
export async function generateJson<S extends z.ZodType>({
  task,
  system,
  user,
  schema,
  maxTokens = 16000,
}: JsonCallArgs<S>): Promise<z.infer<S>> {
  const maxAttempts = 2;
  const llm = provider();
  let lastProblem = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await llm.generate({ task, system, user, schema, maxTokens });
    if (result.kind === "retry") {
      lastProblem = result.problem;
      continue;
    }
    const parsed = schema.safeParse(result.value);
    if (parsed.success) return parsed.data;
    lastProblem = parsed.error.message;
  }

  throw new LlmOutputError(
    `${llm.name} output failed validation after ${maxAttempts} attempts: ${lastProblem}`,
    maxAttempts,
  );
}
