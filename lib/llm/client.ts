import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { serverEnv } from "@/lib/env";

export const MODELS = {
  profile: "claude-sonnet-5-5",
  drafts: "claude-sonnet-5-5",
  scoring: "claude-haiku-4-5",
  classify: "claude-haiku-4-5",
} as const;

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return client;
}

export class LlmOutputError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = "LlmOutputError";
  }
}

type JsonCallArgs<S extends z.ZodType> = {
  model: string;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
};

/**
 * Calls Claude with structured outputs constrained to `schema`, then validates with zod.
 * Retries once if the output is missing, truncated or fails validation.
 * API errors (rate limits, 5xx) are left to the SDK's own retries and the caller (Inngest step).
 */
export async function generateJson<S extends z.ZodType>({
  model,
  system,
  user,
  schema,
  maxTokens = 8000,
}: JsonCallArgs<S>): Promise<z.infer<S>> {
  const maxAttempts = 2;
  let lastProblem = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await anthropic().beta.messages.parse({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: betaZodOutputFormat(schema) },
        // Re-run on Anthropic's recommended model if a safety classifier declines.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      if (response.stop_reason === "refusal") {
        throw new LlmOutputError(
          `Model declined the request (${response.stop_details?.category ?? "unspecified"})`,
          attempt,
        );
      }
      if (response.stop_reason === "max_tokens") {
        lastProblem = "output was truncated (max_tokens)";
        continue;
      }

      const result = schema.safeParse(response.parsed_output);
      if (result.success) return result.data;
      lastProblem = result.error.message;
    } catch (error) {
      if (error instanceof Anthropic.APIError || error instanceof LlmOutputError) throw error;
      // SDK-side JSON/schema parse failure: treat like a validation failure and retry.
      lastProblem = error instanceof Error ? error.message : String(error);
    }
  }

  throw new LlmOutputError(`LLM output failed validation after ${maxAttempts} attempts: ${lastProblem}`, maxAttempts);
}
