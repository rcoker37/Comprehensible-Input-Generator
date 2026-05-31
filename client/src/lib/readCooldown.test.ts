import { describe, it, expect } from "vitest";
import {
  READ_COOLDOWN_SHORT_HOURS,
  READ_COOLDOWN_LONG_DAYS,
  isOnReadCooldown,
  readCooldownLabel,
  readCooldownRemainingMs,
} from "./readCooldown";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2026-05-30T12:00:00Z");

describe("isOnReadCooldown", () => {
  it("returns false when last_read_at is null/undefined", () => {
    expect(isOnReadCooldown(null, 0, NOW)).toBe(false);
    expect(isOnReadCooldown(undefined, 1, NOW)).toBe(false);
  });

  it("uses the 24h window when read_count < 2", () => {
    const oneHourAgo = new Date(NOW - HOUR_MS).toISOString();
    const twentyThreeHoursAgo = new Date(NOW - 23 * HOUR_MS).toISOString();
    const twentyFiveHoursAgo = new Date(NOW - 25 * HOUR_MS).toISOString();
    expect(isOnReadCooldown(oneHourAgo, 1, NOW)).toBe(true);
    expect(isOnReadCooldown(twentyThreeHoursAgo, 1, NOW)).toBe(true);
    expect(isOnReadCooldown(twentyFiveHoursAgo, 1, NOW)).toBe(false);
  });

  it("uses the 7-day window when read_count >= 2", () => {
    const twoDaysAgo = new Date(NOW - 2 * DAY_MS).toISOString();
    const sixDaysAgo = new Date(NOW - 6 * DAY_MS).toISOString();
    const eightDaysAgo = new Date(NOW - 8 * DAY_MS).toISOString();
    expect(isOnReadCooldown(twoDaysAgo, 2, NOW)).toBe(true);
    expect(isOnReadCooldown(sixDaysAgo, 2, NOW)).toBe(true);
    expect(isOnReadCooldown(eightDaysAgo, 2, NOW)).toBe(false);
  });

  it("returns false at the boundary", () => {
    const shortBoundary = new Date(NOW - READ_COOLDOWN_SHORT_HOURS * HOUR_MS).toISOString();
    const longBoundary = new Date(NOW - READ_COOLDOWN_LONG_DAYS * DAY_MS).toISOString();
    expect(isOnReadCooldown(shortBoundary, 1, NOW)).toBe(false);
    expect(isOnReadCooldown(longBoundary, 2, NOW)).toBe(false);
  });

  it("returns false for a malformed timestamp", () => {
    expect(isOnReadCooldown("nonsense", 1, NOW)).toBe(false);
  });
});

describe("readCooldownRemainingMs", () => {
  it("returns 0 when there is no last_read_at", () => {
    expect(readCooldownRemainingMs(null, 1, NOW)).toBe(0);
  });

  it("returns the remaining ms inside the 24h window", () => {
    const tenHoursAgo = new Date(NOW - 10 * HOUR_MS).toISOString();
    expect(readCooldownRemainingMs(tenHoursAgo, 1, NOW)).toBe(14 * HOUR_MS);
  });

  it("returns the remaining ms inside the 7d window", () => {
    const twoDaysAgo = new Date(NOW - 2 * DAY_MS).toISOString();
    expect(readCooldownRemainingMs(twoDaysAgo, 2, NOW)).toBe(5 * DAY_MS);
  });

  it("clamps to 0 past the window", () => {
    const longAgo = new Date(NOW - 100 * DAY_MS).toISOString();
    expect(readCooldownRemainingMs(longAgo, 2, NOW)).toBe(0);
  });
});

describe("readCooldownLabel", () => {
  it("returns empty string when no cooldown", () => {
    expect(readCooldownLabel(null, 1, NOW)).toBe("");
  });

  it("formats hours when under a day remains", () => {
    const fiveMinutesAgo = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(readCooldownLabel(fiveMinutesAgo, 1, NOW)).toBe("24h");
  });

  it("rounds up sub-hour residue to 1h", () => {
    const almostDone = new Date(NOW - (24 * HOUR_MS - 60 * 1000)).toISOString();
    expect(readCooldownLabel(almostDone, 1, NOW)).toBe("1h");
  });

  it("formats days when at least a day remains", () => {
    const oneDayAgo = new Date(NOW - DAY_MS).toISOString();
    expect(readCooldownLabel(oneDayAgo, 2, NOW)).toBe("6d");
  });
});
