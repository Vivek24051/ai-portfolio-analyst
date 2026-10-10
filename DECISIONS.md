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
