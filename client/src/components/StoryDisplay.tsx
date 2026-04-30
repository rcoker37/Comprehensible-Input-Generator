import { useState, useEffect, useMemo, useRef } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { tokenizeForAudio, type AudioToken } from "../lib/tokenizer";
import { parseAnnotatedText, stripAnnotations } from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import WordPopover from "./WordPopover";
import type {
  Story,
  StoryAudio,
  StoryWordThreads,
  WordThread,
} from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
  audio?: StoryAudio | null;
  activeSegmentIdx?: number;
  onSentenceClick?: (i: number) => void;
}

interface DisplayToken extends AudioToken {
  offset: number;
}

interface DisplaySentence {
  /** Index into audio.sentences (or audio.paragraphs for v2 audio). */
  audioIdx: number;
  tokens: DisplayToken[];
}

interface DisplayParagraph {
  sentences: DisplaySentence[];
}

// Mirror the sentence-boundary rule used by generate-audio so display sentences
// align 1:1 with the bookmarks Azure embedded in the audio stream.
const SENTENCE_TERMINATORS = ["。", "！", "？"];
const SENTENCE_CLOSERS = new Set(["」", "』", "）", ")", "”", "’"]);

function containsTerminator(s: string): boolean {
  return SENTENCE_TERMINATORS.some((t) => s.includes(t));
}

function isPureClosers(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (!SENTENCE_CLOSERS.has(ch)) return false;
  return true;
}

/**
 * Walk the token stream, stamping char offsets and splitting into paragraphs
 * (on `\n\n`) and sentences (on `。`/`！`/`？` terminators or single `\n`).
 * Each rendered sentence carries the audio.sentences index it corresponds to,
 * so the player can highlight the active sentence directly.
 *
 * When `dropTitleParagraph` is set, the first paragraph is dropped (it's the
 * title, rendered separately as an <h2>) and offsets are rebased so they
 * still match the content-only cleanText that lookupAtCursor expects. The
 * sentence counter keeps incrementing through the dropped title so the
 * surviving sentences inherit the same numbering the server used.
 */
function groupTokens(
  tokens: AudioToken[],
  dropTitleParagraph: boolean
): DisplayParagraph[] {
  const paragraphs: DisplayParagraph[] = [];
  let currentPara: DisplaySentence[] = [];
  let currentSentTokens: DisplayToken[] = [];
  let currentSentAudioIdx = -1;
  let offset = 0;
  let base = 0;
  let dropped = !dropTitleParagraph;
  let armed = true;
  let sentenceCounter = 0;

  const flushSentence = () => {
    if (currentSentTokens.length === 0) return;
    if (dropped) {
      currentPara.push({
        audioIdx: currentSentAudioIdx,
        tokens: currentSentTokens,
      });
    }
    currentSentTokens = [];
    currentSentAudioIdx = -1;
  };

  // separatorLen lets the title-drop branch rebase past the trailing
  // whitespace, so content offsets start at 0 rather than skipping into
  // the separator's character count.
  const flushParagraph = (separatorLen: number) => {
    flushSentence();
    if (!dropped) {
      dropped = true;
      currentPara = [];
      base = offset + separatorLen;
      return;
    }
    if (currentPara.length > 0) paragraphs.push({ sentences: currentPara });
    currentPara = [];
  };

  for (const tok of tokens) {
    if (/^\s+$/.test(tok.s)) {
      const newlines = (tok.s.match(/\n/g) || []).length;
      if (newlines >= 2) {
        flushParagraph(tok.s.length);
        armed = true;
      } else if (newlines === 1) {
        flushSentence();
        armed = true;
      }
      offset += tok.s.length;
      continue;
    }

    if (armed && !isPureClosers(tok.s)) {
      flushSentence();
      currentSentAudioIdx = sentenceCounter++;
      armed = false;
    }

    currentSentTokens.push({ ...tok, offset: offset - base });
    offset += tok.s.length;

    if (containsTerminator(tok.s)) armed = true;
  }

  flushParagraph(0);
  return paragraphs;
}

