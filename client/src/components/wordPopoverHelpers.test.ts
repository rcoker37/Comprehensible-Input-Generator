import { describe, it, expect } from "vitest";
import { pairThreadMessages } from "./wordPopoverHelpers";
import type { ChatMessage } from "../types";

const ts = "2026-04-29T00:00:00.000Z";

function user(content: string): ChatMessage {
  return { role: "user", content, generated_at: ts };
}

function assistant(content: string): ChatMessage {
  return { role: "assistant", content, generated_at: ts };
}

describe("pairThreadMessages", () => {
  it("returns no pairs for an empty list", () => {
    expect(pairThreadMessages([])).toEqual([]);
  });

  it("hides the seed user turn and shows its reply alone", () => {
    const pairs = pairThreadMessages([user("chip prompt"), assistant("A0")]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].q).toBeNull();
    expect(pairs[0].a?.content).toBe("A0");
  });

  it("hides the seed and pairs subsequent legacy follow-ups", () => {
    const msgs = [
      user("chip prompt"),
      assistant("A0"),
      user("follow-up"),
      assistant("A1"),
    ];
    const pairs = pairThreadMessages(msgs);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].q).toBeNull();
    expect(pairs[0].a?.content).toBe("A0");
    expect(pairs[1].q?.content).toBe("follow-up");
    expect(pairs[1].a?.content).toBe("A1");
  });

  it("hides the seed even when the reply is missing (defensive)", () => {
    expect(pairThreadMessages([user("chip prompt")])).toEqual([]);
  });
});
