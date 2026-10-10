// Minimal Server-Sent Events framing, shared by the stream route (encode) and the browser
// client (incremental decode over a fetch() body, since EventSource cannot POST).

import type { ChatStreamEvent } from "@/agent/events";

export function encodeSse(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export const SSE_HEARTBEAT = ": keep-alive\n\n";

/**
 * Incremental parser: feed arbitrary text chunks, get complete events back. Handles events split
 * across chunks, multiple events per chunk, comments (heartbeats) and CRLF line endings.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): ChatStreamEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: ChatStreamEvent[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue; // comment / heartbeat
      try {
        events.push(JSON.parse(data) as ChatStreamEvent);
      } catch {
        // Ignore a malformed frame rather than killing the whole stream.
      }
    }
    return events;
  }
}
