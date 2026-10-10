# AI Real Estate Portfolio Analyst

A conversational AI analyst for a real-estate portfolio, with a WhatsApp-style chat and a separate business operations dashboard. Users can ask about their portfolio, explore what-if scenarios, and add or update properties. Every figure is calculated by the backend, and every write requires the user's confirmation.

> **Status: in progress.**
>
> | Phase | Scope | Status |
> |---|---|---|
> | 0 | Scaffold, schema, seed | ✅ |
> | 1 | Domain core and tests | ✅ |
> | 2 | Agent, tools, memory, chat API | ✅ (tested with mocked models) |
> | 3 | Chat UI + streaming | ✅ (UI tested in jsdom; not yet with a real LLM) |
> | 4 | Admin and observability | ⏳ |
> | 5 | Evaluation and performance | ⏳ |
> | 6 | Docs and deploy prep | ⏳ |
>
> Sections marked _(planned)_ describe work that is not built yet. **No real LLM has been called yet.** The agent has been exercised only with scripted test models and the dev stub.

## Documents

| File | Contents |
|---|---|
| [SOUL.md](SOUL.md) | The agent's role, voice, boundaries, and when it asks questions or hands off to a human |
| [DECISIONS.md](DECISIONS.md) | Decision log: engineering choices and trade-offs |
| [PERFORMANCE.md](PERFORMANCE.md) | Latency methodology and measured results |
| [docs/architecture.md](docs/architecture.md) | End-to-end architecture diagram |

## Stack

