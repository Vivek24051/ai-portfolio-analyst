# Performance

> **No latency measurements yet.** The agent loop is not built (Phase 2). The tables below will be filled only from real runs of the evaluation harness (Phase 5); no figure here is estimated.

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