export default function StoryDisplay({
  story,
  showLink,
  audio,
  activeSegmentIdx = -1,
  onSentenceClick,
}: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<DisplayParagraph[] | null>(null);
  const [wordThreads, setWordThreads] = useState<StoryWordThreads>(
    story.explanations ?? {}
  );
  const [activeTap, setActiveTap] = useState<{
    offset: number;
    el: HTMLElement;
  } | null>(null);

  useEffect(() => {
    setWordThreads(story.explanations ?? {});
  }, [story.explanations]);

  const { cleanContent, rubyAnnotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, rubyAnnotations: annotations };
  }, [story.content]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  // Prefer server-tokenized audio tokens when we have them — they're
  // guaranteed to align with the audio timing. Otherwise tokenize locally
  // from the clean text + ruby annotations.
  useEffect(() => {
    let cancelled = false;
    if (audio?.tokens && audio.tokens.length > 0) {
      setParagraphs(groupTokens(audio.tokens, true));
      return;
    }
    tokenizeForAudio(cleanContent, rubyAnnotations).then((tokens) => {
      if (!cancelled) setParagraphs(groupTokens(tokens, false));
    });
    return () => {
      cancelled = true;
    };
  }, [audio, cleanContent, rubyAnnotations]);

  // Single-click on a word seeks the enclosing sentence; double-click opens
  // the word popover. We delay the single-click seek so a fast double-click
  // can cancel it. Clicks on whitespace inside the sentence skip this path
  // entirely and seek immediately via the sentence span's onClick.
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  const cancelPendingSeek = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };

  const handleWordClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    sentenceAudioIdx: number
  ) => {
    e.stopPropagation();
    cancelPendingSeek();
    if (e.detail >= 2) return; // second click of a double — let dblclick handle it
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      onSentenceClick?.(sentenceAudioIdx);
    }, 280);
  };

  const handleWordDoubleClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    offset: number
  ) => {
    e.stopPropagation();
    cancelPendingSeek();
    setActiveTap({ offset, el: e.currentTarget });
  };

  const handleThreadUpdated = (
    rangeKey: string,
    threadId: string,
    thread: WordThread
  ) => {
    setWordThreads((prev) => ({
      ...prev,
      [rangeKey]: { ...(prev[rangeKey] ?? {}), [threadId]: thread },
    }));
  };

  return (
    <div className="story-display">
      <div className="story-header">
        <h2 className="story-title">{stripAnnotations(stripBold(story.title))}</h2>
      </div>
      <div className="story-meta">
        <span className="type-tag">{story.content_type ?? "story"}</span>
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
      </div>
      <div className="story-content">
        {paragraphs ? (
          <div className="story-paragraphs">
            {paragraphs.map((para, pIdx) => (
              <p key={pIdx} className="story-paragraph">
                {para.sentences.map((sent) => (
                  <span
                    key={sent.audioIdx}
                    className={`story-sentence${
                      activeSegmentIdx === sent.audioIdx ? " active" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSentenceClick?.(sent.audioIdx);
                    }}
                  >
                    {sent.tokens.map((tok) => {
                      const hasUnknown = [...tok.s].some(
                        (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
                      );
                      const showRuby = hasUnknown && tok.r;
                      const inner = showRuby ? (
                        <ruby>
                          {tok.s}
                          <rt>{tok.r}</rt>
                        </ruby>
                      ) : (
                        tok.s
                      );
                      return (
                        <button
                          key={tok.offset}
                          type="button"
                          className="word-token"
                          data-offset={tok.offset}
                          onClick={(e) => handleWordClick(e, sent.audioIdx)}
                          onDoubleClick={(e) =>
                            handleWordDoubleClick(e, tok.offset)
                          }
                        >
                          {inner}
                        </button>
                      );
                    })}
                  </span>
                ))}
              </p>
            ))}
          </div>
        ) : (
          cleanContent.split("\n\n").map((p, i) => <p key={i}>{p}</p>)
        )}
      </div>
      <WordPopover
        storyId={story.id}
        cleanText={cleanContent}
        offset={activeTap?.offset ?? null}
        wordThreads={wordThreads}
        referenceEl={activeTap?.el ?? null}
        open={activeTap !== null}
        onOpenChange={(open) => {
          if (!open) setActiveTap(null);
        }}
        onThreadUpdated={handleThreadUpdated}
      />
      {unknownKanji.size > 0 && (
        <div className="violations">
          {unknownKanji.size} unknown kanji marked with readings:{" "}
          {[...unknownKanji].join(", ")}
        </div>
      )}
      {showLink && (
        <a href={`/stories/${story.id}`} className="story-link">
          View full story
        </a>
      )}
    </div>
  );
}