- **Next.js 16** (App Router) and **TypeScript**. One deployable unit contains the chat UI, the admin UI, and the API routes.
- **LangGraph.js**: a single tool-calling agent loop as an explicit state graph, capped at 5 tool rounds.
- **OpenRouter** (through LangChain's OpenAI-compatible client) as the model gateway. Primary and fallback models are configurable, with per-call and per-turn timeouts.
- **PostgreSQL** with **Prisma 6** in production (Neon). An **in-memory store** implements the same interface for local development and tests.
- **Vitest** for tests.

## Project layout

```
src/
  domain/            Pure, framework-free logic (unit-tested)
    money.ts           {amount, unit} → whole INR; crore/lakh formatting
    normalize.ts       "Commercial Office"/"Office" → OFFICE; COMMERCIAL = retail + office
    location.ts        "Locality, City" parsing; Alibaug/state handling; Delhi NCR expansion
    filters.ts         Strict filter schema shared by the read tools
    analytics.ts       Totals, breakdowns, yields, tie-aware rankings, group comparison
    scenario.ts        What-if engine over a cloned portfolio (never writes)
    propertyChanges.ts Create/update validation, missing-field detection, duplicate check
    affirmation.ts     Deterministic "is this a clear yes?" check
  agent/
    tools.ts           9 tools: strict zod schemas, trusted context, structured errors, executor
    graph.ts           LangGraph loop: agent ⇄ tools, 5-round budget, limit node
    model.ts           ChatModel interface, OpenRouter adapter, primary→fallback routing
    deadline.ts        Timeouts that are guaranteed to fire (see DECISIONS D20)
    prompt.ts          System prompt: SOUL rules + numberless property index + state
    memory.ts          History window and message ⇄ record conversion
    conversationState.ts  Backend-owned state: focus ids, active scenario, pending action
    present.ts         Pre-formatted ₹/% output for the model
    telemetry.ts       Per-turn spans, LLM calls, tool calls
    devStubModel.ts    Keyword router used when no API key is set (NOT an LLM)
  server/
    services/chatService.ts      One chat turn end to end + the LLM-free confirm/cancel path
    services/propertyActions.ts  Propose → confirm write flow
    stores/            Persistence interfaces; Prisma and in-memory implementations, all user-scoped
    session.ts         Signed HTTP-only demo-user cookie (jose, HS256)
    container.ts       Picks the data backend and the model from env
  app/api/
    chat/route.ts               POST: one turn (JSON)
    chat/stream/route.ts        POST: one turn as Server-Sent Events
    chat/actions/route.ts       POST: Confirm/Cancel button (no LLM)
    conversations/route.ts      GET: the user's conversations
    conversations/[id]/route.ts GET: display-ready transcript + open proposal
    session/route.ts            GET/POST/DELETE: demo-user picker
  components/        ChatApp, MessageBubble, PendingActionCard, Composer, UserPicker
  lib/               chatState (pure reducer), chatClient (fetch + SSE), sse, richText (safe rendering)
prisma/                schema.prisma, seed.ts, migrations/ (init migration, generated offline)
tests/                 Vitest suites
```

## Setup (local)

You need Node ≥ 20.9. **No database and no API key are required** for development, tests, or the build.

```bash
npm install
# The synthetic CSVs are committed in data/seed/ (see "Dataset files")
npm test                 # all suites; models and persistence are mocked
npm run build            # production build; needs no env vars
npm run dev              # http://localhost:3000; in-memory data + dev stub model
```

Optional, to use a real model: copy `.env.example` to `.env` and set `OPENROUTER_API_KEY` and `LLM_PRIMARY_MODEL` (and optionally `LLM_FALLBACK_MODEL`). OpenRouter usage is paid.

### Database (optional)

The initial migration [`prisma/migrations/20261010000000_init`](prisma/migrations/) was **generated offline** from `schema.prisma` with `prisma migrate diff`. A test (`tests/migration.test.ts`) regenerates it and fails if it drifts from the schema.

To use Postgres:
1. Set `DATA_BACKEND=prisma`, `DATABASE_URL`, and `DIRECT_URL` (for Neon: the pooled and direct URLs).
2. `npm run db:deploy` applies the committed migrations (`prisma migrate deploy`).
3. `npm run db:seed` loads users and properties. Running it again is safe. `npm run db:seed:dry` validates the CSVs without touching a database.
4. For future schema changes, use `npm run db:migrate` (`prisma migrate dev`) against a development database.

**Not yet verified:** applying the migration to a live Postgres, the Postgres seed, and the Prisma store implementation. All three are type-checked only.

### Sessions

The demo-user cookie is signed with `SESSION_SECRET`.
- Outside `NODE_ENV=development` or `test` (production, preview, or unset), the app **requires** a `SESSION_SECRET` of at least 32 characters. There is no production fallback.
- The built-in development secret is rejected even if someone sets it explicitly.

## Dataset files

The synthetic dataset is committed in [`data/seed/`](data/seed/) as byte-identical copies of the assignment files, so a fresh clone can run the app and the tests.

| File | Used by |
|---|---|
| `users.csv` | Seed (Postgres), in-memory store, tests: the demo users |
| `properties.csv` | Seed (Postgres), in-memory store, tests: the portfolios |
| `sample_requests.csv` | Reference prompts for the evaluation harness (Phase 5) and the chat's suggestion chips |
| `DATASET.md` | The assignment's own dataset notes, kept for reference |

These files are **read-only inputs**. They are never edited; normalisation happens in code and is logged by `npm run db:seed:dry`.

The assignment PDF and the original root-level copies are deliberately not committed (`.gitignore`).

## Chat UI

`npm run dev` and open http://localhost:3000.

- **Demo sign-in.** Pick a client: the server sets a signed HTTP-only cookie. The browser never sends a user id.
- **WhatsApp-style chat.** Conversation list in the sidebar (a drawer on mobile), message history, suggestion chips, light and dark theme.
- **Streaming.** While the agent works you see "Thinking…", then each tool step as it runs ("Looking up your properties — 3 matches"), then the answer as it is generated.
- **Hypothetical answers** have a dashed amber border and the banner "🔮 Hypothetical scenario — your real portfolio is unchanged".
- **Proposed changes** appear as a card with a before/after table and the label **Not saved yet**:
  - **Confirm** calls the LLM-free endpoint.
  - **Edit** pre-fills the message box so you can revise the proposal.
  - **Cancel** drops it.
  - Expired proposals can't be confirmed.
- **Tool activity.** Each answer has a collapsible "how I worked this out" list showing tool labels and outcomes only. Raw arguments and results never reach the browser.
- **Errors.** Network failures, rate limits, and model outages show an inline error with **Retry**. A message that never reached the server is re-sent rather than duplicated.
- **Demo mode banner.** Shown when no LLM is configured (dev stub) and when data is in memory.
- **Rendering.** Model text is rendered without `dangerouslySetInnerHTML`; only bold and simple lists are formatted.

## How a chat turn works

1. `POST /api/chat/stream` (used by the UI) or `POST /api/chat` (JSON) takes `{message, conversationId?}`.
   - Auth, body validation, rate limit, and conversation ownership are all checked **before** the stream opens, so those failures are ordinary HTTP errors.
   - The stream sends `start`, `status`, `tool_start` / `tool_end`, `delta`, `reset`, and finally `done` or `error`.
   - If the client disconnects, the turn still completes and is saved. The body is checked by a strict schema: an extra field such as `userId` gets a 400. The user id comes **only** from the signed cookie.
2. The service loads the conversation (scoped to that user), the last 30 messages (the window always starts at a user message), the structured state, and the user's properties.
3. The system prompt contains:
   - the rules from SOUL.md
   - the user's profile
   - a **property index with ids and labels but no figures**
   - the focus property ids
   - the active hypothetical scenario
   - any pending change
4. The LangGraph loop runs:
   1. **Model call:** primary model, with fallback to the secondary model on error or timeout. Each call has its own timeout, and the whole turn has a deadline.
   2. **Tools:** the model's requested tool calls are validated with zod and executed with the trusted user id. Reads run in parallel; writes run in order.
   3. **Repeat**, for at most 5 tool rounds. After the fifth round the model gets one final call without tools.
5. The messages, new state, and attention flag are saved atomically. Telemetry for the turn (spans, every LLM call, every tool call) is recorded as a run.
6. If anything fails, the user still gets a safe reply and the conversation is flagged for the business team.

## Data handling: assumptions

All of these are recorded in [DECISIONS.md](DECISIONS.md).

- **Property types.** `Commercial Office` and `Office` both normalise to `OFFICE`, and the raw label is kept. **COMMERCIAL means RETAIL plus OFFICE.** The brief does not define the term, so this is an assumption.
- **Location.** `location` is parsed into locality and city.
  - `Alibaug, Maharashtra` ends in a state, so its city is Alibaug and its state is Maharashtra. It is **not** counted as Mumbai.
  - "Delhi NCR" expands to Delhi, Gurugram, Noida, Ghaziabad, and Faridabad.
- **Purchase price** is blank for all 12 rows. It is stored as null and never estimated.
- **Dates:** the dataset has none. Appreciation, ROI, and holding-period questions are answered by saying the data is missing.
- **Rent:** zero rent means no income. Vacant and self-occupied properties are excluded from yield and rent rankings and listed as excluded.
- **Ownership and status:** totals use value × ownership%, and only Active properties are counted. These are no-ops on the seed data but correct in general.
- **User preference fields** are kept as context only. `portfolio_value_preference_inr` mixes numbers and ranges and has no defined meaning, so no calculation uses it.

## Tests

`npm test` runs everything **offline**. No test calls a real LLM, OpenRouter, or a database.

| Suite | What is real | What is mocked |
|---|---|---|
| `money`, `normalize-location`, `seedData`, `analytics`, `filters-scenario`, `propertyChanges` | Domain code + the actual assignment CSVs | Nothing |
| `propertyActions` | Propose/confirm service | Persistence: in-memory store |
| `tools` | Tool schemas, validation, execution | Persistence: in-memory store |
| `agent` | LangGraph loop, fallback, timeouts, memory, chat service | **Model**: scripted fake. Persistence: in-memory |
| `api` | Route handlers, cookie auth, body validation, rate limit | Container: in-memory store + scripted model |
| `agentUnits` | Deadline helper, memory conversion, state parsing, dev stub | Nothing |
| `streaming` | SSE route, event order, safe tool summaries, partial-stream fallback, client disconnect, conversation read APIs, cross-user 404s | Container: in-memory store + scripted/streaming fake models |
| `chatState` | UI reducer transitions, SSE parser | Nothing (pure functions) |
| `ui` (jsdom) | Real React components: sign-in, streamed reply, proposal card, Confirm, Edit, Retry, 429, hypothetical styling, XSS-safe rendering | `fetch` (canned API/SSE responses) |
| `session` | Secret policy (fails closed), token tampering, `alg=none` | Nothing |
| `migration` | Committed init migration equals the schema (Prisma CLI, offline) | No database |

Expected figures were derived by hand, for example U001 = ₹29.7 Cr with 71.38% retail, and excluding Bandra gives ₹17.7 Cr.

**Not tested yet:**
- Real model behaviour: tool-choice quality and answer faithfulness. This is the Phase 5 evaluation.
- The Prisma store, the migration and the seed against a live Postgres.
- The UI in a real browser (it is covered by jsdom tests and an HTTP smoke test only) and with real streamed LLM output.

## Known limitations (so far)

- No real authentication. The demo user picker with a signed cookie is the agreed scope.
- In-memory data resets when the server restarts, and each serverless instance has its own copy. Use `DATA_BACKEND=prisma` for persistence.
- The rate limit (20 messages per minute per user) is per server instance.
- `costUsd` is not filled in yet. Token counts are recorded when the provider returns them.
- The Prisma store, the init migration and the Postgres seed have not been run against a live database (see "Database").
- The UI has been tested in jsdom and smoke-tested over HTTP, but not with a real LLM's streamed output.

## External dependencies

| Dependency | Status |
|---|---|
| PostgreSQL | Optional (`DATA_BACKEND=prisma`). Local install, or Neon (free tier) for deployment |
| OpenRouter API key | Optional. Without it the dev stub is used. With it, usage is paid |
