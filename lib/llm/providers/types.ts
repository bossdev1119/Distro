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

export class LlmOutputError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = "LlmOutputError";
  }
}
