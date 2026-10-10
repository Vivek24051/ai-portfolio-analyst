# Performance

> **No latency measurements yet.** The instrumentation is built (Phase 2), but no real model has been called. Test timings with mocked models are not representative and are deliberately not reported. The tables below will be filled only from real runs of the evaluation harness (Phase 5).

## Instrumentation status

| Signal | Status |
|---|---|
| Per-turn spans: `context_load`, `agent`, `persist` | ✅ recorded in `AgentRun.timings.spans` |
| Each LLM call: model, ms, ok/error, fallback flag, tools bound, prompt/completion tokens | ✅ `AgentRun.timings.llmCalls` (tokens when the provider reports them) |
| Each tool call: name, args, result, ok, error, ms | ✅ `ToolCall` rows |
| Totals: `totalMs`, `llmMs`, `toolMs`, `llmCalls`, `toolCallCount`, tool rounds | ✅ `AgentRun` columns |
| Time to first streamed token per LLM call (`ttftMs`), and whether the call streamed | ✅ in `AgentRun.timings.llmCalls` (null for non-streaming calls) |
| Time to first visible event in the browser | ⏳ to be measured client-side in Phase 5 |
| Request receipt → `request_validation` span (auth, body, rate limit) | ✅ |
| `costUsd` per call and per run | ✅ recorded **only if the provider reports it** (OpenRouter `usage.include` requested; extraction path unverified live). Run total is null unless every successful call reported it |
| Prompt/completion tokens per run | ✅ same rule: null = not reported, 0 = reported zero |
| Where to see it | `/admin` (p50/p95 over recorded runs) and `/admin/conversations/:id` (per-run trace) |

## What will be measured (per user turn)

Recorded in `AgentRun.timings` and `ToolCall.durationMs`. Each turn is timed from the server receiving the request.

| Span | Meaning |
|---|---|
| `contextLoadMs` | Auth, loading recent messages and conversation state from Postgres |
| `llm[i].ttftMs` / `llm[i].totalMs` | Time to first token and total time for each model call, with token counts and the model/provider used |
| `tool[j].ms` | Tool latency: validation, database read, and calculation |
| `llmCalls` | Number of model round trips; expected to dominate latency |
| `persistMs` | Writing messages, run, and tool rows |
| `firstVisibleTokenMs` | Time until the user sees the first streamed text |
| `totalMs` | End-to-end time for the turn |

Results will be reported as p50/p95 per case category (simple lookup, analysis, multi-turn follow-up, scenario, write proposal, confirm), for each candidate model.

## Results

_Pending Phase 5._

## Latency reductions

_Planned:_
- tools that aggregate, so one call answers most questions
- parallel tool calls
- a numberless property index in the prompt, which saves a lookup round trip
- a capped history window
- streaming
- an LLM-free confirm button path
- a hard step cap

Each will be reported only once implemented and measured.

## At higher volume

_To be written with the measurements._
