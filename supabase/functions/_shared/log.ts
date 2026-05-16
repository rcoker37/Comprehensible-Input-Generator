// Dependency-free structured logging for Edge Functions.
//
// OpenRouter calls only surface through Edge Function logs, so each call emits
// a structured one-line JSON record. `failed` records go to console.error so
// the Supabase log viewer flags them as errors; every line is greppable by the
// `[openrouter]` prefix and filterable by the `event` field. Never throws — a
// logger that can blow up is worse than a missing field.
//
// Lives in its own module (no Supabase-client / env imports) so logging-only
// callers don't drag the rest of `_shared` into their bundle.
export function logOpenRouter(
  event: string,
  fields: Record<string, unknown> = {},
  failed = false,
): void {
  let line: string;
  try {
    line = `[openrouter] ${JSON.stringify({ event, ...fields })}`;
  } catch {
    line = `[openrouter] {"event":${JSON.stringify(event)},"note":"unserializable fields"}`;
  }
  if (failed) console.error(line);
  else console.log(line);
}
