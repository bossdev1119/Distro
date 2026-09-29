import "server-only";
import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { LlmOutputError, type JsonAttempt, type JsonRequest, type LlmProvider, type LlmTask } from "./types";

let client: GoogleGenAI | undefined;

function gemini(): GoogleGenAI {
  const apiKey = serverEnv().GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

/** "-latest" aliases track Google's current Flash models, so they don't break when versions retire. */
function modelFor(task: LlmTask): string {
  const env = serverEnv();
  return task === "profile" || task === "drafts" ? env.GEMINI_MODEL : env.GEMINI_FAST_MODEL;
}

/** zod → JSON Schema for Gemini's responseJsonSchema. Drops the "$schema" meta key it doesn't need. */
function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const geminiProvider: LlmProvider = {
  name: "gemini",

  async generate({ task, system, user, schema, maxTokens }: JsonRequest): Promise<JsonAttempt> {
    const request = (model: string) =>
      gemini().models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          // Structured output: the reply must be JSON matching this schema.
          responseMimeType: "application/json",
          responseJsonSchema: toGeminiSchema(schema),
          maxOutputTokens: maxTokens,
        },
      });

    const model = modelFor(task);
    const fallback = serverEnv().GEMINI_FAST_MODEL;
    let response;
    try {
      response = await request(model);
    } catch (error) {
      // Free-tier models are often briefly overloaded (503). Fall back to the lighter model once;
      // any other API error (or a failing fallback) propagates so the Inngest step retries.
      if (!(error instanceof ApiError) || error.status !== 503 || model === fallback) throw error;
      response = await request(fallback);
    }

    const blocked = response.promptFeedback?.blockReason;
    const finish = response.candidates?.[0]?.finishReason;
    if (blocked || finish === FinishReason.SAFETY) {
      throw new LlmOutputError(`Model declined the request (${blocked ?? finish})`, 1);
    }
    if (finish === FinishReason.MAX_TOKENS) {
      return { kind: "retry", problem: "output was truncated (MAX_TOKENS)" };
    }

    const text = response.text;
    if (!text) return { kind: "retry", problem: `empty response (finishReason=${finish ?? "unknown"})` };
    try {
      return { kind: "ok", value: JSON.parse(text) as unknown };
    } catch {
      return { kind: "retry", problem: "response was not valid JSON" };
    }
  },
};
