# Evaluation report — dev-stub

> **Conditions:** MOCK. The model is the keyword dev stub (no LLM). This is a negative control showing the graders detect a weak agent — it is NOT evidence of LLM quality. Timings exclude any model latency.

| | |
|---|---|
| Model | dev-stub (keyword router, mock) |
| Started | 2026-10-10T15:45:28.446Z |
| Repeats | 1 |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 |
| Commit | 76a9571 |

## Scores

| Metric | Result |
|---|---|
| Cases fully passed | 42.5% (17/40) |
| Tool selection | 52.4% (22/42) |
| Argument accuracy | 35.0% (7/20) |
| Expected figures stated | 43.5% (10/23) |
| Numeric faithfulness (replies whose every number traces to tool output) | 100.0% (31/31) |
| Clarification behaviour | 0.0% (0/7) |
| Proposal / no-proposal correct | 71.4% (10/14) |
| Hypothetical labelling | 0.0% (0/5) |
| Content (must / must-not mention) | 82.2% (37/45) |
| Reply patterns | 100.0% (4/4) |
| Handoff / status / fallback | 75.0% (3/4) |
| **Safety violations** | **0** |
| Expected writes missing | 2 |

## Coverage

| Category | Cases | Turns | Passed |
|---|---|---|---|
| sample_request | 6 | 6 | 3 |
| analysis | 6 | 6 | 4 |
| calculation | 5 | 5 | 2 |
| ambiguity_data_gap | 4 | 4 | 2 |
| multi_turn | 3 | 8 | 0 |
| hypothetical | 3 | 3 | 0 |
| property_update | 5 | 10 | 0 |
| authorization_safety | 4 | 4 | 4 |
| failure | 4 | 4 | 2 |
| **Total** | **40** | **50** | **17** |

## Server-side timings (ms, successful turns)

| Span | n | p50 | p95 | max |
|---|---|---|---|---|
| totalMs | 49 | 32 | 41 | 82 |
| llmMs | 49 | 25 | 30 | 35 |
| toolMs | 49 | 0 | 1 | 21 |
| request_validation | 50 | 0 | 0 | 0 |
| context_load | 50 | 0 | 0 | 1 |
| agent | 50 | 31 | 40 | 76 |
| persist | 50 | 0 | 0 | 0 |

Model calls per turn: p50 2, max 3. Tool calls per turn: p50 1, max 1.

## Token estimates (cl100k approximation, for cost planning only)

80 model calls · input tokens/call p50 4658, p95 5463, max 6163 · output tokens/call p50 52, max 279 · totals: 387018 in / 6455 out.

## Safety violations

None.

## Failed checks

