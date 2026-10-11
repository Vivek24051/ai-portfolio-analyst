# Performance & Evaluation

> **Status: free-only evaluation.** Everything below was measured on a local machine with **mocked models**: the oracle reference policy, the keyword dev stub, and synthetic OpenRouter payloads. **No real LLM has been called.**
>
> These results therefore cover our own pipeline (HTTP, auth, validation, LangGraph, tools, persistence, SSE) and the correctness of the harness and graders. They do **not** say anything about real model quality, model latency, tokens, or cost, which are intentionally not measured (§5, §6).

## 1. Methodology

### 1.1 What is measured, and where

Every chat turn records the following on its `AgentRun` (see `/admin` and `/admin/conversations/:id`):

| Signal | Source |
|---|---|
| `request_validation`: auth, body parsing, rate limit | the route records `performance.now()` on arrival |
| `context_load`: conversation, history, state, properties | `RunRecorder.span` |
| `agent`: LangGraph loop, i.e. model calls plus tool calls | `RunRecorder.span` |
| Each model call: model, duration, time to first token (when streamed), fallback flag, error, tokens, cost | `invokeWithFallback` |
| Each tool call: name, outcome, duration | tools node → `ToolCall` rows |
| `persist`: messages, state, flags (atomic) | `RunRecorder.span` |
| `totalMs`: request receipt → persisted | `RunRecorder` |
| Numeric faithfulness: figures in the reply vs. tool output | `checkNumericFaithfulness` |

**Missing ≠ zero.** Tokens and cost are recorded **only** if the provider reports them. A run total is `null` unless every successful call reported the figure, and the admin pages show "—" for unknown values. Cost is read from `response_metadata.usage.cost`. That path is verified against **synthetic** OpenRouter payloads (`tests/openrouter.test.ts`) but not against a live response.

### 1.2 Test conditions used in this document

| Label | Model | Store | Transport | Purpose |
|---|---|---|---|---|
| **In-process** | oracle mock (≈0 ms) | in-memory | function call | our server pipeline overhead |
| **HTTP** | dev stub, 0 ms artificial delay | in-memory | `next start`, loopback | adds Next.js routing, cookies, JSON and SSE framing |
| **Eval** | oracle / perturbed / dev stub | in-memory | function call | correctness metrics; timings include the tokenizer wrapper |

Machine for all runs: AMD Ryzen 7 4800HS (16 threads), Windows 11, Node 20.20.2. The client and server ran on the same machine.

## 2. Results (measured)

### 2.1 Server pipeline: in-process, mock model ([full report](docs/eval/bench-inprocess.md))

1,440 turns: 48 golden turns × 30 iterations, after one warm-up pass.

| Per turn (ms) | p50 | p95 | max |
|---|---|---|---|
| Wall time (high resolution) | 4.1 | 6.4 | 10.6 |
| `agent` span (LangGraph and tools) | 4 | 6 | 9 |
| `context_load` | 0 | 0 | 1 |
| `persist` | 0 | 0 | 2 |
| Tool calls (each, every tool) | 0 | ≤ 1 | 2 |

**Reading:** with a zero-latency model, our own pipeline costs about **4 ms** per turn, and almost all of it is graph orchestration. Tools and the in-memory store are sub-millisecond, because the portfolios are tiny (3 properties per user). Spans are stored as whole milliseconds, so sub-millisecond work shows as 0.

### 2.2 HTTP: local production build, dev stub ([full report](docs/eval/bench-http.md))

100 requests per endpoint: 4 prompts × 25 iterations.

| Measure (ms) | p50 | p95 |
|---|---|---|
| JSON `/api/chat`, client total | 9.6 | 12.5 |
| JSON `/api/chat`, server `totalMs` | 6.0 | 8.0 |
| SSE `/api/chat/stream`, response headers | 3.4 | 5.1 |
| SSE, first event / first token / done | 10.3 | 13.6 |

**Reading:** Next.js, HTTP, and SSE framing add about 3–4 ms on top of the server total.

With a zero-delay stub the whole turn finishes in about 7 ms, so all SSE events arrive in the same network chunks and "first event" equals "done". To check that streaming really is incremental, I re-ran with a 100 ms per-word stub delay: 28 deltas arrived spread from 75 ms to 3,014 ms, followed by `done` at 3,128 ms. No compression or buffering was applied (`Content-Type: text/event-stream`, chunked, no `Content-Encoding`).

### 2.3 Evaluation scores ([oracle](docs/eval/oracle.md) · [perturbed](docs/eval/perturbed.md) · [dev stub](docs/eval/dev-stub.md))

Golden set: **40 cases, 50 turns** across 9 categories (§3). The scores validate the harness and graders, not a model:

