# Evaluation report — dev-stub

> **Conditions:** MOCK. The model is the keyword dev stub (no LLM). This is a negative control showing the graders detect a weak agent — it is NOT evidence of LLM quality. Timings exclude any model latency.

> **About this run (added by hand; regenerating the report replaces this note).**
> - Measured on **2026-10-10 UTC** against the **uncommitted working tree** on top of commit `fe57eb4`; the "Commit" row shows HEAD only.
> - Compared with `fe57eb4`, the tree adds:
>   - propose → confirm property updates through the existing tools;
>   - clarifying questions for incomplete update requests;
>   - unique tool-call ids (fixes a cold-start id collision seen on the live site);
>   - the restored `\broi\b` pattern.
> - Compared with the `fe57eb4` run, checked against the raw results in `eval/results/`:
>   - **0 grader checks got worse, and 10 got better**;
>   - R006, W1 and W2 (property updates) now pass.
> - **G2's clarification check** passes here because the stub really asks "which one of your properties do you mean?". In the `fe57eb4` run it passed only because the generic help text happened to contain a question mark.
> - Earlier results are kept below as labelled **historical** sections.

| | |
|---|---|
| Model | dev-stub (keyword router, mock) |
| Started | 2026-10-10T20:41:14.775Z |
| Repeats | 1 |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 |
| Commit | fe57eb4 |

## Scores

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
| sample_request | 6 | 6 | 4 |
| analysis | 6 | 6 | 5 |
| calculation | 5 | 5 | 2 |
| ambiguity_data_gap | 4 | 4 | 3 |
| multi_turn | 3 | 8 | 0 |
| hypothetical | 3 | 3 | 0 |
| property_update | 5 | 10 | 2 |
| authorization_safety | 4 | 4 | 4 |
| failure | 4 | 4 | 3 |
| **Total** | **40** | **50** | **23** |

## Server-side timings (ms, successful turns)

| Span | n | p50 | p95 | max |
|---|---|---|---|---|
| totalMs | 49 | 34 | 47 | 84 |
| llmMs | 49 | 26 | 33 | 39 |
| toolMs | 49 | 0 | 2 | 22 |
| request_validation | 50 | 0 | 0 | 0 |
| context_load | 50 | 0 | 0 | 1 |
| agent | 50 | 33 | 46 | 78 |
| persist | 50 | 0 | 0 | 0 |

Model calls per turn: p50 2, max 3. Tool calls per turn: p50 1, max 1.

## Token estimates (cl100k approximation, for cost planning only)

86 model calls · input tokens/call p50 4873, p95 6082, max 6902 · output tokens/call p50 78, max 279 · totals: 430137 in / 8075 out.

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
| A6 | 1 | figures | expects 24.64% |
| C3 | 1 | tool_selection | missing: portfolio_analytics; used: [search_properties] |
| C4 | 1 | tool_selection | missing: search_properties; used: [] |
| C4 | 1 | arguments | search_properties args mismatch; got [] |
| C4 | 1 | figures | expects ₹60 L |
| C4 | 1 | content | mentions P003 |
| C5 | 1 | arguments | search_properties args mismatch; got [{"filter":{"assetClasses":["OFFICE"]}}] |
| C5 | 1 | content | does not mention P007 |
| G3 | 1 | clarification | asked=false staged/applied=false |
| M1 | 4 | figures | expects -19.4 pp |
| M2 | 2 | tool_selection | missing: portfolio_analytics \| compare_groups; used: [] |
| M2 | 2 | figures | expects ₹11.5 Cr |
| M3 | 2 | content | mentions P008 |
| H1 | 1 | arguments | run_scenario args mismatch; got [{"excludePropertyIds":["P009"]}] |
| H1 | 1 | figures | expects ₹45.5 Cr |
| H2 | 1 | tool_selection | missing: run_scenario; used: [] |
| H2 | 1 | figures | expects ₹18.8 Cr |
| H2 | 1 | hypothetical | hypothetical=false |
| H3 | 1 | tool_selection | missing: run_scenario; used: [] |
| H3 | 1 | arguments | run_scenario args mismatch; got [] |
| H3 | 1 | figures | expects ₹21.2 Cr |
| H3 | 1 | hypothetical | hypothetical=false |
| W3 | 1 | tool_selection | missing: propose_new_property; used: [search_properties] |
| W3 | 1 | arguments | propose_new_property args mismatch; got [] |
| W3 | 1 | clarification | asked=false staged/applied=false |
| W3 | 2 | tool_selection | missing: propose_new_property; used: [] |
| W3 | 2 | arguments | propose_new_property args mismatch; got [] |
| W3 | 2 | content | mentions P001 |
| W4 | 1 | clarification | asked=false staged/applied=false |
| W4 | 2 | tool_selection | missing: propose_new_property; used: [search_properties] |
| W4 | 2 | arguments | propose_new_property args mismatch; got [] |
| W4 | 2 | proposal | expected CREATE_PROPERTY, got none |
| W4 | 3 | tool_selection | missing: confirm_pending_action; used: [] |
| W5 | 1 | clarification | asked=false staged/applied=false |
| F4 | 1 | tool_selection | missing: flag_for_human; used: [] |
| F4 | 1 | handoff | handoff=false |
