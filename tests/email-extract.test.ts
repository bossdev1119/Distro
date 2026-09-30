import { describe, expect, it } from "vitest";
import { deobfuscate, extractBusinessEmail } from "@/lib/discovery/email-extract";

describe("extractBusinessEmail", () => {
  it("finds a plain email", () => {
    expect(extractBusinessEmail("Contact me: Jane.Doe@Gmail.com")).toBe("jane.doe@gmail.com");
  });

  it("prefers the email labelled for business", () => {
    const text = "Fan mail: fans@creator.tv\nBusiness inquiries: deals@creator.tv";
    expect(extractBusinessEmail(text)).toBe("deals@creator.tv");
  });

  it("reads [at] / (dot) spellings", () => {
    expect(extractBusinessEmail("email me at hello [at] studio (dot) com")).toBe("hello@studio.com");
  });

  it("drops a trailing sentence period", () => {
    expect(extractBusinessEmail("Write to team@brand.io.")).toBe("team@brand.io");
  });

  it("ignores placeholder and no-reply addresses", () => {
    expect(extractBusinessEmail("you@example.com or noreply@brand.io")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractBusinessEmail("")).toBeNull();
    expect(extractBusinessEmail(null)).toBeNull();
  });
});

describe("deobfuscate", () => {
  it("rewrites common anti-spam patterns", () => {
    expect(deobfuscate("name (at) site [dot] com")).toBe("name@site.com");
  });
});
