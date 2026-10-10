# Evaluation report — oracle

> **Conditions:** MOCK. The model is the oracle reference policy (scripted ideal tool calls and replies). This validates the harness, tools, graders and safety checks — it is NOT evidence of LLM quality. Timings exclude any model latency.

| | |
|---|---|
| Model | oracle (reference policy, mock) |
| Started | 2026-10-10T09:10:40.649Z |
| Repeats | 1 |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 |
| Commit | 90d38a4 |

## Scores

| Metric | Result |
|---|---|
| Cases fully passed | 100.0% (40/40) |
| Tool selection | 100.0% (42/42) |
| Argument accuracy | 100.0% (20/20) |
| Expected figures stated | 100.0% (23/23) |
| Numeric faithfulness (replies whose every number traces to tool output) | 100.0% (34/34) |
| Clarification behaviour | 100.0% (7/7) |
| Proposal / no-proposal correct | 100.0% (14/14) |
| Hypothetical labelling | 100.0% (5/5) |
| Content (must / must-not mention) | 100.0% (45/45) |
| Reply patterns | 100.0% (4/4) |
| Handoff / status / fallback | 100.0% (4/4) |
| **Safety violations** | **0** |
| Expected writes missing | 0 |

## Coverage

| Category | Cases | Turns | Passed |
|---|---|---|---|
| sample_request | 6 | 6 | 6 |
| analysis | 6 | 6 | 6 |
| calculation | 5 | 5 | 5 |
| ambiguity_data_gap | 4 | 4 | 4 |
| multi_turn | 3 | 8 | 3 |
| hypothetical | 3 | 3 | 3 |
| property_update | 5 | 10 | 5 |
| authorization_safety | 4 | 4 | 4 |
| failure | 4 | 4 | 4 |
| **Total** | **40** | **50** | **40** |

## Server-side timings (ms, successful turns)

| Span | n | p50 | p95 | max |
|---|---|---|---|---|
| totalMs | 49 | 32 | 47 | 80 |
| llmMs | 49 | 25 | 33 | 38 |
| toolMs | 49 | 0 | 2 | 21 |
| request_validation | 50 | 0 | 0 | 0 |
| context_load | 50 | 0 | 0 | 1 |
| agent | 50 | 32 | 46 | 74 |
| persist | 50 | 0 | 0 | 0 |

Model calls per turn: p50 2, max 3. Tool calls per turn: p50 1, max 2.

## Token estimates (cl100k approximation, for cost planning only)

95 model calls · input tokens/call p50 4693, p95 5338, max 6419 · output tokens/call p50 33, max 76 · totals: 454340 in / 3286 out.

## Safety violations

None.

## Failed checks

None.
