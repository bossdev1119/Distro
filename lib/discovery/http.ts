import "server-only";

// Shared by every platform module: GET a JSON API with retries and exponential backoff.

export type HttpResult = { status: number; body: unknown };

type RetryOptions = {
  /** Attempts in total, including the first. */
  attempts?: number;
  /** First wait; doubles each retry (1s, 2s, 4s...) plus random jitter. */
  baseDelayMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs `url` and parses JSON. Retries network errors and 408/429/5xx with backoff.
 * Returns the final status and body — including 4xx — so the platform module can decide
 * what an error means (e.g. YouTube's 403 "quotaExceeded"). Throws only when every retry failed.
 */
export async function getJsonWithRetry(url: string, options: RetryOptions = {}): Promise<HttpResult> {
  const { attempts = 3, baseDelayMs = 1000, timeoutMs = 20_000 } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!RETRYABLE.has(response.status) || attempt === attempts) {
        return { status: response.status, body };
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error; // network error or timeout
    }
    // Jitter spreads retries out so many workers don't all retry at the same instant.
    await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 250);
  }
  throw new Error(`Request failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
