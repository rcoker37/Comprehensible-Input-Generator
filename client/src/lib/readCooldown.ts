// A row can only be marked read once per 24h window. The cooldown is
// enforced server-side by mark_story_read / mark_chat_message_read (the
// UPDATE no-ops when last_read_at is within the window) — this client-side
// mirror drives the button disabled state and zeroes the +X score preview
// so the UI matches the server's behavior without an extra round trip.

export const READ_COOLDOWN_HOURS = 24;
export const READ_COOLDOWN_MS = READ_COOLDOWN_HOURS * 60 * 60 * 1000;

export function isOnReadCooldown(
  lastReadAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!lastReadAt) return false;
  const t = Date.parse(lastReadAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t < READ_COOLDOWN_MS;
}

export function readCooldownRemainingMs(
  lastReadAt: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!lastReadAt) return 0;
  const t = Date.parse(lastReadAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t + READ_COOLDOWN_MS - nowMs);
}

// Rounded up to the nearest hour, with a 1h floor whenever any time
// remains — used to phrase button titles like "Available again in 3h".
export function readCooldownHoursRemaining(
  lastReadAt: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  const ms = readCooldownRemainingMs(lastReadAt, nowMs);
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
}
