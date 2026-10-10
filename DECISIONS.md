# Decision Log

Each entry: decision, why, trade-off. Labels: **[fact]** comes from the brief or data; **[assumption]** is my interpretation.

## D1. A single tool-calling agent, no multi-agent setup
Every capability works on one user's small, structured portfolio. A router agent plus specialist agents would add an extra LLM hop per turn (latency and cost) and more handoff failure points, with no gain in accuracy.
**Trade-off:** the single agent's prompt and tool list must stay small and well described. Revisit if the number of tools grows beyond about 10–12.

## D2. LangGraph.js for orchestration (approved)
The agent loop (model ↔ tools), the step cap, and error edges are explicit graph structure, which is easy to explain and to trace.
**Trade-off:** it is heavier than a plain loop or the Vercel AI SDK. Mitigation: use a small custom graph rather than the prebuilt black-box agent.

## D3. PostgreSQL + Prisma, and SQL retrieval rather than vector search
The data is tabular and the questions are exact filters and aggregates: type, city, value thresholds. Embeddings would make answers that need to be precise less precise. Postgres also stores conversations, runs, tool calls and pending actions for the admin dashboard.
**Trade-off:** free-text questions about unstructured documents (leases, for example) would need RAG later. There are none in scope.

## D4. Money stored as BigInt whole rupees, numbers in domain code
Postgres `int4` overflows at about ₹214 Cr, which one large office could exceed. Domain code uses JS numbers after a safe-integer check, which is exact up to about ₹9×10¹⁴ Cr.
**Trade-off:** BigInt ↔ number conversion is needed at the repository boundary.

## D5. The LLM never does arithmetic, including unit conversion
Tools take money as `{amount, unit: INR|THOUSAND|LAKH|CRORE}` and the backend converts. All totals, shares, yields, rankings and scenario deltas come from `src/domain/analytics.ts` and `scenario.ts`. The model writes the explanation around those numbers.
**Why:** LLMs often miscount the zeros in "₹12.5 Cr". Deterministic code is testable; prompts are not.

## D6. Property type normalisation [fact + assumption]
- [fact] `Commercial Office` (P002, P007, P008) and `Office` (P011) describe the same kind of asset.
- Both map to `OFFICE`, and the raw label is kept for display and audit.
- [assumption] **COMMERCIAL = RETAIL + OFFICE.** This is standard industry usage, but the brief doesn't define it, so answers say so when they use it.
- Bare "Commercial" as a property type is rejected as ambiguous rather than guessed.

