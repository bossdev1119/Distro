import "server-only";
import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { QuotaExhaustedError } from "@/lib/quota";
import {
  LlmOutputError,
  LlmRateLimitError,
  type EmbedPurpose,
  type JsonAttempt,
  type JsonRequest,
  type LlmProvider,
  type LlmTask,
} from "./types";

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

/** Free-tier limits are per minute, so waiting a minute is usually enough. */
const RATE_LIMIT_WAIT_MS = 60_000;

/** Gemini errors embed a JSON blob; keep just its human-readable first sentence for the UI. */
function briefMessage(error: ApiError): string {
  const message = error.message.match(/"message":\s*"([^"]+)"/)?.[1] ?? error.message;
  return message.split(/\.\s|\\n/)[0].slice(0, 200);
}

/**
 * Maps Gemini's 429 to the right error:
 * - a per-DAY limit (quotaId contains "PerDay") → QuotaExhaustedError: pause until midnight Pacific
 * - a per-minute limit → LlmRateLimitError: wait a minute and retry
 * Every other error passes through unchanged.
 */
function asRateLimit(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 429) return error;
  if (/PerDay/i.test(error.message)) {
    return new QuotaExhaustedError(`Gemini free-tier daily limit reached (${briefMessage(error)}); continuing after midnight Pacific time`);
  }
  return new LlmRateLimitError(`Gemini rate limit: ${briefMessage(error)}`, RATE_LIMIT_WAIT_MS, { cause: error });
}

/** Gemini accepts up to 100 texts per embedding request. */
export const GEMINI_EMBED_BATCH = 100;

/**
 * Embeds up to GEMINI_EMBED_BATCH texts in one call. Returns one vector per text, in order.
 * Vectors are shortened to `dimensions` (Matryoshka embeddings: the first N numbers still work).
 */
export async function geminiEmbed(texts: string[], dimensions: number, purpose: EmbedPurpose): Promise<number[][]> {
  if (texts.length > GEMINI_EMBED_BATCH) throw new Error(`geminiEmbed: max ${GEMINI_EMBED_BATCH} texts per call`);
  let response;
  try {
    response = await gemini().models.embedContent({
      model: serverEnv().GEMINI_MODEL_EMBED,
      contents: texts,
      config: {
        outputDimensionality: dimensions,
        taskType: purpose === "similarity" ? "SEMANTIC_SIMILARITY" : undefined,
      },
    });
  } catch (error) {
    throw asRateLimit(error);
  }
  const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => v.length !== dimensions)) {
    throw new Error(`Gemini returned ${vectors.length} embeddings for ${texts.length} texts (expected ${dimensions} dims each)`);
  }
  return vectors;
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
      try {
        response = await request(model);
      } catch (error) {
        // Free-tier models are often briefly overloaded (503). Fall back to the lighter model once;
        // any other API error (or a failing fallback) propagates so the Inngest step retries.
        if (!(error instanceof ApiError) || error.status !== 503 || model === fallback) throw error;
        response = await request(fallback);
      }
    } catch (error) {
      throw asRateLimit(error);
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
