import "server-only";
import type { z } from "zod";
import { serverEnv } from "@/lib/env";
import { DISCOVERY } from "@/lib/config";
import { chunk } from "@/lib/array";
import { QUOTA, reserveQuota } from "@/lib/quota";
import { anthropicProvider } from "./providers/anthropic";
import { GEMINI_EMBED_BATCH, geminiEmbed, geminiProvider } from "./providers/gemini";
import { LlmOutputError, LlmRateLimitError, type LlmProvider, type LlmTask } from "./providers/types";

export { LlmOutputError, LlmRateLimitError, type LlmTask };

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

/**
 * Turns text into a vector (a list of DISCOVERY.embeddingDimensions numbers) whose direction
 * captures its meaning. Similar meanings → vectors pointing the same way (high cosine similarity).
 * Always uses Gemini: Anthropic has no embeddings API.
 */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);
  return vector;
}

/**
 * Embeds many texts, batching them into as few API calls as possible. Order is preserved.
 * Each text counts against Gemini's free daily limit, so it's reserved first; when the budget
 * is used up this throws QuotaExhaustedError and jobs pause until tomorrow.
 */
export async function embedMany(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const batch of chunk(texts, GEMINI_EMBED_BATCH)) {
    await reserveQuota(QUOTA.geminiEmbed, batch.length, DISCOVERY.geminiEmbedDailyStop);
    vectors.push(...(await geminiEmbed(batch, DISCOVERY.embeddingDimensions, "similarity")));
  }
  return vectors;
}

/** pgvector accepts vectors as text like "[0.1,0.2,0.3]". */
export function toPgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