| Metric | Oracle (positive control) | Perturbed oracle (negative control: figures) | Dev stub, historical (commit `76a9571`, when it was the negative control) |
|---|---|---|---|
| Cases fully passed | **40/40** | 12/40 | 17/40 |
| Tool selection | 42/42 | 42/42 | 22/42 |
| Argument accuracy | 20/20 | 20/20 | 7/20 |
| Expected figures stated | 23/23 | 1/23 | 10/23 |
| Numeric faithfulness | 34/34 | **1/34** | 31/31 * |
| Clarification behaviour | 7/7 | 7/7 | 0/7 |
| Proposal / no proposal | 14/14 | 14/14 | 10/14 |
| Hypothetical labelling | 5/5 | 5/5 | 0/5 |
| Safety violations | **0** | 0 | 0 |

\* The dev stub copies figures verbatim from tool output (first as raw JSON, then through fixed reply templates; the scores were identical both ways), so its numbers trivially trace to tool output. This is why a separate figure-perturbing control is needed.

**The dev-stub column is historical** (stub at commit `76a9571`).

**Later stub results** (offline, `npm run eval:stub`; history in [docs/eval/dev-stub.md](docs/eval/dev-stub.md)):

| Stub version | Cases | Faithfulness | Clarification | Safety |
|---|---|---|---|---|
| `fe57eb4` (first deployment) | 20/40 | 33/33 | 2/7 | 0 |
| `5996dba` (deployed at the time) | 23/40 | 35/35 | 2/7 | 0 |
| Current working tree, 2026-10-10 UTC | **40/40** | 37/37 | 7/7 | **0** |

The current tree also scores tool selection 42/42, arguments 20/20, expected figures 23/23, proposals 14/14 and hypothetical labelling 5/5.

**Read the 40/40 with care.**
- The stub's patterns were written while looking at the golden set's wording, so **it no longer works as a negative control**.
- It does not show that the stub generalises, and it is not a measure of LLM quality.
- What it does show: the tools, safeguards and templates handle all 40 scenarios, and no grader check got worse than in any earlier run (compared check by check on the raw results).
- The perturbed oracle remains the control for made-up figures.
- An earlier intermediate version measured 8 safety flags and 16 unsupported figures, from help text containing example ids, and misrouted "best rental yield". Both were caught by this evaluation and fixed (DECISIONS D54).

The one perturbed reply that still "passed" faithfulness (G2) contains no ₹ or % figure, so there was nothing to falsify. That's correct behaviour, not a gap in the check.

**What this shows:**
- **Oracle:** the tools, numbers, flags, and safety invariants produce exactly the expected outcomes for an ideal agent.
- **Perturbed oracle:** the faithfulness metric catches falsified figures independently of tool behaviour; tool selection and arguments still score 100% when only the numbers are wrong.
- **Dev stub:** the behavioural graders (clarification, hypothetical labels, tool choice) catch a weak agent.

**What it does not show:** how any real LLM scores. These are **grader and control tests**, not AI-quality results. A real-model evaluation is intentionally out of scope for this free-only submission (§5).

### 2.4 Token planning estimates (cl100k approximation; not usage)

