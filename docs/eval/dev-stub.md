# Evaluation report — dev-stub

> **Conditions:** MOCK. The model is the keyword dev stub (no LLM). It was designed as a negative control, but it has since been tuned against these cases (see the note below). It is NOT evidence of LLM quality. Timings exclude any model latency.

> **About this run (added by hand; regenerating the report replaces this note).**
> - Measured on **2026-10-10 UTC**, offline, against the **uncommitted working tree** on top of commit `5996dba`. The "Commit" row shows HEAD only.
> - Compared with `5996dba`, the tree adds stub coverage of every remaining case:
>   - filters, rankings, totals and comparisons;
>   - absolute, purchase and described-property what-ifs;
>   - new properties through `propose_new_property`;
>   - status changes;
>   - hand-off through `flag_for_human`.
>
>   It also adds the mixed-provider fallback chain, which this stub-only run does not exercise.
> - **Comparison** (check by check, on the raw results in `eval/results/`): against `5996dba` and every later run, **no grader check got worse**.
>   - A few figure checks exist in only one run, because a figure check applies only when a reply contains figures.
>   - Every clarification pass is a real question, not the grader's "?" quirk.
> - **Read 40/40 with care.**
>   - The stub's patterns were written while looking at these 40 cases' wording, so **the stub no longer works as a negative control**.
>   - 40/40 shows that the tools, safeguards and templates handle every scenario. It does **not** show that the stub generalises to other phrasing, and it says nothing about LLM quality.
>   - The perturbed oracle remains the control for made-up figures.
> - **No real model** (Gemini or OpenRouter) was called. Real-model latency and tool calling are unmeasured.
> - Earlier results are kept below as labelled **historical** sections.

| | |
|---|---|
| Model | dev-stub (keyword router, mock) |
| Started | 2026-10-10T21:59:21.488Z |
| Repeats | 1 |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 |
| Commit | 5996dba |

## Scores

| Metric | Result |
|---|---|
| Cases fully passed | 100.0% (40/40) |
| Tool selection | 100.0% (42/42) |
| Argument accuracy | 100.0% (20/20) |
| Expected figures stated | 100.0% (23/23) |
| Numeric faithfulness (replies whose every number traces to tool output) | 100.0% (37/37) |
| Clarification behaviour | 100.0% (7/7) |
| Proposal / no-proposal correct | 100.0% (14/14) |
| Hypothetical labelling | 100.0% (5/5) |
| Content (must / must-not mention) | 100.0% (45/45) |
| Reply patterns | 100.0% (4/4) |
| Handoff / status / fallback | 100.0% (4/4) |
| **Safety violations** | **0** |
| Expected writes missing | 0 |

### Historical: live deployment (commit `5996dba`, 2026-10-10T20:41Z)

| Metric | Result |
|---|---|
| Cases fully passed | 57.5% (23/40) |
| Tool selection | 71.4% (30/42) |
| Argument accuracy | 55.0% (11/20) |
| Expected figures stated | 65.2% (15/23) |
| Numeric faithfulness (replies whose every number traces to tool output) | 100.0% (35/35) |
| Clarification behaviour | 28.6% (2/7) |
| Proposal / no-proposal correct | 92.9% (13/14) |
| Hypothetical labelling | 60.0% (3/5) |
| Content (must / must-not mention) | 88.9% (40/45) |
| Reply patterns | 100.0% (4/4) |
| Handoff / status / fallback | 75.0% (3/4) |
| **Safety violations** | **0** |
| Expected writes missing | 1 |

### Historical: first deployed version (commit `fe57eb4`, 2026-10-10T20:18Z)

| Metric | Result |
|---|---|
| Cases fully passed | 50.0% (20/40) |
| Tool selection | 64.3% (27/42) |
| Argument accuracy | 45.0% (9/20) |
| Expected figures stated | 56.5% (13/23) |
| Numeric faithfulness (replies whose every number traces to tool output) | 100.0% (33/33) |
| Clarification behaviour | 28.6% (2/7) |
| Proposal / no-proposal correct | 71.4% (10/14) |
| Hypothetical labelling | 60.0% (3/5) |
| Content (must / must-not mention) | 88.9% (40/45) |
| Reply patterns | 100.0% (4/4) |
| Handoff / status / fallback | 75.0% (3/4) |
| **Safety violations** | **0** |
| Expected writes missing | 2 |

### Historical: previous stub (commit `76a9571`, 2026-10-10T15:45Z)

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

### Intermediate: extended stub before the fixes (uncommitted, 2026-10-10T20:13Z)

Cases 15/40 · tool selection 27/42 · arguments 8/20 · figures 13/23 · numeric faithfulness 33/49 · clarification 2/7 · proposals 10/14 · hypothetical 3/5 · content 41/45 · patterns 4/4 · handoff/status 3/4 · **safety violations 8** (all from help text naming example ids) · expected writes missing 2.

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
| totalMs | 49 | 35 | 52 | 92 |
| llmMs | 49 | 28 | 35 | 43 |
| toolMs | 49 | 0 | 2 | 21 |
| request_validation | 50 | 0 | 0 | 0 |
| context_load | 50 | 0 | 0 | 1 |
| agent | 50 | 34 | 51 | 85 |
| persist | 50 | 0 | 0 | 0 |

Model calls per turn: p50 2, max 3. Tool calls per turn: p50 1, max 1.

## Token estimates (cl100k approximation, for cost planning only)

95 model calls · input tokens/call p50 4859, p95 5592, max 6955 · output tokens/call p50 67, max 279 · totals: 471509 in / 8397 out.

## Safety violations

None.

## Failed checks

None.
