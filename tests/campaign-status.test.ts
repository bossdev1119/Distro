import { describe, expect, it } from "vitest";
import { canStartSearch, isStuck } from "@/lib/campaign-status";

const now = new Date("2026-10-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

describe("isStuck", () => {
  it("is false for a running stage that updated recently", () => {
    expect(isStuck({ stage: "scoring_relevance", updated_at: minutesAgo(5), resume_at: null }, now)).toBe(false);
  });
  it("is true for a running stage with no update for over 30 minutes", () => {
    expect(isStuck({ stage: "scoring_relevance", updated_at: minutesAgo(45), resume_at: null }, now)).toBe(true);
  });
  it("is false while a quota pause is still waiting for its resume time", () => {
    expect(isStuck({ stage: "paused_quota", updated_at: minutesAgo(600), resume_at: minutesAgo(-120) }, now)).toBe(false);
  });
  it("is true when a quota pause is long past its resume time (Inngest was restarted)", () => {
    expect(isStuck({ stage: "paused_quota", updated_at: minutesAgo(600), resume_at: minutesAgo(40) }, now)).toBe(true);
  });
  it("is never true for done or failed", () => {
    expect(isStuck({ stage: "done", updated_at: minutesAgo(9999), resume_at: null }, now)).toBe(false);
  });
});

describe("canStartSearch", () => {
  it("allows review, done, failed and stuck runs, but not a healthy running one", () => {
    expect(canStartSearch({ stage: "awaiting_queries", updated_at: minutesAgo(1), resume_at: null }, now)).toBe(true);
    expect(canStartSearch({ stage: "failed", updated_at: minutesAgo(1), resume_at: null }, now)).toBe(true);
    expect(canStartSearch({ stage: "searching", updated_at: minutesAgo(1), resume_at: null }, now)).toBe(false);
    expect(canStartSearch({ stage: "searching", updated_at: minutesAgo(31), resume_at: null }, now)).toBe(true);
  });
});
