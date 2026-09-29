import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";

export function jsonError(message: string, status: number, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status });
}

/** Parses a JSON request body against a zod schema. Returns an error response on failure. */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ data: z.infer<S> } | { response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { response: jsonError("Body must be JSON", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { response: jsonError("Invalid request", 400, parsed.error.flatten()) };
  }
  return { data: parsed.data };
}