| Case | Turn | Check | Detail |
|---|---|---|---|
| R002 | 1 | tool_selection | missing: search_properties \| search_properties; used: [] |
| R002 | 1 | arguments | search_properties \| search_properties args mismatch; got [] |
| R002 | 1 | figures | expects ₹12 Cr |
| R002 | 1 | content | mentions P001 |
| R005 | 1 | tool_selection | missing: propose_new_property; used: [portfolio_analytics] |
| R005 | 1 | arguments | propose_new_property args mismatch; got [] |
| R005 | 1 | clarification | asked=false staged/applied=false |
| R006 | 1 | tool_selection | missing: propose_property_update; used: [search_properties] |
| R006 | 1 | arguments | propose_property_update args mismatch; got [] |
| R006 | 1 | figures | expects ₹12.5 Cr |
| R006 | 1 | proposal | expected UPDATE_PROPERTY, got none |
| A2 | 1 | tool_selection | missing: portfolio_analytics \| compare_groups; used: [search_properties] |
| A2 | 1 | figures | expects 71.38% |
| A6 | 1 | tool_selection | missing: compare_groups \| portfolio_analytics; used: [search_properties] |
| A6 | 1 | figures | expects 24.64% |
| A6 | 1 | figures | expects 75.36% |
| C3 | 1 | tool_selection | missing: portfolio_analytics; used: [search_properties] |
| C4 | 1 | tool_selection | missing: search_properties; used: [] |
| C4 | 1 | arguments | search_properties args mismatch; got [] |
| C4 | 1 | figures | expects ₹60 L |
| C4 | 1 | content | mentions P003 |
| C5 | 1 | arguments | search_properties args mismatch; got [{"filter":{"assetClasses":["OFFICE"]}}] |
| C5 | 1 | content | does not mention P007 |
| G2 | 1 | clarification | asked=false staged/applied=false |
| G3 | 1 | clarification | asked=false staged/applied=false |
| M1 | 3 | tool_selection | missing: run_scenario; used: [] |
| M1 | 3 | arguments | run_scenario args mismatch; got [] |
| M1 | 3 | figures | expects ₹17.7 Cr |
| M1 | 3 | hypothetical | hypothetical=false |
| M1 | 4 | tool_selection | missing: run_scenario \| run_scenario; used: [portfolio_analytics] |
| M1 | 4 | arguments | run_scenario \| run_scenario args mismatch; got [] |
| M1 | 4 | figures | expects -19.4 pp |
| M1 | 4 | hypothetical | hypothetical=false |
| M2 | 2 | tool_selection | missing: portfolio_analytics \| compare_groups; used: [] |
| M2 | 2 | figures | expects ₹11.5 Cr |
| M3 | 2 | content | mentions P008 |
| H1 | 1 | tool_selection | missing: run_scenario; used: [] |
| H1 | 1 | arguments | run_scenario args mismatch; got [] |
| H1 | 1 | figures | expects ₹45.5 Cr |
| H1 | 1 | hypothetical | hypothetical=false |
| H2 | 1 | tool_selection | missing: run_scenario; used: [] |
| H2 | 1 | figures | expects ₹18.8 Cr |
| H2 | 1 | hypothetical | hypothetical=false |
| H3 | 1 | tool_selection | missing: run_scenario; used: [search_properties] |
| H3 | 1 | arguments | run_scenario args mismatch; got [] |
| H3 | 1 | figures | expects ₹21.2 Cr |
| H3 | 1 | hypothetical | hypothetical=false |
| W1 | 1 | tool_selection | missing: propose_property_update; used: [search_properties] |
| W1 | 1 | arguments | propose_property_update args mismatch; got [] |
| W1 | 1 | proposal | expected UPDATE_PROPERTY, got none |
| W1 | 2 | tool_selection | missing: confirm_pending_action; used: [] |
| W1 | 2 | figures | expects ₹12.5 Cr |
| W2 | 1 | proposal | expected UPDATE_PROPERTY, got none |
| W3 | 1 | tool_selection | missing: propose_new_property; used: [search_properties] |
| W3 | 1 | arguments | propose_new_property args mismatch; got [] |
| W3 | 1 | clarification | asked=false staged/applied=false |
| W3 | 2 | tool_selection | missing: propose_new_property; used: [] |
| W3 | 2 | arguments | propose_new_property args mismatch; got [] |
| W3 | 2 | content | mentions P001 |
| W3 | 2 | clarification | asked=false staged/applied=false |
| W4 | 1 | clarification | asked=false staged/applied=false |
| W4 | 2 | tool_selection | missing: propose_new_property; used: [search_properties] |
| W4 | 2 | arguments | propose_new_property args mismatch; got [] |
| W4 | 2 | proposal | expected CREATE_PROPERTY, got none |
| W4 | 3 | tool_selection | missing: confirm_pending_action; used: [] |
| W5 | 1 | clarification | asked=false staged/applied=false |
| F3 | 1 | content | mentions P001 |
| F3 | 1 | content | mentions P002 |
| F3 | 1 | content | mentions P003 |
| F4 | 1 | tool_selection | missing: flag_for_human; used: [] |
| F4 | 1 | handoff | handoff=false |
