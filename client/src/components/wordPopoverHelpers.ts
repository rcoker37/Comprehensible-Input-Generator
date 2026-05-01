import type { ChatMessage } from "../types";

export interface AskPair {
  q: ChatMessage | null;
  a: ChatMessage | null;
}

// Pair a chip thread's messages for display. The first user turn is the
// chip-prompt seed and is hidden from the UI; if the assistant replied,
// that reply is emitted as a leading assistant-only pair (q: null).
// Subsequent turns (legacy follow-ups; no UI to add new ones) pair as
// usual. A trailing unpaired user turn renders alone.
export function pairThreadMessages(messages: ChatMessage[]): AskPair[] {
  const pairs: AskPair[] = [];
  let i = 0;

  if (messages.length > 0) {
    const second = messages[1];
    if (second?.role === "assistant") {
      pairs.push({ q: null, a: second });
      i = 2;
    } else {
      i = 1;
    }
  }

  for (; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === "user") {
      const next = messages[i + 1];
      const a = next && next.role === "assistant" ? next : null;
      pairs.push({ q: msg, a });
      if (a) i++;
    }
  }
  return pairs;
}
