import { useRef, useState, type KeyboardEvent } from "react";
import AnimatedDots from "./AnimatedDots";
import "./ChatComposer.css";

interface Props {
  /** True while a previous turn is still generating — disables sending. */
  disabled: boolean;
  onSend: (text: string) => void | Promise<void>;
}

export default function ChatComposer({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const trySend = async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    await onSend(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void trySend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="chat-composer">
      <textarea
        ref={textareaRef}
        className="chat-composer-input"
        placeholder="Ask in English or Japanese…"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <button
        type="button"
        className="chat-composer-send"
        disabled={disabled || value.trim().length === 0}
        onClick={() => void trySend()}
        title="Send (Enter)"
        aria-label="Send"
      >
        {disabled ? (
          <AnimatedDots />
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
          </svg>
        )}
      </button>
    </div>
  );
}
