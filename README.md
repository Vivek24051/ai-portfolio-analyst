# AI Real Estate Portfolio Analyst

A conversational AI analyst for a real-estate portfolio, with a WhatsApp-style chat and a separate business operations dashboard. Users can ask about their portfolio, explore what-if scenarios, and add or update properties. Every figure is calculated by the backend, and every write requires the user's confirmation.

> **Status: in progress.**
>
> | Phase | Scope | Status |
> |---|---|---|
> | 0 | Scaffold, schema, seed | ✅ |
> | 1 | Domain core and tests | ✅ |
> | 2 | Agent, tools, memory, chat API | ✅ (tested with mocked models) |
> | 3 | Chat UI | ⏳ |
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
    chat/route.ts          POST: one turn
    chat/actions/route.ts  POST: Confirm/Cancel button (no LLM)
    session/route.ts       GET/POST/DELETE: demo-user picker
prisma/                schema.prisma, seed.ts
tests/                 Vitest suites
```

## Setup (local)

You need Node ≥ 20.9. **No database and no API key are required** for development, tests, or the build.

```bash
npm install
# Put the assignment CSVs in data/original/ (see "Dataset files")
npm test                 # all suites; models and persistence are mocked
npm run build            # production build; needs no env vars
npm run dev              # http://localhost:3000; in-memory data + dev stub model
```

Optional, to use a real model: copy `.env.example` to `.env` and set `OPENROUTER_API_KEY` and `LLM_PRIMARY_MODEL` (and optionally `LLM_FALLBACK_MODEL`). OpenRouter usage is paid.

Optional, to use Postgres:
1. Set `DATA_BACKEND=prisma`, `DATABASE_URL` and `DIRECT_URL`.
2. Run `npm run db:migrate`, then `npm run db:seed`. Use `npm run db:seed:dry` to validate the CSVs without touching a database.

Production (`next start`) refuses to issue sessions unless `SESSION_SECRET` (≥ 32 characters) is set.

## Dataset files

The assignment's files are **not committed** to this repository. Before running seeds or tests, put the original `users.csv`, `properties.csv` and `sample_requests.csv` in `data/original/`. The seed script, the in-memory store and the test suite read from there, and treat those files as read-only.

## How a chat turn works

1. `POST /api/chat` takes `{message, conversationId?}`. The body is checked by a strict schema: an extra field such as `userId` gets a 400. The user id comes **only** from the signed cookie.
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

Expected figures were derived by hand, for example U001 = ₹29.7 Cr with 71.38% retail, and excluding Bandra gives ₹17.7 Cr.

**Not tested yet:**
- Real model behaviour: tool-choice quality and answer faithfulness. This is the Phase 5 evaluation.
- The Prisma store against a live Postgres.

## Known limitations (so far)

- No real authentication. The demo user picker with a signed cookie is the agreed scope.
- In-memory data resets when the server restarts, and each serverless instance has its own copy. Use `DATA_BACKEND=prisma` for persistence.
- The rate limit (20 messages per minute per user) is per server instance.
- No streaming yet. The chat API returns the full reply when the turn finishes.
- `costUsd` is not filled in yet. Token counts are recorded when the provider returns them.
- The Prisma store has not yet been run against a live database.

## External dependencies

| Dependency | Status |
|---|---|
| PostgreSQL | Optional (`DATA_BACKEND=prisma`). Local install, or Neon (free tier) for deployment |
| OpenRouter API key | Optional. Without it the dev stub is used. With it, usage is paid |
