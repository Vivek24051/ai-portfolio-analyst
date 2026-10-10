// Per-turn timing and usage recorder. Everything here ends up in AgentRun / ToolCall rows,
// which is what PERFORMANCE.md and the admin dashboard are built from.
//
// Missing ≠ zero: token and cost figures are only what the provider actually reported.
// A run-level total is null ("unknown") unless EVERY successful model call reported it.

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
  /** Provider account ("gemini", "openrouter", "stub"); null = not recorded (older runs, test fakes). */
  provider?: string | null;
  /** This call was the last-resort dev stub, after the real models failed. */
  lastResort?: boolean;
  withTools: boolean;
  /** null = provider did not report it (NOT zero). */
  promptTokens: number | null;
  completionTokens: number | null;
  /** USD as reported by the provider; null = not reported. Never estimated from a price table. */
  costUsd: number | null;
}

export interface Span {
  name: string;
  ms: number;
}

const now = () => performance.now();

export class RunRecorder {
  readonly spans: Span[] = [];
  readonly llmCalls: LlmCallRecord[] = [];
  readonly toolCalls: ToolCallRecord[] = [];

  /** @param t0 performance.now() at request receipt, so totals include auth/validation. */
  constructor(private readonly t0: number = now()) {}

  elapsedMs() {
    return Math.round(now() - this.t0);
  }

  /** Records a span that already happened (e.g. route-level validation before the service ran). */
  addSpan(name: string, ms: number) {
    this.spans.push({ name, ms: Math.round(ms) });
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

  /** Sum over successful calls, or null if any successful call did not report the figure. */
  private reported(key: "promptTokens" | "completionTokens" | "costUsd"): number | null {
    const ok = this.llmCalls.filter((c) => c.ok);
    if (ok.length === 0 || ok.some((c) => c[key] === null)) return null;
    return ok.reduce((s, c) => s + (c[key] as number), 0);
  }

  tokens() {
    return { promptTokens: this.reported("promptTokens"), completionTokens: this.reported("completionTokens") };
  }

  costUsd() {
    return this.reported("costUsd");
  }
}
