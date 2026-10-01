import "server-only";
import path from "node:path";
import { env as hfEnv, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Runs an open-source embedding model ON THIS MACHINE (CPU) with Transformers.js.
// No API key, no quota, no cost. The model downloads once (~110 MB) into .cache/transformers.
//
// bge-base-en-v1.5 outputs 768 numbers — the same size as our vector(768) columns.
// "q8" = 8-bit quantized weights: measured ~1.6× faster than full precision with nearly
// identical scores (average difference 0.007 on 200 real videos).

const DTYPE = "q8";
const BATCH = 32; // texts per forward pass: bigger is faster per text but uses more memory

hfEnv.cacheDir = path.join(process.cwd(), ".cache", "transformers");

// Loading the model takes seconds, so do it once per process. Kept on globalThis so
// `next dev` hot reloads don't load a second copy into memory.
const globalCache = globalThis as unknown as { __localEmbedder?: Promise<FeatureExtractionPipeline> };

function embedder(model: string): Promise<FeatureExtractionPipeline> {
  globalCache.__localEmbedder ??= pipeline("feature-extraction", model, { dtype: DTYPE });
  return globalCache.__localEmbedder;
}

/** Stable id stored with each vector (embedding_model column), e.g. "Xenova/bge-base-en-v1.5@q8". */
export function localModelId(model: string): string {
  return `${model}@${DTYPE}`;
}

/**
 * Embeds texts locally. Vectors are normalized (length 1), so cosine similarity = dot product.
 * bge models use the [CLS] token's vector as the sentence embedding ("cls" pooling).
 */
export async function localEmbed(texts: string[], model: string, dimensions: number): Promise<number[][]> {
  const extractor = await embedder(model);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const output = await extractor(texts.slice(i, i + BATCH), { pooling: "cls", normalize: true });
    vectors.push(...(output.tolist() as number[][]));
  }
  if (vectors.some((v) => v.length !== dimensions)) {
    throw new Error(`${model} returned ${vectors[0]?.length} dims; the database expects ${dimensions}. Pick a ${dimensions}-dim model or change the migration.`);
  }
  return vectors;
}
