import { describe, it, expect } from "vitest";
import {
  READ_COOLDOWN_HOURS,
  isOnReadCooldown,
  readCooldownHoursRemaining,
  readCooldownRemainingMs,
} from "./readCooldown";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-05-30T12:00:00Z");

describe("isOnReadCooldown", () => {
  it("returns false when last_read_at is null/undefined", () => {
    expect(isOnReadCooldown(null, NOW)).toBe(false);
    expect(isOnReadCooldown(undefined, NOW)).toBe(false);
  });

  it("returns true inside the window", () => {
    const oneHourAgo = new Date(NOW - HOUR_MS).toISOString();
    expect(isOnReadCooldown(oneHourAgo, NOW)).toBe(true);
  });

  it("returns false at the boundary", () => {
    const boundary = new Date(NOW - READ_COOLDOWN_HOURS * HOUR_MS).toISOString();
    expect(isOnReadCooldown(boundary, NOW)).toBe(false);
  });

  it("returns false past the window", () => {
    const wayBack = new Date(NOW - 48 * HOUR_MS).toISOString();
    expect(isOnReadCooldown(wayBack, NOW)).toBe(false);
  });

  it("returns false for a malformed timestamp", () => {
    expect(isOnReadCooldown("nonsense", NOW)).toBe(false);
  });
});

describe("readCooldownRemainingMs", () => {
  it("returns 0 when there is no last_read_at", () => {
    expect(readCooldownRemainingMs(null, NOW)).toBe(0);
  });

  it("returns the remaining ms inside the window", () => {
    const tenHoursAgo = new Date(NOW - 10 * HOUR_MS).toISOString();
    expect(readCooldownRemainingMs(tenHoursAgo, NOW)).toBe(14 * HOUR_MS);
  });

  it("clamps to 0 past the window", () => {
    const longAgo = new Date(NOW - 100 * HOUR_MS).toISOString();
    expect(readCooldownRemainingMs(longAgo, NOW)).toBe(0);
  });
});

describe("readCooldownHoursRemaining", () => {
  it("returns 0 when no cooldown", () => {
    expect(readCooldownHoursRemaining(null, NOW)).toBe(0);
  });

  it("rounds up sub-hour residue to 1", () => {
    const almostDone = new Date(NOW - (24 * HOUR_MS - 60 * 1000)).toISOString();
    expect(readCooldownHoursRemaining(almostDone, NOW)).toBe(1);
  });

  it("rounds up minute-level residue against a fresh mark", () => {
    const fiveMinutesAgo = new Date(NOW - 5 * 60 * 1000).toISOString();
    // 23h 55m remaining → 24
    expect(readCooldownHoursRemaining(fiveMinutesAgo, NOW)).toBe(24);
  });
});
