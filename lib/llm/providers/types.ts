import type { z } from "zod";

/**
 * What a call is for. Each provider maps a task to one of its models, so callers never
 * hard-code model ids and switching providers doesn't touch prompt code.
 */
export type LlmTask = "profile" | "drafts" | "scoring" | "classify";

export type JsonRequest = {
  task: LlmTask;
  system: string;
  user: string;
  schema: z.ZodType;
  maxTokens: number;
};

/**
 * One attempt's outcome. "retry" means the model answered but the output was unusable
 * (truncated, not JSON); generateJson decides whether to try again.
 * Providers THROW for API errors (let Inngest retry) and LlmOutputError for refusals.
 */
export type JsonAttempt = { kind: "ok"; value: unknown } | { kind: "retry"; problem: string };

export interface LlmProvider {
  readonly name: string;
  generate(request: JsonRequest): Promise<JsonAttempt>;
}

/**
 * The provider said "too many requests" (HTTP 429). Jobs turn this into Inngest's
 * RetryAfterError so the step waits instead of hammering the API.
 */
export class LlmRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmRateLimitError";
  }
}

/** Why a text is being embedded. Gemini tunes the vector slightly for the purpose. */
export type EmbedPurpose = "similarity";

export class LlmOutputError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = "LlmOutputError";
  }
}
