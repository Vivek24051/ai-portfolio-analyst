// Per-turn timing and usage recorder. Everything here ends up in AgentRun / ToolCall rows,
// which is what PERFORMANCE.md and the admin dashboard are built from.

import type { ToolCallRecord } from "@/server/stores/types";

export interface LlmCallRecord {
  model: string;
  ms: number;
  /** Time to first streamed token; null when the call was not streamed or produced no text. */
  ttftMs: number | null;
  streamed: boolean;
  ok: boolean;
  error: string | null;
  isFallback: boolean;
  withTools: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface Span {
  name: string;
  ms: number;
}

const now = () => performance.now();

export class RunRecorder {
  private readonly t0 = now();
  readonly spans: Span[] = [];
  readonly llmCalls: LlmCallRecord[] = [];
  readonly toolCalls: ToolCallRecord[] = [];

  elapsedMs() {
    return Math.round(now() - this.t0);
  }

  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = now();
    try {
      return await fn();
    } finally {
      this.spans.push({ name, ms: Math.round(now() - start) });
    }
  }

  llmMs() {
    return Math.round(this.llmCalls.reduce((s, c) => s + c.ms, 0));
  }

  /** Sum of tool durations (tools within one round may overlap, so this can exceed wall time). */
  toolMs() {
    return Math.round(this.toolCalls.reduce((s, c) => s + c.durationMs, 0));
  }

  tokens() {
    const sum = (k: "promptTokens" | "completionTokens") =>
      this.llmCalls.some((c) => c[k] !== null) ? this.llmCalls.reduce((s, c) => s + (c[k] ?? 0), 0) : null;
    return { promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens") };
  }
}