## D7. Location parsing [fact + assumption]
- [fact] `location` is free text, "Locality, City".
- [fact] P006 is `Alibaug, Maharashtra`, which has a state where the city should be.
- [assumption] When the last segment is a known state, the locality is used as the city, so P006's city is Alibaug. "Properties in Mumbai" therefore excludes it, which is correct geographically.
- "Delhi NCR" (U003's city) expands to the NCR cities so that region queries work.
- City matching is exact after aliasing (Bangalore → Bengaluru, Gurgaon → Gurugram). Locality matching is by substring ("Bandra" matches "Bandra West").

## D8. Missing data is reported, never guessed [fact]
- `purchase_price_inr` is blank for 12/12 rows. DATASET.md says "mostly", but the PDF and the CSV both have it blank throughout.
- There are no dates anywhere.
- Analytics return a `dataGaps` list, and the agent must not estimate appreciation or ROI.
- Seed inconsistencies, such as rent recorded on a vacant property, are **reported** in the seed log and never silently corrected. The seed data has none.

## D9. Yield and ranking conventions
- Gross yield = annual rent ÷ current estimated value. It is the only yield possible without cost data.
- Two portfolio yields are reported:
  - across all properties
  - across income-producing properties only, because vacant and self-occupied properties pull the overall figure down
- Zero-rent properties are excluded from rent and yield rankings and listed with the reason.
- Ties share a rank. A limit never splits a tie: U004's P010 and P011 are both exactly 7.50%.
- "Performing better" is ambiguous. The agent states which metric it used, and gives both rent and yield when they disagree (U001 retail: P001 has the higher rent, P003 the higher yield).

## D10. Ownership % and status applied even though they are uniform in the seed data
Totals use value × ownership%, and only `ACTIVE` rows are counted. It costs nothing and stays correct for data added through chat.

## D11. Propose → confirm for every write
- The agent can only create a `PendingAction`, which is validated, diffed and checked for duplicates.
- The change is applied only when **all** of these hold:
  - the action belongs to this user and this conversation
  - it is still PENDING and has not expired (15 min)
  - confirmation comes in a **later turn** than the proposal
  - the user's latest message is an unambiguous yes (deterministic check), **or** the user tapped Confirm, a code path with no LLM involved
- The write and the status change share one transaction. A compare-and-set on the status prevents applying twice, and updates use optimistic locking on `version`.
- A new proposal cancels the previous one.

**Trade-off:** one extra turn for every write. That is the right cost for changes to financial records.

## D12. Near-duplicate detection on create
The brief's own example ("5,000 sq ft retail in Bandra worth ₹12 Cr") matches the existing P001 (5,200 sq ft, Bandra West, ₹12 Cr). A create with the same class and city, an overlapping locality, and area or value within 15% is held back. The agent must ask whether this is an update or a separate property, and can retry with `allowDuplicate` only after the user says it is new.

## D13. User scoping through persistence interfaces
- Every store method takes `userId` and puts it in the WHERE clause.
- A property owned by another user is indistinguishable from one that doesn't exist (`null` / "not found"), so nothing about other users is revealed.
- Tool schemas will not have a `userId` parameter. It comes from the signed session.
- Filter and scenario schemas are `.strict()`, so the model cannot add fields such as `userId`.

## D14. In-memory store implementation alongside Prisma
It lets the confirmation and authorization logic be unit-tested without a database, and later allows offline agent evaluations.
**Trade-off:** two implementations must keep the same semantics. Integration tests against Postgres are planned to check this.

## D15. Pinned stable dependency versions
Prisma 6.19 rather than the 8.0 RC tagged `latest`, TypeScript 5.9 rather than 7.0 (the new native compiler), and Vitest 4. Toolchain churn is the riskiest use of a 1–2 day timebox.

---
## Phase 2: agent, tools, memory

## D16. Our own code executes tools; LangGraph only orchestrates
The graph's `tools` node calls our executor instead of LangChain's tool runtime. That makes four things explicit and testable:
- zod validation, with errors returned to the model as structured `invalid_arguments` results instead of exceptions
- the trusted `ToolContext` (user id from the session)
- per-tool timeouts and timing
- reads run in parallel, writes in order

**Trade-off:** we give up some LangChain conveniences, such as callback tracing of tool runs. We replace them with our own run and tool-call records.

## D17. Tool arguments can never carry identity
Every tool schema is `.strict()` and has no `userId`. A smuggled `{"userId": "U002"}` is rejected as invalid, not ignored. The chat API body is strict in the same way. The user id comes only from the signed HS256 cookie (`jose`), and production refuses to start sessions without a real `SESSION_SECRET`.

## D18. Tools return pre-formatted figures and no raw integers
Tool output contains strings such as "₹12 Cr" and "71.38%". The model copies them and has nothing to do arithmetic on. The property index in the system prompt deliberately contains **no** numbers, so any numeric answer needs a tool call. This is enforced by a test.
**Trade-off:** slightly larger tool payloads.

## D19. Tool budget: 5 rounds, then one call without tools, then a deterministic stop
After 5 tool rounds, the model is called once more with no tools and told to answer from what it has. If it still asks for tools, which only a misbehaving provider would do, the `limit` node ends the turn with a fixed reply and flags the conversation. The recursion limit is set from the same constant.

## D20. Timeouts that cannot be garbage-collected
`AbortSignal.any([parent, AbortSignal.timeout(ms)])` failed to fire in our tests against a hung provider. The combined signal is held only weakly, so when the pending call is reachable only through its own abort listener, the whole cycle can be collected and the timeout never fires.

`createDeadline` instead uses an `AbortController` driven by a `setTimeout` that holds a strong reference. `raceAbort` also rejects even if a provider SDK ignores the signal.

Two layers of timeout:
- per model call (default 20 s), which triggers fallback
- per turn (default 50 s, under Vercel's 60 s function limit), which produces a safe reply

## D21. Fallback policy
Any failure of the primary model triggers exactly one attempt on the fallback model: timeout, 429, 5xx, network error, or a non-AI response. Both attempts are recorded. Retries inside the SDK are disabled (`maxRetries: 0`) so that latency stays bounded and visible.
**Trade-off:** we don't retry the primary model on a brief glitch.

## D22. Memory = bounded transcript + structured state
- **Transcript:** the last 30 messages. The window always starts at a user message, so a tool result is never separated from its call. Old tool payloads are trimmed.
- **Structured state:** `focusPropertyIds`, `activeScenario`, `pendingActionId` and `consecutiveFailures`.
- The state is updated by **tool results**, never by the model's text. Follow-ups ("which one", "how would that change it") therefore resolve against backend facts, not the model's memory.
- **Not done:** summarising long conversations. It isn't needed at this scale (see PERFORMANCE.md, "At higher volume").

## D23. Failure replies never misstate what happened
- If the turn fails, only the user message and an apology are saved.
- If a confirmed write had already been committed in that turn, the apology says the change **was saved** instead of the default "your portfolio is unchanged". A test covers this.
- Model outages and deadline breaches return HTTP 200 with a safe reply and `status: "error"`, not a 500, and flag the conversation for attention.

## D24. Dev stub model and in-memory store as defaults
With no API key and no `DATABASE_URL`, the app still runs end to end: real graph, tools, analytics and persistence interface, with a keyword router in place of an LLM. Its replies are prefixed `[dev stub — no LLM configured]` so nobody mistakes them for agent output.
**Trade-off:** in-memory data is per process and resets on restart. Postgres is required for any shared or durable deployment.

## D25. The Confirm button skips the LLM
`POST /api/chat/actions` confirms or cancels a pending action deterministically, with no model call. It is faster and cheaper, and prompt injection cannot affect it. The LLM path (the user typing "yes") is still supported, with the same-turn and affirmation checks from D11.

---
## Phase 3: chat UI, streaming, dataset, migrations

## D26. Synthetic CSVs committed to `data/seed/`, PDF excluded
A fresh clone, and the evaluators, can run the tests and the app without any manual setup. The files are byte-identical copies, verified by checksum and by a fresh-clone test run. The assignment PDF and the root-level originals stay git-ignored. `outputFileTracingIncludes` ships `data/seed` with serverless deployments, because the in-memory backend reads the files at runtime.

## D27. Initial migration generated offline, with a drift test
`prisma migrate dev` needs a live database. Instead, `prisma migrate diff --from-empty` produced the init SQL, and `tests/migration.test.ts` fails if `schema.prisma` and the committed migration ever diverge. **Still unverified:** applying the migration to a real Postgres.

## D28. The session secret fails closed
The dev fallback secret is accepted only when `NODE_ENV` is explicitly `development` or `test`. Every other case throws, including an unset `NODE_ENV` and production. A secret shorter than 32 characters, or equal to the published dev value, is rejected everywhere.

## D29. SSE over `fetch`, not WebSockets or EventSource
- One request per turn with a one-way stream fits the problem exactly.
- It works through Vercel's serverless functions.
- It needs no extra infrastructure.

`EventSource` can't send a POST body, so the client reads the `fetch` body and parses the frames itself. Every check that can fail (auth, validation, rate limit, ownership) runs before the stream opens, so those failures stay ordinary HTTP status codes.

**Trade-off:** no server push outside a turn, which isn't needed here.

## D30. Stream protocol exposes progress, not internals
Events are `start`, `status`, `tool_start` / `tool_end` (a friendly label plus a one-line outcome such as "3 matches"), `delta`, `reset`, `done`, and `error`. Raw tool arguments and results, prompts, and error internals never leave the server; a test asserts that raw payload fields are absent from the stream.

`reset` handles two cases:
- a model that writes "let me check…" and then calls tools
- a primary model that fails mid-stream before the fallback answers

Either way the user never sees two half-answers spliced together.

## D31. Client disconnects don't cancel the turn
If the browser goes away mid-stream, the turn still finishes, is saved, and is recorded as a run. The emitter swallows write failures. This avoids "half-saved" states, for example a confirmation that was applied but whose reply was never saved.

## D32. UI state as a pure reducer; the server owns all logic
`chatReducer` is a pure function of `(state, action)`, so streaming, retry, and proposal transitions are unit-tested without a browser. The UI never computes figures or decides on writes:
- the proposal card renders the server's diff
- Confirm calls the server's LLM-free endpoint
- "hypothetical" is a server flag, recomputed from stored tool results when history is reloaded

## D33. Safe rendering of model text
Model output is rendered as React text nodes with a tiny formatter (paragraphs, bullet lists, bold), never as HTML. A test injects `<script>` and `<img onerror>` and asserts that no element is created.

---
## Phase 4: admin dashboard and observability

## D34. HTTP Basic auth for admin, enforced in every handler
A single business-team account is enough for this assignment, and Basic auth needs no login UI or session store.
- **Every admin page and API handler checks credentials itself.** The Next.js proxy only adds the browser's login prompt and `no-store` headers; Next's own docs advise against relying on the proxy for authorization. Unauthenticated page renders return a 404 with no data.
- **Fails closed:** no `ADMIN_PASSWORD` (or one under 12 characters) means 503, in development too. There is no dev fallback.
- **Constant-time comparison** of SHA-256 digests.
- **Lockout:** 10 failures per client per 5 minutes, after which even correct credentials are refused.

**Trade-offs:** no logout, no per-user roles, and the lockout counter lives in each server instance. For more operators or SSO, replace this with a proper identity provider.

## D35. CSRF guard on the one state-changing admin action
Browsers re-send cached Basic credentials automatically, so a cross-site form could otherwise trigger "Mark as resolved". The action requires a same-origin `Origin` or `Referer`.

The endpoint lives at `/admin/conversations/:id/resolve` rather than under `/api/admin`, because browsers scope cached Basic credentials by path; that way the form always carries the dashboard's credentials.

## D36. One explicit cross-user port: `AdminStore`
Every other storage interface is user-scoped. Cross-user reads exist only in `AdminStore`, which only admin-gated code may use (`src/server/admin/*`). Both backends implement it; tests exercise the in-memory one only, and say so.

## D37. Flags are resolved by a human, not cleared automatically
Resolving keeps `attentionReason` and records `attentionResolvedAt` and `attentionResolvedBy`. Any later flagging turn re-flags the conversation and clears the resolution.

The init migration was regenerated to add these columns, plus a `ToolCall.position` column for tool order. That was safe because the migration had never been applied to any database.

## D38. Missing metrics stay null
Token counts and cost come only from what the provider reports.
- A run-level total is `null` unless **every** successful model call reported the figure. A partial sum would look precise but would be wrong.
- A reported zero stays 0.
- The admin pages render `null` as "—" with a "not reported" tooltip.
- No cost is estimated from price tables.
- Extracting OpenRouter's cost field is written against **assumed** response shapes and hasn't been checked against a live call.

## D39. Timing starts at request receipt
Routes record `performance.now()` on arrival and pass it in. Each run then records these spans:
- `request_validation` (auth, body parsing, rate limit)
- `context_load`
- `agent` (model calls and tool calls, also listed individually)
- `persist`

The run telemetry write itself happens after `totalMs` is computed and is excluded.

## D40. Per-turn fallback circuit breaker
Found while building the traces: once the primary model failed in a turn, every later model call in that turn tried the primary again. With a hanging primary, that would cost the 20 s per-call timeout on **every** tool round.

Now the first primary failure sends the rest of that turn straight to the fallback. The next turn tries the primary again, so a brief outage doesn't pin traffic to the fallback.

## D41. Redaction before anything is logged or stored
- Error strings, which can echo provider request details, are redacted (API keys, bearer tokens, connection strings, secret key=value pairs, the configured secret values themselves) and length-capped before being logged or saved as `run.error`.
- Server logs print one redacted line per error, with no raw objects or stack dumps.
- Admin trace previews of tool arguments and results are redacted and capped at 1,500 characters.

A bug in the first version of the redactor (it treated the match offset as a captured group, which leaked a connection string) was caught by a test and fixed.

---
## Phase 5: evaluation and performance (zero-cost stage)

## D42. A deterministic golden set, with no LLM-as-judge
There are 40 cases and 50 turns. Every check is a rule over observable outcomes: tool calls from the run record, the reply text, the staged proposal, flags, and the store compared with the seed. Expected figures are hand-derived literals, so the oracle can't pass by agreeing with the code under test.

**Trade-off:** the rules can't judge tone or helpfulness. Those remain a manual review item, which matches the timebox and avoids paying for a second model to grade the first.

## D43. Positive and negative controls validate the graders
A grader that never fails is worthless, so each metric is shown to move:
- **Oracle reference policy** must pass 40/40, which shows the tools, numbers, flags, and expectations are right.
- **Perturbed oracle** (falsified figures) must fail numeric faithfulness while tool and argument scores stay at 100%, which shows the metrics are independent.
- **Dev stub** must fail the behavioural checks: 0% on clarification and on hypothetical labelling.

The oracle and perturbed runs are part of `npm test`.

## D44. Numeric faithfulness is enforced in production, not only in evaluation
`checkNumericFaithfulness` extracts ₹ (Cr/L/crore/lakh), %, percentage points, and plain numbers from each reply. Each one must match a number in this turn's or earlier turns' tool output, in the user's own words, or in a data label such as "Sector 29". Money may differ by up to 0.5% and percentages by up to 0.05 points, to allow normal rounding. Anything else flags the conversation as `unsupported_numbers`, and the result is recorded on the run and shown in the admin trace.

It is a detector, not a blocker. A false positive costs a human review, while blocking a correct answer would hurt users.

## D45. The OpenRouter integration is verified with an injected `fetch` and synthetic payloads
No paid calls were made. The real `ChatOpenAI` client runs against a fake `fetch` that returns OpenRouter-format JSON and SSE. This verified:
- the request shape: model, tools, `temperature: 0`, `parallel_tool_calls`, `usage.include`, `stream_options.include_usage`, the bearer key;
- parsing of tool calls, including arguments split across stream chunks;
- malformed arguments → `invalid_tool_calls`;
- usage and **cost location** (`response_metadata.usage.cost`, streamed and not);
- exactly one HTTP attempt per failure;
- redaction of secrets echoed in error bodies;
- fallback on 429/5xx, network errors, and garbage bodies;
- that a hung connection is actually aborted (the `fetch` signal fires).

**Not proven:** live provider behaviour.

## D46. No fallback on 401/402
An invalid key or exhausted credits fail identically on the fallback model, because it's the same key and the same account. Retrying would add a wasted round trip and could mislead the error log, so the turn ends with a clear error instead.

## D47. Benchmarks keep their conditions attached
In-process (mock model), HTTP (local `next start`, dev stub), and eval-runner timings are reported separately, each with machine, workload, and conditions. Eval-runner "model" time includes the token-estimation wrapper and is not used as a latency figure.

Token counts for planning use cl100k and are labelled as estimates; they are never stored as usage. Two operational knobs were added for benchmarking: `CHAT_RATE_LIMIT_PER_MIN` and `DEV_STUB_STREAM_DELAY_MS`.

---
## Free-only follow-ups

## D48. Readable dev-stub replies from fixed templates
The stub used to print raw tool JSON, which was unreadable in a demo. It now fills fixed templates (`src/agent/stubFormat.ts`) with strings copied verbatim from the tool result, so the numeric-faithfulness check still passes. Replies stay labelled `[dev stub — template reply, no LLM]`. The dev-stub evaluation scores were identical before and after the change.

## D49. Google Gemini as the free real-model option
OpenAI and Anthropic APIs have no free tier; Gemini does. It is reached through Gemini's OpenAI-compatible endpoint by the same `ChatOpenAI` client, configured with a provider profile:
- **Standard fields only.** No OpenRouter-only fields (`usage.include`, `parallel_tool_calls`, the `X-Title` header).
- **Stream usage not requested,** to avoid a rejected request. Tokens may therefore be reported as unknown (null), never as zero.
- **Fallback is a second Gemini model,** because free-tier rate limits are per model.
- **Incomplete Gemini settings fall back to the free dev stub,** never to a paid provider.
- **Key safety.** The key is git-ignored in `.env.local` and redacted from logs and traces.

Verified offline against synthetic payloads (`tests/gemini.test.ts`) and checked manually in the chat. **Not** systematically evaluated or benchmarked.

## D50. Markdown lists after a heading line
Gemini writes "Key highlights:" followed directly by `* item` lines in the same block. The safe renderer now splits each block into runs of list and non-list lines, so these render as bullets instead of literal asterisks. It still never injects HTML.

## D51. Explicit seed transaction limits
The seed runs 16 sequential upserts in one all-or-nothing transaction. Prisma's defaults (5 s timeout, 2 s maxWait) are sized for queries within one region. From a laptop to a remote serverless database that may need to wake up, they can fail spuriously. The seed now uses `maxWait` 10 s and `timeout` 30 s: enough headroom for a manual, one-off operation without hiding a hung connection. Request-path transactions keep the defaults.

## D52. `LLM_PROVIDER=stub` and fail-safe provider parsing
A deployment needs a single switch that guarantees no model API is called, whatever secrets happen to be present. `stub` builds no model client at all.

Any **unrecognised** non-empty value (a typo, `none`) now selects the stub, with a warning. Previously it fell through to OpenRouter whenever an OpenRouter key existed, which could have meant a paid call. An omitted `LLM_PROVIDER` keeps the original behaviour.

## D53. Opt-in PostgreSQL integration suite with a positive-identification guard
Mocks can't prove the Prisma layer, so `npm run test:db` runs the real client against a real database. Because it truncates and migrates, it refuses to run unless the target is positively a dedicated test database:
- an explicit `TEST_DATABASE_URL`;
- not production;
- not the same database as any `DATABASE_URL` or `DIRECT_URL`;
- a name containing `test`;
- either empty (then marked with a database comment) or already marked.

A comment is used rather than a marker table so that the schema-drift check stays clean. The suite is kept out of `npm test`, and its status test reports SKIPPED/ENABLED explicitly. **Executed:** it passed 10/10 against a local PostgreSQL 16 test database (Docker), both on a fresh database and on a second, already-marked run. After the hardening below, the suite (now 14 tests, including rolled-back catalog probes for a materialized view, a partitioned table, a non-`public` schema, a privilege-hidden table and a `postgres_fdw` foreign table) passed 14/14 on the same database. Not yet run against a hosted or pooled database.

A review then hardened the guard to fail closed:
- relations are read from `pg_catalog` (`pg_class` joined to `pg_namespace`), not `information_schema`:
  - this is because `information_schema` is privilege-filtered and has no materialized views;
  - it covers ordinary and partitioned tables, views, materialized views and foreign tables;
  - it covers every schema except `pg_catalog`, `information_schema`, `pg_toast*` and temporary schemas;
- URL settings are strict:
  - names are lowercase and allow-listed;
  - no setting may appear twice;
  - `schema` must be exactly `public`;
  - `options` is refused;
- application URLs are compared from the process environment **and** from the `.env*` files:
  - the files are read as text, never loaded or printed;
  - the comparison fails closed on values it can't compare (`$` expansion, multi-line or unterminated values, non-URL text, unreadable files);
- `current_database()` must match the URL, and the marker is written to that verified name;
- a marked database may contain only this app's ordinary tables (`relkind = 'r'`);
- the truncate is schema-qualified;
- the Prisma CLI runs via Node with no shell, with the URL passed only in the environment and output redacted.

Known limitation: host aliases are not resolved, for example `localhost` vs `127.0.0.1`, or a provider's pooled vs direct host. The name, empty-or-marked, and app-tables-only rules remain the backstop.

## D54. Deterministic stub: share, follow-ups, percentage what-ifs, honest appreciation (2026-10-11)
The deployed demo runs with `LLM_PROVIDER=stub`, so its keyword router is what users actually meet. It answered "How much of my portfolio is retail?" with a property list, couldn't follow "which of those…", ignored "what if rent rises 10%", and answered an appreciation question with an overview.

It now handles these cases. It is still a pattern router, not an LLM:
- **Share questions** call `portfolio_analytics` with a filter. The filtered result now also carries the whole-portfolio total (`wholePortfolio`), so "₹21.2 Cr of ₹29.7 Cr" needs no arithmetic outside the backend.
- **Follow-ups** ("which of those…") use the `FOCUS` line that the system prompt already gives a real model. The stub sees no more than a model would, and nothing is hardcoded: a test changes a rent and the answer changes with it.
- **Percentage what-ifs:**
  - `run_scenario` accepts `changePct` as an alternative to an absolute amount, with exactly one per change.
  - The backend computes the figure from the real one (`applyPercentChange`, whole rupees), so neither the stub nor a real model does the arithmetic.
  - The scenario result now lists each property's before, after and delta.
  - It is still hypothetical only, and nothing is written.
- **Appreciation / ROI** leads with "can't be calculated" and the exact data gaps. The current value follows, marked as context only.

**Unchanged:**
- template figures are copied verbatim from tool output, and the per-turn faithfulness check still applies;
- tools use only the session user's data, and other users' ids are "not found";
- real changes still go through propose → confirm;
- `LLM_PROVIDER=stub` still makes no model call.

The `changePct` path has **not** been exercised with Gemini or OpenRouter. It is covered only by offline tests.

**Caught by `npm run eval:stub`, then fixed:**
- **The first version's help messages contained example ids and percentages** ("P001 … by 10%"). These caused 8 safety-grader flags and 16 unsupported figures. In production they would have flagged an unrecognised message as `unsupported_numbers`, and for other users the ids were not their own.
  - The help text is now generic, using placeholders such as "<property>" and "<n>%".
  - Rule: help text contains no figures and no property ids.
- **"Best rental yield" was routed as a rent ranking.** Yield is now matched before rent.
- Regression tests in `tests/stubFormat.test.ts` check that:
  - help replies contain no numbers;
  - they name no property id, including other users' ids;
  - "rental yield" ranks by yield.
- After the fix, the re-run (2026-10-10 UTC, uncommitted working tree) measured:
  - 20/40 cases;
  - numeric faithfulness 33/33;
  - **0 safety violations**;
  - no case that passed for the previous stub now fails.

**Trade-off:** each new phrasing is another regular expression, so wording outside the patterns still falls back to the help message. The real fix for open-ended questions is a real model.

## D55. Stub property updates through the existing propose → confirm path; live-site fixes (2026-10-11)
On the deployed stub, "Update P001's annual rent to ₹80 lakh per year" got the generic help message. The stub now routes explicit update instructions to the **same tools the agent uses**, with no second write path:
- **Proposing:**
  - `propose_property_update` validates the change, shows current → new from the backend diff, and creates a pending action. Nothing is saved at this point.
  - The amount is parsed by the domain's money grammar: `parseMoneyText` returns `{amount, unit}`, and `parseInrText` is now built on it with unchanged behaviour. The backend converts to rupees.
- **Confirming:**
  - A later clean "yes" calls `confirm_pending_action`.
  - The backend still checks the affirmation, the user, the conversation, expiry, and the version (optimistic locking), and writes the audit row.
  - The Confirm button path is unchanged.
- **Cancelling:** "cancel" calls `cancel_pending_action`.
- **Other users' ids** are reported as not found, with no proposal and no data.
- **Missing or ambiguous requests:** if the property, the field or the new amount is missing, the stub asks **one** clarifying question. Like all help text, the question contains no figures and no ids.
- **Only instructions trigger an update:** the verb must lead, as in "Update…" or "Please set…". So "How would that change my portfolio?" stays a what-if follow-up, and what-ifs never propose or write.

**Fixed at the same time:**
- **Tool-call id collisions.** The stub's ids came from a per-process counter, which restarts on each serverless cold start, while the conversation history is reloaded from Postgres. A new id could therefore equal an old one, and the formatter picked the old call. On the live site this gave "That part of your portfolio is 71.38%…" instead of "Retail is 71.38%…". Ids are now random UUIDs, and the latest matching call wins.
- **The ROI pattern.** The "roi" alternative in the appreciation regex had been written with literal backspace characters, from a shell-escaping slip, instead of word boundaries. So "What's my ROI?" was not recognised. The pattern is restored, and the repository was scanned for other control characters; none remain.

**Measured** (`npm run eval:stub`, mock, 2026-10-10 UTC, uncommitted tree on top of `fe57eb4`):
- 23/40 cases;
- numeric faithfulness 35/35;
- proposal / no proposal 13/14;
- clarification 2/7;
- **0 safety violations**;
- against `fe57eb4`, 0 checks worse and 10 better.

G2's clarification pass at `fe57eb4` had been incidental (the help text contained a "?"). It now passes because the stub asks a real question. None of this was exercised with Gemini or OpenRouter.

**Trade-off:** update parsing is still pattern-based. It covers one property and one field per message, with an absolute amount; adding properties and percentage-based real changes are left to a real model.
