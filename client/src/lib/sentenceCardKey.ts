// Identity of "this exact sentence of this exact source", shared by the
// WordPopover (which asks "is this sentence already mined?" before offering
// its Add to Reviews button) and the Review page (which evicts a card's key
// when the card is deleted). Both sides must agree on one format, so it
// lives here rather than in either consumer.

export type SentenceCardSource =
  | { kind: "story"; storyId: number }
  | { kind: "chat"; chatMessageId: number };

/** e.g. `story-12:340-388`. Offsets are into the source's cleaned text. */
export function sentenceCardKey(
  source: SentenceCardSource,
  sentenceStart: number,
  sentenceEnd: number
): string {
  const src =
    source.kind === "story"
      ? `story-${source.storyId}`
      : `chat-${source.chatMessageId}`;
  return `${src}:${sentenceStart}-${sentenceEnd}`;
}

/**
 * Rebuild a key from the nullable id pair the SQL side returns. Cards whose
 * source row was deleted have both ids null (the FKs are ON DELETE SET NULL);
 * they keep working as review cards but can no longer be matched back to a
 * tap, so they get no key.
 */
export function sentenceCardKeyFromIds(
  storyId: number | null,
  chatMessageId: number | null,
  sentenceStart: number,
  sentenceEnd: number
): string | null {
  if (storyId != null) {
    return sentenceCardKey({ kind: "story", storyId }, sentenceStart, sentenceEnd);
  }
  if (chatMessageId != null) {
    return sentenceCardKey(
      { kind: "chat", chatMessageId },
      sentenceStart,
      sentenceEnd
    );
  }
  return null;
}
