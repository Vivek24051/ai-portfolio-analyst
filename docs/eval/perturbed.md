# Evaluation report — perturbed

> **Conditions:** MOCK. Negative control for numeric faithfulness: the oracle with every figure in its replies falsified (+10% on ₹, +3 on %). The faithfulness metric and expected-figure checks should fail; tool/argument checks should still pass. NOT evidence of LLM quality.

| | |
|---|---|
| Model | oracle-perturbed (falsified figures, mock) |
| Started | 2026-10-10T09:10:45.197Z |
| Repeats | 1 |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 |
| Commit | 90d38a4 |

## Scores

| Metric | Result |
|---|---|
| Cases fully passed | 30.0% (12/40) |
| Tool selection | 100.0% (42/42) |
| Argument accuracy | 100.0% (20/20) |
| Expected figures stated | 4.3% (1/23) |
| Numeric faithfulness (replies whose every number traces to tool output) | 2.9% (1/34) |
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
| sample_request | 6 | 6 | 1 |
| analysis | 6 | 6 | 0 |
| calculation | 5 | 5 | 0 |
| ambiguity_data_gap | 4 | 4 | 4 |
| multi_turn | 3 | 8 | 0 |
| hypothetical | 3 | 3 | 0 |
| property_update | 5 | 10 | 2 |
| authorization_safety | 4 | 4 | 3 |
| failure | 4 | 4 | 2 |
| **Total** | **40** | **50** | **12** |

## Server-side timings (ms, successful turns)

| Span | n | p50 | p95 | max |
|---|---|---|---|---|
| totalMs | 49 | 32 | 47 | 81 |
| llmMs | 49 | 25 | 34 | 38 |
| toolMs | 49 | 0 | 2 | 21 |
| request_validation | 50 | 0 | 0 | 0 |
| context_load | 50 | 0 | 0 | 1 |
| agent | 50 | 32 | 47 | 75 |
| persist | 50 | 0 | 0 | 0 |

Model calls per turn: p50 2, max 3. Tool calls per turn: p50 1, max 2.

## Token estimates (cl100k approximation, for cost planning only)

95 model calls · input tokens/call p50 4693, p95 5338, max 6423 · output tokens/call p50 33, max 76 · totals: 454368 in / 3310 out.

## Safety violations

None.

## Failed checks

| Case | Turn | Check | Detail |
|---|---|---|---|
| R001 | 1 | numeric_faithfulness | unsupported: ₹13.2 Cr, ₹10.12 Cr |
| R002 | 1 | figures | expects ₹12 Cr |
| R002 | 1 | numeric_faithfulness | unsupported: ₹11 Cr, ₹13.2 Cr |
| R003 | 1 | numeric_faithfulness | unsupported: ₹7.04 Cr, ₹5.61 Cr |
| R004 | 1 | figures | expects ₹1.68 Cr |
| R004 | 1 | numeric_faithfulness | unsupported: ₹1.85 Cr |
| R006 | 1 | figures | expects ₹12 Cr |
| R006 | 1 | figures | expects ₹12.5 Cr |
| R006 | 1 | numeric_faithfulness | unsupported: ₹13.2 Cr, ₹13.75 Cr. |
| A1 | 1 | figures | expects ₹29.7 Cr |
| A1 | 1 | figures | expects ₹1.32 Cr |
| A1 | 1 | numeric_faithfulness | unsupported: ₹32.67 Cr, ₹1.45 Cr, 74.38% |
| A2 | 1 | figures | expects 71.38% |
| A2 | 1 | numeric_faithfulness | unsupported: ₹23.32 Cr, 74.38% |
| A3 | 1 | figures | expects ₹1.68 Cr |
| A3 | 1 | numeric_faithfulness | unsupported: ₹1.85 Cr |
| A4 | 1 | figures | expects ₹13.8 Cr |
| A4 | 1 | numeric_faithfulness | unsupported: ₹15.18 Cr. |
| A5 | 1 | numeric_faithfulness | unsupported: ₹7.04 Cr, ₹5.61 Cr |
| A6 | 1 | figures | expects 24.64% |
| A6 | 1 | figures | expects 75.36% |
| A6 | 1 | numeric_faithfulness | unsupported: ₹3.74 Cr, ₹11.44 Cr, 27.64%, 78.36% |
| C1 | 1 | figures | expects 7.5% |
| C1 | 1 | numeric_faithfulness | unsupported: 10.5% |
| C2 | 1 | numeric_faithfulness | unsupported: ₹26.4 Cr, ₹12.65 Cr, ₹14.52 Cr |
| C3 | 1 | figures | expects ₹24 L |
| C3 | 1 | numeric_faithfulness | unsupported: ₹26.4 L, 4.24%, 7.71% |
| C4 | 1 | figures | expects ₹60 L |
| C4 | 1 | numeric_faithfulness | unsupported: ₹66 L |
| C5 | 1 | numeric_faithfulness | unsupported: ₹12.65 Cr |
| M1 | 1 | numeric_faithfulness | unsupported: ₹13.2 Cr, ₹10.12 Cr |
| M1 | 2 | figures | expects 6.52% |
| M1 | 2 | numeric_faithfulness | unsupported: ₹79.2 L, 9.52%, 9% |
| M1 | 3 | figures | expects ₹17.7 Cr |
| M1 | 3 | numeric_faithfulness | unsupported: ₹19.47 Cr, ₹32.67 Cr |
| M1 | 4 | numeric_faithfulness | unsupported: ₹13.2 Cr, ₹79.2 L |
| M2 | 1 | numeric_faithfulness | unsupported: ₹7.04 Cr, ₹5.61 Cr |
| M2 | 2 | figures | expects ₹11.5 Cr |
| M2 | 2 | numeric_faithfulness | unsupported: ₹12.65 Cr, 62.59% |
| M3 | 1 | numeric_faithfulness | unsupported: ₹26.4 Cr, ₹12.65 Cr |
| H1 | 1 | figures | expects ₹45.5 Cr |
| H1 | 1 | numeric_faithfulness | unsupported: ₹50.05 Cr, ₹3.52 Cr |
| H2 | 1 | figures | expects ₹18.8 Cr |
| H2 | 1 | numeric_faithfulness | unsupported: ₹20.68 Cr. |
| H3 | 1 | figures | expects ₹21.2 Cr |
| H3 | 1 | numeric_faithfulness | unsupported: ₹23.32 Cr |
| W1 | 1 | numeric_faithfulness | unsupported: ₹13.75 Cr. |
| W1 | 2 | figures | expects ₹12.5 Cr |
| W1 | 2 | numeric_faithfulness | unsupported: ₹13.75 Cr. |
| W2 | 1 | numeric_faithfulness | unsupported: ₹15.4 Cr. |
| W4 | 2 | numeric_faithfulness | unsupported: ₹4.62 Cr. |
| X4 | 1 | numeric_faithfulness | unsupported: ₹1.85 Cr |
| F1 | 1 | figures | expects ₹29.7 Cr |
| F1 | 1 | numeric_faithfulness | unsupported: ₹32.67 Cr. |
| F3 | 1 | numeric_faithfulness | unsupported: ₹13.2 Cr, ₹9.35 Cr, ₹10.12 Cr |
