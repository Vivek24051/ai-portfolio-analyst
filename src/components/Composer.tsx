"use client";

import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export const MAX_MESSAGE_LENGTH = 2000;

export interface ComposerHandle {
  prefill(text: string): void;
}

interface Props {
  disabled: boolean;
  onSend(text: string): void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ disabled, onSend }, ref) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    prefill(value: string) {
      setText(value);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(value.length, value.length);
      });
    },
  }));

  const trimmed = text.trim();
  const tooLong = text.length > MAX_MESSAGE_LENGTH;
  const canSend = !disabled && trimmed.length > 0 && !tooLong;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={input}
        rows={1}
        value={text}
        placeholder={disabled ? "Waiting for the reply…" : "Ask about your portfolio"}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {tooLong && <span className="counter over">{text.length}/{MAX_MESSAGE_LENGTH}</span>}
      <button type="submit" className="send" disabled={!canSend} aria-label="Send">
        ➤
      </button>
    </form>
  );
});
