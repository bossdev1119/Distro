import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { serverEnv } from "@/lib/env";
import { LlmOutputError, LlmRateLimitError, type JsonAttempt, type JsonRequest, type LlmProvider, type LlmTask } from "./types";

const MODELS: Record<LlmTask, string> = {
  profile: "claude-sonnet-5-5",
  drafts: "claude-sonnet-5-5",
  scoring: "claude-haiku-4-5",
  classify: "claude-haiku-4-5",
};

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  const apiKey = serverEnv().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({ apiKey });
  return client;
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",

  async generate({ task, system, user, schema, maxTokens }: JsonRequest): Promise<JsonAttempt> {
    let response;
    try {
      response = await anthropic().beta.messages.parse({
        model: MODELS[task],
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        // Structured outputs: the reply is constrained to this JSON schema.
        output_config: { format: betaZodOutputFormat(schema) },
        // Re-run on Anthropic's recommended model if a safety classifier declines.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new LlmRateLimitError(`Anthropic rate limit: ${error.message}`, 60_000, { cause: error });
      }
      if (error instanceof Anthropic.APIError) throw error;
      // SDK-side JSON/schema parse failure: the model answered, but badly.
      return { kind: "retry", problem: error instanceof Error ? error.message : String(error) };
    }

    if (response.stop_reason === "refusal") {
      throw new LlmOutputError(`Model declined the request (${response.stop_details?.category ?? "unspecified"})`, 1);
    }
    if (response.stop_reason === "max_tokens") {
      return { kind: "retry", problem: "output was truncated (max_tokens)" };
    }
    return { kind: "ok", value: response.parsed_output };
  },
};