| | Value |
|---|---|
| Model calls per golden pass (oracle policy) | 95 (p50 2 per turn, max 3) |
| Input tokens per call | p50 4,693 · p95 5,338 · max 6,419 |
| Tool schemas alone | **≈3,900 tokens per call** (~83% of input) |
| System prompt (U001, no state) | ≈670 tokens |
| Output tokens per call (oracle's short replies) | p50 33, max 76; real models will write more |

## 3. Golden set and coverage

`eval/cases.ts` (40 cases, 50 turns). Expected figures are **hand-derived literals**, not values computed by the code under test.

| Category | Cases | Examples |
|---|---|---|
| sample_request | 6 | R001–R006 from `sample_requests.csv` (including strict "above ₹10 Cr", Alibaug ≠ Mumbai, missing fields) |
| analysis | 6 | The six questions in the brief (§2.2) |
| calculation | 5 | Yield tie P010 = P011 = 7.5%, Delhi NCR expansion, lowest rent ignoring vacant properties |
| ambiguity_data_gap | 4 | Appreciation without dates, ambiguous "my Mumbai property", add with no details, market prices |
| multi_turn | 3 | The brief's retail → better → exclude Bandra → change conversation; follow-up totals |
| hypothetical | 3 | Revalue, hypothetical purchase, sell vacant office; real data must stay unchanged |
| property_update | 5 | Propose → yes → saved; decline; the brief's near-duplicate add; create flow; missing rent |
| authorization_safety | 4 | Other client's portfolio, other user's property id, prompt injection, cross-user figures |
| failure | 4 | Primary down → fallback; all down; invalid arguments → recovery; human handoff |

**Graders** (`eval/graders.ts`, all deterministic, no LLM judge):
- tool selection, with alternatives allowed and forbidden tools;
- partial-match argument checks;
- expected figures, matched by value with a rounding tolerance;
- numeric faithfulness;
- must and must-not mentions;
- clarification (asked, and nothing staged);
- proposal, hypothetical, handoff, status, and fallback flags.

**Case-level safety checks:** compare the store with the seed after the case. Any write the case didn't declare, any write to another user's property, or a missing expected write is a failure. Another user's property ids or names in a reply count as leakage, unless the user typed them first.

**Unit and integration coverage** (`npm run test:coverage`; an earlier run of 325 tests, not re-measured since):

| Measure | Coverage |
|---|---|
| Lines | 90.3% |
| Statements | 88.33% |
| Functions | 86.47% |
| Branches | 76.09% |

| Area | Line coverage |
|---|---|
| `src/domain` | 98.4% |
| `src/lib` | 96.9% |
| `src/agent` | 97.9% |
| `src/components` | 91.9% |
| `src/server` | 84.0% |
| `src/app` | 77.6% |

`src/server/stores/prisma.ts` and `src/server/db.ts` show **0%** here, because `npm test` uses no database. The Prisma layer is exercised by the separate opt-in `npm run test:db` suite, which passed 14/14 against a local PostgreSQL 16 test database (Docker) and isn't included in these coverage figures. `src/server/container.ts` is at 46%: only its provider selection is tested, not the real wiring.

## 4. Where time goes, and what was done about it

**Measured:** without a model, a turn costs about 4 ms on the server and about 10 ms over local HTTP.

**Not measured yet:** with a real model, latency will be dominated by LLM round trips. The number of round trips is a property of our design and is already measured: p50 is **2 model calls per turn** (tool call, then answer) and the maximum is 3 in the golden set.

**Bounded quota use per turn** (D58; tested offline with synthetic Gemini responses only):
- Real model calls are capped at `LLM_MAX_MODEL_CALLS_PER_TURN` (default 4) per user turn, across tool rounds and the fallback chain. Without the cap the worst case was (5 tool rounds + 1) × 2 models = 12.
- A model that returned 429 is skipped by later turns until its cooldown ends (`Retry-After`, else Gemini's retry hint, else 60 s; at most 15 min).
- The client makes no automatic retries (`maxRetries: 0`).
- **Not measured:** how many calls a real model actually makes per turn, and whether rejected or timed-out requests count toward the free quota.

**Latency work already in place:**
- **Aggregating tools,** so most questions need one tool round. `portfolio_analytics` returns totals, mix, extremes, and data gaps in one call.
- **A property index without numbers in the prompt.** "The Bandra one" is resolved without a lookup round trip.
- **Parallel execution** of read-only tool calls within a round.
- **Streaming,** so the first answer token reaches the user before the reply is complete.
- **An LLM-free Confirm button** for writes.
- **A per-turn fallback circuit breaker.** Once the primary fails, the rest of the turn skips it instead of waiting for its timeout again.
- **No fallback on 401/402.** Same key, same result, so no wasted round trip.
- **No SDK retries** (`maxRetries: 0`). Worst-case latency stays bounded by the timeouts: 20 s per call, 50 s per turn.
- **Bounded history** (30 messages) with old tool payloads trimmed.

**Next optimisations, by impact:**
1. **Prompt caching for the static prefix** (tool schemas and rules, about 4.5k tokens). Where a provider supports prompt caching, the identical prefix on every call is the part that benefits; the size of that effect is not measured here.
2. **Trim tool schemas** (shorter descriptions, fewer optional fields). They are 83% of input tokens.
3. **Route simple lookups to a cheaper or faster model,** if the evaluation shows equal accuracy.

## 5. Real-model evaluation: not performed (free-only scope); manual checks only

This submission is deliberately **free**.
- No test, evaluation script or benchmark calls an LLM endpoint, and none is needed to build, test or run the app.
- The live demo runs **Gemini 3.5 Flash Lite on the free tier** (since 2026-10-11), with 3.1 Flash Lite and the labelled stub as fallbacks.
- The mixed-provider fallback chain (Gemini → OpenRouter `:free` → stub) is tested **offline with scripted models only**.
- Its behaviour against live providers, including their real 429/401/402 responses, has not been observed.

**Gemini (free tier) was checked by hand on 2026-10-11:**
- **Flows checked:** overview, follow-up, what-if, and propose → cancel locally; overview and follow-up on the live site. All answered by Gemini, with the correct tool figures and no attention flag.
- **Latency observed:** tool-using turns took about **3–4 s** end to end. The admin dashboard showed 3,071 ms for one local turn. This is a handful of turns, not a benchmark; there is no p50/p95 for Gemini.
- **Tokens and cost:** not reported. Gemini's streamed replies carry no usage figures on this endpoint, so the dashboard shows "—".
- **Bug found by the first real call:** Gemini 3.x rejected tool follow-ups without the tool call's thought signature. Fixed in D59; until then the stub answered, as designed.
- **Not run:** the 40-case evaluation. It would need a Gemini mode in the runner and would use a few hundred free-tier requests.

What exists, so a real-model run could be added later without code changes:
- `npm run eval -- --mode openrouter` replays the same 40 golden cases and graders against a real model.
- It **refuses to start** unless `EVAL_ALLOW_PAID=1`, `--confirm-paid`, `OPENROUTER_API_KEY`, `LLM_PRIMARY_MODEL`, `--max-calls`, and `--max-cost-usd` are all set, **and** the model id ends in `:free`. A paid id needs the separate `OPENROUTER_ALLOW_PAID=true` opt-in, which is off by default; the rule is the app's own, re-checked before the client is built. It then stops at whichever cap it reaches first. These guards are unit-tested in `tests/eval.test.ts`, with no network. **It has never been run.**
- The request shape, response parsing, streaming, usage and cost extraction, timeouts, and fallback were verified offline against synthetic OpenRouter payloads (`tests/openrouter.test.ts`).

The **workload** of such a run is known from offline measurement (§2.4): one pass makes about 95 model calls under the oracle policy, more with a real model, at about 4.7k input tokens per call. Prices, latency, and quality are **not** known and are not estimated here.

## 6. Not measured: needs real infrastructure

| Measurement | Needs | Status |
|---|---|---|
| Real model latency, time to first token, tokens, and cost per turn | A real LLM (Gemini free tier, now live) | Only observed by hand: about 3–4 s per tool-using turn over a handful of turns. Tokens and cost are not reported by the provider; no TTFT or percentiles recorded |
| Real tool calling on a free OpenRouter model; whether a given `:free` model is available and supports tools | OpenRouter (no credits) | Not verified; the guard checks only the id suffix |
| Fallback-chain behaviour against live 429 / 401 / 402 and latency of a fallback hop | Real providers | Not measured; tested with scripted models only |
| Real tool-selection, argument, faithfulness, and clarification accuracy | A real LLM | Not measured. The golden set has not been run against Gemini |
| Whether live OpenRouter responses carry `usage.cost` where we read it | A real LLM via OpenRouter | Verified only on synthetic payloads |
| Correctness of the Prisma store, migration, and seed | A Postgres database | **Verified** with `npm run test:db` (14/14) on a local PostgreSQL 16 test database (Docker) |
| PostgreSQL latency for context load and persist; a hosted or pooled database (e.g. Neon) | A hosted database | Not measured. The live app runs on Neon and was checked by hand, with no automated suite or timing |
| Latency over the internet and from a deployment region | A deployment | Not measured systematically. The app is deployed (Vercel + Neon, Gemini); only the hand-checked turns above were observed |
| Behaviour under concurrent load | A load test | Not performed (single sequential client only) |

## 7. Scaling: what changes at significantly higher volume

The analysis below is reasoned from the measured structure: about 4 ms of server work, 2 model calls per turn, and about 4.7k input tokens per call. It is not a load-test result.

- **LLM time and cost dominate.** Throughput scales with provider rate limits and spend, not CPU. Use per-tenant rate limits with a shared store (the current limiter is per instance), and add a second provider (fallback is already in place) to spread rate-limit pressure. Prompt caching and schema trimming (§4) reduce cost per turn.
- **Stateless app tier.** All state lives in the store, so Next.js instances scale horizontally. Serverless functions hold a connection for the whole SSE turn (≤ 50 s deadline), so concurrency limits and duration billing matter. At high volume, move the agent loop to a long-running worker or a platform with streaming-friendly pricing.
- **Database.** Use `DATA_BACKEND=prisma` with Neon's pooled connection string. The current queries are indexed per user and per conversation. Analytics currently load a user's whole portfolio into memory (fine for tens or hundreds of properties); for thousands per user, push the aggregations into SQL.
- **WhatsApp at scale.** A real WhatsApp webhook must return quickly, so put a queue (e.g. SQS or Redis) between the webhook and the agent worker, and send replies through the WhatsApp API. This is the concrete reason to add a queue, and it doesn't exist in this scope.
- **Shared limits.** The rate limiter and admin lockout move to a shared store (Redis or Postgres) so limits hold across instances.
- **History growth.** History is already capped at 30 messages. Add summarisation of older turns if conversations get long.
- **Observability.** Run and tool-call rows grow linearly. Add retention (for example, 30 days of full traces with older ones aggregated) and export to a tracing backend if needed.
