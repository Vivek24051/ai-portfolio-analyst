# In-process benchmark (mock model, in-memory store)

> **Conditions:** server pipeline called in-process (no HTTP). Model = oracle mock (no network, ~0 ms). Store = in-memory.
> This measures our own overhead only. It is **not** LLM latency, **not** HTTP latency and **not** PostgreSQL latency.

| | |
|---|---|
| Date | 2026-10-10T09:07:44.586Z |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 |
| Workload | 38 golden cases (48 turns, fault cases excluded) × 30 iterations, after 1 warm-up pass |

## Per turn (ms)

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| turn wall time (high-res) | 1440 | 4.149 | 6.427 | 10.601 |
| server total (1 ms res.) | 1440 | 4 | 6 | 11 |
| span: request_validation | 1440 | 0 | 0 | 0 |
| span: context_load | 1440 | 0 | 0 | 1 |
| span: agent | 1440 | 4 | 6 | 9 |
| span: persist | 1440 | 0 | 0 | 2 |
| model calls (mock ≈ 0) | 1440 | 0 | 0 | 3 |

## Per tool call (ms, 1 ms resolution)

| Tool | n | p50 | p95 | max |
|---|---|---|---|---|
| cancel_pending_action | 30 | 0 | 0 | 0 |
| compare_groups | 30 | 0 | 0 | 0 |
| confirm_pending_action | 60 | 0 | 0 | 2 |
| flag_for_human | 30 | 0 | 0 | 0 |
| portfolio_analytics | 180 | 0 | 0 | 0 |
| propose_new_property | 150 | 0 | 0 | 1 |
| propose_property_update | 150 | 0 | 0 | 1 |
| run_scenario | 150 | 0 | 1 | 2 |
| search_properties | 570 | 0 | 0 | 0 |

Production spans and tool durations are recorded in whole milliseconds (they are stored as integers), so sub-millisecond work shows as 0. The high-resolution wall time is measured by the harness around each turn.
