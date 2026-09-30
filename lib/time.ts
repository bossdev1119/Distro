// YouTube's daily quota resets at midnight Pacific time, not UTC or your local time.
const PACIFIC = "America/Los_Angeles";

/** Today's date in Pacific time as "YYYY-MM-DD" (the key for quota_usage.day). */
export function pacificDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Pacific's offset from UTC in minutes at `instant` (-420 in summer, -480 in winter). */
function pacificOffsetMinutes(instant: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT-07:00"
  const match = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The next midnight in Pacific time, as a UTC Date. Handles daylight-saving changes. */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const [y, m, d] = pacificDate(now).split("-").map(Number);
  // Midnight of the next Pacific day, first guessed with today's offset, then corrected.
  const guess = new Date(Date.UTC(y, m - 1, d + 1) - pacificOffsetMinutes(now) * 60_000);
  return new Date(Date.UTC(y, m - 1, d + 1) - pacificOffsetMinutes(guess) * 60_000);
}

export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
