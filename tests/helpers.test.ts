import { describe, expect, it } from "vitest";
import { buildContextText } from "@/lib/analysis/context";
import { chunk, unique } from "@/lib/array";
import { nextPacificMidnight, pacificDate } from "@/lib/time";

describe("chunk", () => {
  it("splits into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns no groups for an empty list", () => {
    expect(chunk([], 50)).toEqual([]);
  });
  it("rejects a size below 1", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("unique", () => {
  it("keeps the first occurrence", () => {
    expect(unique(["b", "a", "b"])).toEqual(["b", "a"]);
  });
});

describe("Pacific time (YouTube quota day)", () => {
  it("uses the Pacific date, not UTC", () => {
    // 2026-07-01 03:00 UTC is still June 30 in California (UTC-7 in summer).
    expect(pacificDate(new Date("2026-07-01T03:00:00Z"))).toBe("2026-06-30");
  });
  it("finds the next midnight in summer (UTC-7)", () => {
    expect(nextPacificMidnight(new Date("2026-07-01T03:00:00Z")).toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });
  it("finds the next midnight in winter (UTC-8)", () => {
    expect(nextPacificMidnight(new Date("2026-01-15T20:00:00Z")).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });
  it("handles the night clocks change (DST ends Nov 1 2026)", () => {
    // Oct 31, 22:00 PDT → next midnight is Nov 1 00:00 PDT (still UTC-7) = 07:00Z.
    expect(nextPacificMidnight(new Date("2026-11-01T05:00:00Z")).toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });
});

describe("buildContextText", () => {
  it("includes topic fields and leaves out outreach fields", () => {
    const text = buildContextText({
      one_liner: "Invoices for freelancers",
      problem: "Clients pay late",
      icp: "Solo designers",
      use_cases: ["send invoices", "chase payments"],
      competitors: ["Wave"],
      tone: "friendly",
      keywords: ["invoice", "freelance"],
      creator_offer: "20% affiliate",
    });
    expect(text).toContain("Clients pay late");
    expect(text).toContain("send invoices; chase payments");
    expect(text).not.toContain("20% affiliate");
    expect(text).not.toContain("friendly");
  });
});
