// A row can only be marked read on a schedule: 24h between reads 1→2,
// and 7 days between reads 2→3 (the cap). The server enforces this in
// the same WHERE-clause predicate used by mark_story_read /
// mark_chat_message_read / mark_chat_read — this client-side mirror
// drives the button disabled state and zeroes the +X score preview so
// the UI matches the server's behavior without an extra round trip.

export const MAX_READ_COUNT = 3;
export const READ_COOLDOWN_SHORT_HOURS = 24;
export const READ_COOLDOWN_LONG_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The cooldown that gates the *next* mark, given the current read_count.
// At count 0 a fresh row has no last_read_at so the value is moot — we
// return the short window for symmetry. At count >= MAX_READ_COUNT
// there is no next mark; the button locks at cap independently.
export function cooldownMsForCount(readCount: number): number {
  return readCount >= 2 ? READ_COOLDOWN_LONG_DAYS * DAY_MS : READ_COOLDOWN_SHORT_HOURS * HOUR_MS;
}

export function isOnReadCooldown(
  lastReadAt: string | null | undefined,
  readCount: number,
  nowMs: number = Date.now(),
): boolean {
  if (!lastReadAt) return false;
  const t = Date.parse(lastReadAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t < cooldownMsForCount(readCount);
}

export function readCooldownRemainingMs(
  lastReadAt: string | null | undefined,
  readCount: number,
  nowMs: number = Date.now(),
): number {
  if (!lastReadAt) return 0;
  const t = Date.parse(lastReadAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t + cooldownMsForCount(readCount) - nowMs);
}

// Human-readable "available again in …" phrasing. Uses days when the
// remaining window is at least a day, otherwise hours (rounded up, with
// a 1h floor whenever any time remains).
export function readCooldownLabel(
  lastReadAt: string | null | undefined,
  readCount: number,
  nowMs: number = Date.now(),
): string {
  const ms = readCooldownRemainingMs(lastReadAt, readCount, nowMs);
  if (ms <= 0) return "";
  if (ms >= DAY_MS) {
    const days = Math.max(1, Math.ceil(ms / DAY_MS));
    return `${days}d`;
  }
  const hours = Math.max(1, Math.ceil(ms / HOUR_MS));
  return `${hours}h`;
}
