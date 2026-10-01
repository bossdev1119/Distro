import "server-only";
import { z } from "zod";

const serverEnvSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SUPABASE_SECRET_KEY: z.string().min(1),
    // Which LLM answers generateJson(). Only the chosen provider's key is required.
    LLM_PROVIDER: z.enum(["gemini", "anthropic"]).default("gemini"),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().min(1).default("gemini-flash-latest"),
    GEMINI_FAST_MODEL: z.string().min(1).default("gemini-flash-lite-latest"),
    // Embeddings: "local" runs an open-source model on this machine (free, no quota);
    // "gemini" uses the API (free tier: 1,000 texts/day). Both produce 768-dim vectors.
    EMBED_PROVIDER: z.enum(["local", "gemini"]).default("local"),
    LOCAL_EMBED_MODEL: z.string().min(1).default("Xenova/bge-base-en-v1.5"),
    GEMINI_MODEL_EMBED: z.string().min(1).default("gemini-embedding-001"),
    YOUTUBE_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    JINA_API_KEY: z.string().optional(),
    NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
  })
  .superRefine((env, ctx) => {
    const keyName = env.LLM_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    if (!env[keyName]) {
      ctx.addIssue({ code: "custom", path: [keyName], message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}` });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Validated server-side environment. Throws on first use if anything required is missing. */
export function serverEnv(): ServerEnv {
  if (!cached) {
    // Treat empty values (KEY=) as unset so defaults and "required" checks behave.
    const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
    const parsed = serverEnvSchema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ");
      throw new Error(`Invalid or missing environment variables: ${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}
