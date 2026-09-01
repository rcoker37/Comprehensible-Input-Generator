import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGeneration,
  cacheAudioUrl,
  cardAudioPath,
  evictCachedAudioUrl,
  getCachedAudioUrl,
  isTtsUnavailable,
  markTtsUnavailable,
  resetSentenceAudioStateForTests,
  sentenceAudioKey,
  sourceAudioPath,
  storyAudioFolder,
  trackGeneration,
} from "./sentenceAudio";

const UID = "a1b2c3";

beforeEach(() => {
  resetSentenceAudioStateForTests();
});

describe("path builders", () => {
  it("builds story and chat source paths matching the Edge Function layout", () => {
    expect(sourceAudioPath(UID, { kind: "story", storyId: 12 }, 340, 388)).toBe(
      "a1b2c3/story-12/340-388.mp3"
    );
    expect(
      sourceAudioPath(UID, { kind: "chat", chatMessageId: 9 }, 0, 31)
    ).toBe("a1b2c3/chat-9/0-31.mp3");
  });

  it("builds card paths and story folders", () => {
    expect(cardAudioPath(UID, 57)).toBe("a1b2c3/cards/57.mp3");
    expect(storyAudioFolder(UID, 12)).toBe("a1b2c3/story-12");
  });

  it("keys a sentence identically to sentenceCardKey", () => {
    expect(sentenceAudioKey({ kind: "story", storyId: 12 }, 340, 388)).toBe(
      "story-12:340-388"
    );
  });
});

describe("signed-URL cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a cached URL within the reuse window", () => {
    cacheAudioUrl("p.mp3", "https://signed/1");
    expect(getCachedAudioUrl("p.mp3")).toBe("https://signed/1");
    vi.advanceTimersByTime(44 * 60 * 1000);
    expect(getCachedAudioUrl("p.mp3")).toBe("https://signed/1");
  });

  it("expires a cached URL after 45 minutes", () => {
    cacheAudioUrl("p.mp3", "https://signed/1");
    vi.advanceTimersByTime(45 * 60 * 1000);
    expect(getCachedAudioUrl("p.mp3")).toBeNull();
  });

  it("evicts on demand", () => {
    cacheAudioUrl("p.mp3", "https://signed/1");
    evictCachedAudioUrl("p.mp3");
    expect(getCachedAudioUrl("p.mp3")).toBeNull();
  });
});

describe("in-flight coordination", () => {
  it("dedupes concurrent generations under one key", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const task = () => {
      calls++;
      return gate.then(() => "done");
    };

    const first = trackGeneration("story-1:0-5", task);
    const second = trackGeneration("story-1:0-5", task);
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toBe("done");
    expect(calls).toBe(1);
  });

  it("allows a fresh generation after the previous one settles", async () => {
    let calls = 0;
    const task = () => {
      calls++;
      return Promise.resolve("ok");
    };
    await trackGeneration("story-1:0-5", task);
    await trackGeneration("story-1:0-5", task);
    expect(calls).toBe(2);
  });

  it("awaitGeneration waits for the in-flight promise and swallows errors", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let settled = false;
    void trackGeneration("story-1:0-5", () =>
      gate.then(() => {
        settled = true;
        throw new Error("azure down");
      })
    ).catch(() => {});

    const waiter = awaitGeneration("story-1:0-5").then(() => settled);
    release();
    await expect(waiter).resolves.toBe(true);
  });

  it("awaitGeneration resolves immediately when nothing is in flight", async () => {
    await expect(awaitGeneration("story-9:0-1")).resolves.toBeUndefined();
  });
});

describe("tts-unavailable latch", () => {
  it("latches for the session once marked", () => {
    expect(isTtsUnavailable()).toBe(false);
    markTtsUnavailable();
    expect(isTtsUnavailable()).toBe(true);
  });
});
