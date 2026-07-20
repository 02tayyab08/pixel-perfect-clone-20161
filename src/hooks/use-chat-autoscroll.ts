import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Chat scroll: on send, pin the latest user message near the top of the
 * scroll container; while streaming, follow growth so new tokens stay in view.
 *
 * @param streamKey - typically last assistant `content` so layout effects
 *   re-run on each SSE delta (message count does not change mid-stream).
 */
export function useChatAutoscroll(streamKey: string, busy: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const pinUserOnNextPaint = useRef(false);
  const followStream = useRef(true);

  const markUserSent = useCallback(() => {
    pinUserOnNextPaint.current = true;
    followStream.current = true;
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // If the user scrolls away from the bottom while an answer streams,
    // stop chasing so we don't fight their reading position.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followStream.current = distanceFromBottom < 80;
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (pinUserOnNextPaint.current && lastUserRef.current) {
      pinUserOnNextPaint.current = false;
      const userEl = lastUserRef.current;
      // Pin user bubble near the top of the visible area (~12px padding).
      const top =
        userEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        12;
      container.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      return;
    }

    if (busy && followStream.current && bottomRef.current) {
      const containerRect = container.getBoundingClientRect();
      const bottomRect = bottomRef.current.getBoundingClientRect();
      // Only chase once the answer grows past the fold — keeps the user
      // message pinned near the top until then.
      if (bottomRect.bottom > containerRect.bottom - 8) {
        bottomRef.current.scrollIntoView({ block: "end", behavior: "auto" });
      }
    }
  }, [streamKey, busy]);

  return { containerRef, bottomRef, lastUserRef, markUserSent, onScroll };
}
