# AI Real Estate Portfolio Analyst

A conversational AI analyst for a real-estate portfolio, with a WhatsApp-style chat and a separate business operations dashboard. Users can ask about their portfolio, explore what-if scenarios, and add or update properties. Every figure is calculated by the backend, and every write requires the user's confirmation.

> **Status: complete within a free-only scope.**
>
> | Phase | Scope | Status |
> |---|---|---|
> | 0 | Scaffold, schema, seed | ✅ |
> | 1 | Domain core and tests | ✅ |
> | 2 | Agent, tools, memory, chat API | ✅ (tested with mocked models) |
> | 3 | Chat UI + streaming | ✅ (UI tested in jsdom and over local HTTP) |
> | 4 | Admin dashboard + observability | ✅ (in-memory store, dev stub and scripted models) |
> | 5 | Evaluation and performance | ✅ free-only: grader/control tests and local benchmarks ([FREE_ONLY_EVALUATION.md](FREE_ONLY_EVALUATION.md)) |
>
> **Deployed:** https://ai-portfolio-analyst-two.vercel.app (Vercel + Neon PostgreSQL), running **`LLM_PROVIDER=stub`**, the keyword dev stub, **not an LLM**. These checks were done by hand on the live site:
> - the admin header shows `model: dev-stub` and `data: prisma`;
> - chat and admin pages work, and conversations are stored in Neon;
> - the retail-share, missing-ROI-data and update → confirm/cancel flows work.
>
> The live deployment is commit `5996dba`; later work is described in this repository but **not yet deployed**.
>
> **Real models:** Gemini and OpenRouter clients exist, with a Gemini → OpenRouter `:free` → stub fallback chain.
> - The fallback chain, error handling and free-only guards are covered by **offline tests with scripted models only**.
> - **No real Gemini or OpenRouter call is part of any test or evaluation.**
> - Gemini was tried **manually** in local chat early on.
> - Real-model latency, tool-calling quality and free-tier availability are **unmeasured and unverified**.
>
> All automated tests and evaluations run offline (scripted models, an oracle reference policy, the keyword stub). The one exception is the opt-in `npm run test:db`, which ran against a local PostgreSQL test database.

## Submission

| Deliverable | Where |
|---|---|
| 1. Live interactive tool | https://ai-portfolio-analyst-two.vercel.app (chat) and `/admin` (business view, HTTP Basic auth). It runs commit `5996dba` in stub mode; see the status note above |
| 2. Repository | This repo: setup (below), architecture, assumptions ("Data handling: assumptions"), decisions, known limitations, external dependencies |
| 3. `SOUL.md` | [SOUL.md](SOUL.md) |
| 4. Architecture diagram | [docs/architecture.md](docs/architecture.md) (Mermaid; renders on GitHub) |
| 5. Decision log | [DECISIONS.md](DECISIONS.md) (start with "Start here" at the top) |
| 6. Walkthrough | [docs/walkthrough.md](docs/walkthrough.md): a timed 5–10 minute script |
| Latency | [PERFORMANCE.md](PERFORMANCE.md) |

**For reviewers trying the live tool:**
- Open the chat, pick a demo client (for example Rahul Mehta), and try "What does my portfolio look like?", "How much of my portfolio is retail?", "Which of those earns more annual rent?", "What if the rent of P001 increases by 10%?", or "Update P001's annual rent to ₹80 lakh per year", then Confirm or Cancel.
- The live model is the **dev stub, a keyword router, not an LLM**. Wording outside its patterns gets a help message.
- The admin username and password are **not in this repository**. They are shared privately through the submission form.

**Verified offline on the current working tree (2026-10-11):**
- `npm test`: 28 files, 422/422 tests;
- `npm run typecheck`: clean;
- `npm run build`: succeeds with `LLM_PROVIDER=stub`;
- evaluations: oracle 40/40, perturbed 12/40 (caught as intended), stub 40/40, each with 0 safety violations.

**Not verified:** any real Gemini or OpenRouter call.

## Documents

| File | Contents |
|---|---|
| [SOUL.md](SOUL.md) | The agent's role, voice, boundaries, and when it asks questions or hands off to a human |
| [DECISIONS.md](DECISIONS.md) | Decision log: engineering choices and trade-offs |
| [PERFORMANCE.md](PERFORMANCE.md) | Methodology, measured results, evaluation scores, what is not measured, scaling |
| [FREE_ONLY_EVALUATION.md](FREE_ONLY_EVALUATION.md) | Exact commands for the no-cost evaluation, what each control proves, what needs real infrastructure |
| [docs/eval/](docs/eval/) | Generated evaluation and benchmark reports |
| [docs/architecture.md](docs/architecture.md) | End-to-end architecture diagram |
| [docs/walkthrough.md](docs/walkthrough.md) | Timed 5–10 minute walkthrough script |
| [docs/deployment-readiness.md](docs/deployment-readiness.md) | Deployment checklist and what was checked on the live site |

## Stack

- **Next.js 16** (App Router) and **TypeScript**. One deployable unit contains the chat UI, the admin UI, and the API routes.
- **LangGraph.js**: a single tool-calling agent loop as an explicit state graph, capped at 5 tool rounds.
- **Model access** through LangChain's OpenAI-compatible client, as a chain: **primary → fallback (may be a different provider) → labelled dev stub as last resort**, with per-call and per-turn timeouts:
  - **Google Gemini** (free tier, optional; tried manually only)
  - **OpenRouter**: only `:free` model ids unless `OPENROUTER_ALLOW_PAID=true` (off by default); never called in tests
  - **dev stub**: the default (`LLM_PROVIDER=stub`), a keyword router with no LLM and no cost
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
    faithfulness.ts    Every figure in a reply must trace to tool output (production flag + eval metric)
    events.ts          Streaming (SSE) event protocol with user-safe tool summaries
    devStubModel.ts    Keyword router used when no API key is set (NOT an LLM)
  server/
    services/chatService.ts      One chat turn end to end + the LLM-free confirm/cancel path
    services/propertyActions.ts  Propose → confirm write flow
    stores/            Persistence interfaces; Prisma and in-memory implementations, all user-scoped
    session.ts         Signed HTTP-only demo-user cookie (jose, HS256)
    container.ts       Picks the data backend and the model from env
    admin/            auth (Basic, fail-closed, lockout, CSRF), adminService (overview, lists, traces), page guard
    redact.ts          Secret redaction for logs and stored errors
  app/api/
    chat/route.ts               POST: one turn (JSON)
    chat/stream/route.ts        POST: one turn as Server-Sent Events
    chat/actions/route.ts       POST: Confirm/Cancel button (no LLM)
    conversations/route.ts      GET: the user's conversations
    conversations/[id]/route.ts GET: display-ready transcript + open proposal
    session/route.ts            GET/POST/DELETE: demo-user picker
  admin/             Server-rendered ops dashboard: overview, conversations, execution traces
  proxy.ts           Basic-auth challenge + no-store for /admin and /api/admin (pages/APIs re-check)
  components/        ChatApp, MessageBubble, PendingActionCard, Composer, UserPicker
  lib/               chatState (pure reducer), chatClient (fetch + SSE), sse, richText (safe rendering)
prisma/                schema.prisma, seed.ts, migrations/ (init migration, generated offline)
eval/                  Golden set (40 cases), oracle/perturbed controls, graders, runner, benchmarks
tests/                 Vitest suites
```

## Setup (local)

You need Node ≥ 20.9. **No database and no API key are required** for development, tests, or the build.

```bash
npm install
# The synthetic CSVs are committed in data/seed/ (see "Dataset files")
npm test                 # all suites; models and persistence are mocked
npm run build            # production build; needs no env vars
```

### Run it locally (chat + admin)

1. Create a file named `.env.local` in the project root. It is git-ignored; Next.js loads it in both `dev` and `start`. Put this in it:
   ```
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=choose-a-password-of-12+-chars
   ```
2. Start the dev server: `npm run dev`
3. Open the **chat** at http://localhost:3000 and pick a demo client.
4. Open the **admin dashboard** at http://localhost:3000/admin. The browser asks for the username and password from `.env.local`.

Without `ADMIN_PASSWORD` (or with one shorter than 12 characters), `/admin` returns **503** by design.

To run the production build locally, also add `SESSION_SECRET` to `.env.local`. Production mode refuses to sign sessions without it. Generate one with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
Then run `npm run build`, then `npm start`.

No key is needed for any of this. Set `LLM_PROVIDER=stub` (the `.env.example` default) and the app uses the labelled dev stub, with data in memory.

Which model runs depends on `LLM_PROVIDER` and that provider's settings, not on any one key:
- `LLM_PROVIDER=gemini`, with `GEMINI_API_KEY` and `LLM_PRIMARY_MODEL` set, uses Gemini even without `OPENROUTER_API_KEY`.
- Every case is listed in the table under "Forcing the dev stub".

### Dev stub vs. a real model

When the dev stub is selected, the "model" is `src/agent/devStubModel.ts`. This is the default, and it is how this project was built and evaluated. It is **a keyword router, not an LLM**.

The stub is selected when:
- `LLM_PROVIDER=stub`;
- `LLM_PROVIDER` is unrecognised;
- the selected provider is missing its key or model id;
- an OpenRouter id is refused because it isn't `:free`.

**What the dev stub does:** it matches regular-expression patterns in the message and calls the **real** tools, which run the real calculations on the signed-in user's data.

> **It was tuned against the evaluation cases.** It now passes 40/40 of the golden set, but its patterns were written while looking at those exact cases. **40/40 does not show that it generalises** to other wording, and it says nothing about LLM quality. Wording outside its patterns still gets a help message.

Examples it recognises:
- portfolio overview or total; "show my retail/office/residential properties"; "properties in Mumbai/Bengaluru/Delhi NCR…"; highest rent; yield;
- **share of the portfolio**: "How much of my portfolio is retail?", "What percentage … is retail?". It reports the slice's value, the whole portfolio's value, the share and the property count;
- **follow-ups on the previous result**: "Which of those earns more annual rent?" ranks the properties from the previous answer. It reads them from the same `FOCUS` line in the system prompt that a real model gets;
- **what-ifs**: "What if the rent of P001 increases by 10%?", "What if I exclude the Bandra property?", "How would that change my portfolio?". The percentage goes to `run_scenario` as `changePct`, and the backend computes the new figure. The reply is labelled hypothetical, and nothing is saved;
- **appreciation / ROI**: it says plainly that these can't be calculated (no purchase dates; purchase prices missing) and lists the gaps. The current value is shown only as context.
- **real updates, via the same propose → confirm path as the agent**: "Update P001's annual rent to ₹80 lakh per year" (also current value or purchase price). It calls `propose_property_update`, which shows current → new and saves **nothing**. A later "yes" (or the Confirm button) saves through `confirm_pending_action`, which re-checks affirmation, user, conversation, expiry and version, and writes the audit row. "Cancel" discards the change. Another user's id is reported as not found. If the property, the figure or the new amount is missing or ambiguous, the stub asks one clarifying question instead of guessing.
- **filters, rankings and comparisons**: "above ₹10 crore", "lowest rent", "Which of my offices are vacant?", "their combined value", "overall yield", "Compare my residential and commercial exposure".
- **more what-ifs**: an absolute value ("value dropped to ₹10 Cr"), a hypothetical purchase ("bought a ₹5 Cr office in Whitefield"), and a described property ("my vacant office", resolved only when exactly one of the user's own properties matches).
- **new properties**: "Add a 3000 sq ft retail property in Indiranagar worth ₹4.2 crore" calls `propose_new_property`.
  - Missing details become one question, using the backend's `needs_info`.
  - A follow-up in the **next** message completes the draft.
  - Near-duplicates are flagged by the backend's own check.
  - Nothing is created until "yes".
- **status changes**: "My Andheri office is now tenanted". The backend's validation requires a rent, so the stub asks for it, then proposes occupancy and rent for confirmation.
- **hand-off**: "speak to a human advisor" calls `flag_for_human`.
  - The conversation appears in the admin "needs attention" queue.
  - The reply says plainly that **no one is contacted automatically**.

Replies use fixed templates (`src/agent/stubFormat.ts`), prefixed `[dev stub — template reply, no LLM]`. Figures in template replies are copied verbatim from the tool output. It can stream word by word (`DEV_STUB_STREAM_DELAY_MS`, default 12 ms) so the streaming UI can be demonstrated.

**What it does not do:**
- Understand wording outside its patterns. Anything else gets a help message.
- Reason about which tool to use. Each pattern maps to a fixed tool call.
- Ask clarifying questions beyond its fixed ones for incomplete or ambiguous requests.
- Change several properties at once, or apply a percentage as a real change. Percentages only work in what-ifs.
- Convert monthly rent, or understand locations beyond "in <place>".
- Write natural-language answers.

**Help text carries no figures or ids.** Unrecognised messages get a generic help reply with placeholders such as "<property>" and "<n>%". It contains no example figures, which the faithfulness check would flag, and no example property ids, which could belong to another user. An earlier version of these changes broke this rule, and "best rental yield" was routed as a rent ranking. Both were caught by `npm run eval:stub` and fixed. Regression tests are in `tests/stubFormat.test.ts`.

**Fixed after the first deployment** (tests in `tests/stubUpdates.test.ts`):
- **Tool-call ids could collide.** The stub's ids came from a per-process counter, which restarts on every serverless cold start, while the conversation history is reloaded from the database. On the live site, "How much of my portfolio is retail?" was answered "That part of your portfolio is 71.38%…" because an older call with the same id was picked. Ids are now random, and the latest match wins.
- **"What's my ROI?" was not recognised** as an appreciation question, because a regex had been written with literal control characters instead of `\b`.

The chat UI and admin pages show a banner whenever the stub is active.

**What a real model does instead:** pick tools, interpret follow-ups, ask for missing details, propose changes, and phrase answers from tool output. These behaviours are covered offline by scripted test models and the oracle reference policy. With Gemini they have been checked **manually** only, and **no real-model tool calling or latency has been measured**.

### Optional: connect a real model (free-only)

**Free-tier availability, quotas and tool-calling support are not verified by this project.** Check them yourself in Google AI Studio (rate-limit page) and on OpenRouter's model list. No model id below is a recommendation.

1. **Gemini (primary):** create an API key in Google AI Studio, on a Google Cloud project **without billing enabled**. Exceeding the free quota then returns HTTP 429 instead of charging.
2. **OpenRouter (optional fallback):** use a model whose id ends in **`:free`**.
   - Ids without `:free` are **refused** unless `OPENROUTER_ALLOW_PAID=true` (off by default).
   - Buy no credits, and a paid model can't run anyway.
3. Add to `.env.local` (git-ignored; never commit keys):
   ```
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=<your key>
   LLM_PRIMARY_MODEL=<a Gemini model with free quota in your project>
   LLM_FALLBACK_PROVIDER=openrouter            # optional; default = same provider as the primary
   LLM_FALLBACK_MODEL=<vendor/model>:free
   OPENROUTER_API_KEY=<your key>
   # LLM_STUB_LAST_RESORT=true                 # default: the labelled stub answers if both fail
   ```
4. Restart `npm run dev`. The "Demo mode" banner disappears, and the admin traces show the model and provider of every call.

How the chain behaves (all covered by offline tests in `tests/providerFallback.test.ts`; none uses a real provider):
- **Timeouts, 429 and 5xx** move on to the next model.
- **401/402 (bad key, no credits):**
  - **never retried on the same provider** for the rest of the turn, including later tool rounds, because it shares the key and credits;
  - a **different** provider is still tried;
  - a model whose provider is unknown is treated as the same account.
- **Last resort.** If every real model fails, the **labelled dev stub** answers.
  - The admin trace shows a "stub last resort" badge.
  - The conversation is flagged `model_degraded`, so an outage stays visible.
  - `LLM_STUB_LAST_RESORT=false` disables this; an outage then gives the error reply.
- **Per-turn circuit breaker.** A model that failed once in a turn isn't called again in that turn.
- **Secrets stay out of view.**
  - Keys never appear in logs, the admin trace or error text, because provider errors are redacted.
  - Configuration warnings never echo values.
- **Gemini specifics:**
  - only standard OpenAI-compatible request fields are sent;
  - token counts may show "—" (not reported);
  - cost is always "—".
- **Incomplete or refused settings** fall back to the dev stub, never to a paid provider.

### Forcing the dev stub (`LLM_PROVIDER=stub`)

`LLM_PROVIDER=stub` always selects the dev stub, even if `GEMINI_API_KEY` or `OPENROUTER_API_KEY` is set. No model client is created and no model API can be called. Use it for a first deployment or any no-cost demo.

| `LLM_PROVIDER` | Result |
|---|---|
| `stub` | Dev stub, always |
| `gemini` | Gemini if `GEMINI_API_KEY` and `LLM_PRIMARY_MODEL` are set, otherwise the dev stub |
| `openrouter` | OpenRouter if its key and a `:free` model id are set (or any id with `OPENROUTER_ALLOW_PAID=true`), otherwise the dev stub |
| omitted | Same rule as `openrouter` (the original behaviour, now with the free-only guard), otherwise the dev stub |
| anything else (a typo, `none`, …) | Dev stub, with a warning in the server log. It never falls through to a paid provider |

### Database (optional)

The initial migration [`prisma/migrations/20261010000000_init`](prisma/migrations/) was **generated offline** from `schema.prisma` with `prisma migrate diff`. A test (`tests/migration.test.ts`) regenerates it and fails if it drifts from the schema.

To use Postgres:
1. Set `DATA_BACKEND=prisma`, `DATABASE_URL`, and `DIRECT_URL` (for Neon: the pooled and direct URLs).
2. `npm run db:deploy` applies the committed migrations (`prisma migrate deploy`).
3. `npm run db:seed` loads users and properties. Running it again is safe. `npm run db:seed:dry` validates the CSVs without touching a database.
4. For future schema changes, use `npm run db:migrate` (`prisma migrate dev`) against a development database.

The Prisma CLI reads `.env`, not `.env.local`, so set `DATABASE_URL` and `DIRECT_URL` in the shell (or a git-ignored `.env`) when running the `db:*` commands. The seed runs as one all-or-nothing transaction, with a raised time limit (`prisma/seedDatabase.ts`) so that it can run against a remote database.

#### Opt-in PostgreSQL integration tests (`npm run test:db`)

`tests/db/prisma.dbtest.ts` runs the real Prisma client against a real PostgreSQL database. It covers:
- applying the migrations, and checking that the result matches the schema (no drift);
- the seed, including that it can be re-run safely;
- user-scoped queries;
- conversation, run, and tool-call persistence, read back through a second client;
- propose → confirm, including the audit row and optimistic locking;
- admin attention data.

It is **not** part of `npm test`, and it is **skipped** unless `TEST_DATABASE_URL` is set. Its guard (`tests/db/guard.ts`, unit-tested offline) **fails closed**.

Before connecting, it requires **all** of:
- an explicit `TEST_DATABASE_URL` (it never falls back to `DATABASE_URL`);
- a non-production environment (not production, not Vercel);
- a URL that isn't the same database (same host, port and database name) as any `DATABASE_URL` or `DIRECT_URL`. It checks the process environment and the files `.env`, `.env.local`, `.env.development`, `.env.development.local`, `.env.test`, `.env.test.local`, `.env.production` and `.env.production.local`. The files are read as text: never loaded into the environment, and their values are never printed. Comments, `export`, whitespace, CRLF and quoted values are handled. It **fails closed** on any value it can't compare: `$` expansion, multi-line or unterminated values, non-URL text, a postgres URL without a database name, or an unreadable file;
- a database **name containing `test`**;
- strict URL settings:
  - names must be lowercase and allow-listed;
  - no setting may appear twice;
  - `schema`, if present, must be exactly `public`;
  - `options` (which can change `search_path`) is refused.

Before any write, it runs **read-only** checks:
- `current_database()` must match the URL's database name;
- relations are listed from `pg_catalog` (`pg_class` joined to `pg_namespace`), **not** from `information_schema`, which hides objects the role lacks privileges on and omits materialized views.
  - It covers ordinary and partitioned tables, views, materialized views and foreign tables.
  - It covers every schema except `pg_catalog`, `information_schema`, `pg_toast*` and temporary schemas, so an empty `public` schema can't authorise a wipe elsewhere.
- an **unmarked** database must contain **no relations at all**; it is then marked, using the verified `current_database()`;
- a **marked** database may contain only this app's own **ordinary tables** in `public`. For example, a view, materialized view, foreign table or partitioned table named like an app table is refused.

Anything else is refused before any marker write, migration, or truncate.

**Known limitation:** host names are compared as text, not resolved. So `localhost` and `127.0.0.1`, or a provider's pooled and direct host names, count as different hosts. The test-name rule, the empty-or-marked rule, and the marked-database table check are what still protect against an alias.

The Prisma CLI is run directly by Node, with no shell and no `npx`. The database URL travels only through the child process's environment, never on a command line, and output is redacted. The drift check uses `--from-schema-datasource`.

Safe local run (free), against a **dedicated, empty** test database, for example a local Docker container.

bash:
```
TEST_DATABASE_URL="postgresql://<user>:<password>@localhost:<port>/portfolio_analyst_test" npm run test:db
```

Windows PowerShell (set for this terminal session only, so it is not saved to any file):
```powershell
$env:TEST_DATABASE_URL = "postgresql://<user>:<password>@localhost:<port>/portfolio_analyst_test"
npm run test:db
Remove-Item Env:TEST_DATABASE_URL
```

If the password contains URL-special characters (`@ : / ? # & %`), percent-encode it, e.g. `@` → `%40`.
The suite migrates the database, then truncates and re-seeds its tables between groups of tests. Use a dedicated test database only.

**Verified locally:** `npm run test:db` passed 14/14 against a local PostgreSQL 16 test database (Docker), including the rolled-back guard probes. An earlier 10-test version passed on both a fresh database and a second run of the already-marked one. **Not verified:** a hosted database such as Neon, its connection pooler, and the full HTTP app running with `DATA_BACKEND=prisma`.

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
| `sample_requests.csv` | The six sample requests, replayed as golden cases R001–R006 by the evaluation harness (`eval/cases.ts`) |
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

## Admin dashboard (`/admin`)

An operations view for the business team. It is for observing and controlling the agent; it is not a CRM.

| Page | Shows |
|---|---|
| `/admin` (overview) | **Needs attention** queue with the reason for each flag; run metrics from recorded runs (count, errors, fallbacks, p50/p95 server latency, how many runs had provider-reported tokens and cost); users with conversation and flag counts |
| `/admin/conversations` | All conversations across users, filterable by user and "needs attention", with message, run and error counts and the last run's status |
| `/admin/conversations/:id` | Attention panel with **Mark as resolved** (keeps the reason and records who resolved it and when; a later failure re-flags the conversation); backend state (focus properties, active scenario, open proposals); the full transcript including tool calls and results; the **execution trace** of every run |

**What a run's execution trace shows:**
- **Status and error.** The error text is redacted.
- **Where the time went:** request (auth and validation), context load, agent, persist.
- **Each model call:** model, fallback flag, ok or error, duration, time to first token, tokens in and out, cost.
- **Each tool call:** outcome, duration, and redacted, size-capped previews of the arguments and result.

**Conversations are flagged automatically when:**
- the agent hands off to a human (`flag_for_human`);
- the model is unavailable or the turn deadline passes;
- an unexpected internal error occurs;
- the tool-round limit is hit;
- two or more tool calls fail in one turn.

**Security:**
- **Basic auth on every admin page and API handler.** Each one checks HTTP Basic auth itself, so the proxy (`src/proxy.ts`) is a convenience that triggers the browser's login prompt, not the security boundary.
- **Fails closed** (503) without a strong `ADMIN_PASSWORD`, in every environment.
- **Constant-time** credential comparison.
- **Lockout:** after 10 failed attempts per client in 5 minutes, logins are refused, including correct ones.
- **Same-origin check** on the state-changing resolve action, as CSRF protection.
- **No caching or indexing:** responses are `no-store` and `noindex`.
- **Separate credentials:** admin credentials don't grant chat access, and a chat session cookie doesn't grant admin access.
- **No secrets in the browser:** credentials never reach it, and the built client bundle was checked for admin or auth code.

**JSON API** for scripts (Basic auth): `GET /api/admin/overview`, `GET /api/admin/conversations?user=U001&attention=1`, `GET /api/admin/conversations/:id`.

**About the numbers shown:**
- Metrics come only from runs actually recorded in the configured store.
- With the dev stub and in-memory data (the defaults), a banner on every admin page says that timings are **not** representative of a real LLM and that data is **not** persisted in PostgreSQL.
- A metric the provider didn't report is shown as **—** ("not reported"), never as 0.

## Evaluation and benchmarks

All of these run locally at zero cost. None of them calls an LLM.

```bash
npm run eval:oracle      # positive control: reference policy must pass 40/40 with 0 safety violations
npm run eval:perturbed   # negative control: falsified figures must be caught by numeric faithfulness
npm run eval:stub        # the keyword stub on the golden set (tuned against these cases; see below)
npm run bench            # in-process pipeline overhead (mock model), writes docs/eval/bench-inprocess.md
npm run bench:http       # against a running server (see eval/httpBench.ts for the exact commands)
npm run test:coverage    # unit/integration coverage
```

The oracle and perturbed controls also run inside `npm test` (`tests/eval.test.ts`), so any regression in tools, numbers, or graders fails CI.

**These are grader and control tests, not AI-quality results.** The oracle is a scripted ideal agent, the perturbed run is the oracle with falsified figures, and the dev stub is a keyword router. Their purpose is to show that the tools, numbers, safety checks, and graders behave correctly. Exact commands and expected results: [FREE_ONLY_EVALUATION.md](FREE_ONLY_EVALUATION.md).

| Control | Cases passed | Numeric faithfulness | Clarification | Safety violations |
|---|---|---|---|---|
| Oracle (must pass) | 40/40 | 34/34 | 7/7 | 0 |
| Perturbed oracle (falsified figures; must be caught) | 12/40 | 1/34 | 7/7 | 0 |
| Dev stub, earlier version (keyword router; must be caught) — historical, commit `76a9571` | 17/40 | 31/31 (copies tool figures verbatim) | 0/7 | 0 |
| Dev stub at commit `fe57eb4` (first deployed version) — historical | 20/40 | 33/33 | 2/7 | 0 |
| Dev stub at commit `5996dba` (live deployment) — historical | 23/40 | 35/35 | 2/7 | 0 |
| Dev stub, current working tree (re-run 2026-10-10 UTC, offline) — **tuned against these cases** | 40/40 | 37/37 | 7/7 | 0 |

**What the stub's 40/40 does and does not mean.**
- **What changed:** the stub's patterns were extended case by case while looking at the golden set's wording, so the stub **no longer works as a negative control**.
- **What it shows:** the tools, the safeguards and the reply templates handle every scenario in the set, with:
  - 0 safety violations;
  - every figure traced to tool output;
  - every clarification a real question;
  - no grader check worse than any earlier run (compared check by check on the raw results).
- **What it does not show:**
  - that the stub handles **other** phrasings;
  - anything about LLM quality.
- **The control that still catches made-up figures** is the perturbed oracle.

Details and history: [docs/eval/dev-stub.md](docs/eval/dev-stub.md).

The runner also has a `--mode openrouter` for a real model. It has **never been run**. It refuses to start without every opt-in flag and spend cap, and, like the app, accepts only `:free` OpenRouter model ids unless `OPENROUTER_ALLOW_PAID=true` (default off) ([PERFORMANCE.md §5](PERFORMANCE.md)).

**Production check on every turn:** each reply is scanned for figures, and any ₹, % or count that isn't in tool output (or in the user's own message) flags the conversation as `unsupported_numbers`.

## How a chat turn works

1. `POST /api/chat/stream` (used by the UI) or `POST /api/chat` (JSON) takes `{message, conversationId?}`.
   - Auth, body validation, rate limit, and conversation ownership are all checked **before** the stream opens, so those failures are ordinary HTTP errors.
   - The stream sends `start`, `status`, `tool_start` / `tool_end`, `delta`, `reset`, and finally `done` or `error`.
   - If the client disconnects, the turn still completes and is saved.
   - The body is checked by a strict schema: an extra field such as `userId` gets a 400. The user id comes **only** from the signed cookie.
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
| `admin` | Admin auth (fails closed, lockout, CSRF), proxy, admin APIs, cross-auth isolation, overview, attention flags and resolution, execution traces, redaction in traces | In-memory store + scripted models |
| `adminPages` | Server-rendered admin pages: page-level auth, content, escaping, "—" for unreported metrics | Mocked request headers + in-memory store |
| `faithfulness` | Number extraction (₹ Cr/L/crore/lakh, %, pp, plain) and support matching | Nothing |
| `eval` | Golden set as a regression gate: oracle passes 40/40, perturbed control is caught; grader unit tests; real-model runner guards (every opt-in, spend caps, `:free`-only OpenRouter ids) | Oracle / perturbed mock models |
| `openrouter` | **Real** LangChain/OpenAI client with an injected fetch replaying synthetic OpenRouter payloads: request shape, tool-call parsing (incl. streamed fragments), usage and cost, 401/402/429/5xx, hung connections, garbage bodies, an end-to-end turn | Network (synthetic payloads) |
| `gemini` | Gemini provider over its OpenAI-compatible endpoint: request shape (no OpenRouter-only fields), parsing, streaming, provider selection (never a silent paid fallback), key redaction, an end-to-end turn | Network (synthetic payloads) |
| `stubFormat` | Dev-stub template replies: readable, no raw JSON, every figure traceable to tool output; filters, totals, comparisons and what-ifs, with figures derived from the domain functions | In-memory store |
| `stubUpdates` | Dev-stub writes through propose → confirm: updates, new properties (missing details, duplicates, multi-turn drafts), status changes, cancel, expiry, optimistic locking, tenant isolation, hand-off | In-memory store |
| `providerSelection`, `providerFallback` | Provider chain (Gemini → OpenRouter `:free` → stub), the `LLM_PROVIDER=stub` default, refusal of non-free OpenRouter ids, 429/5xx/timeout/401/402 handling across providers, last-resort stub, per-turn circuit breaker, admin trace flags, key redaction | Scripted models; a `fetch` spy fails on any network attempt |
| `observability` | Token/cost aggregation (missing ≠ zero), cost extraction, redaction, per-turn fallback circuit breaker | Scripted models; cost metadata shapes are assumed |

Expected figures were derived by hand, for example U001 = ₹29.7 Cr with 71.38% retail, and excluding Bandra gives ₹17.7 Cr.

**Not tested yet:**
- **Systematic real-model evaluation.** Gemini (free tier) has been used manually in the chat, but the 40-case evaluation has **not** been run against any real model. Real-model latency, tokens, tool-calling accuracy and fallback behaviour against live providers are **not measured** (PERFORMANCE.md §5).
- **Live OpenRouter responses.** The integration and the fallback chain are verified only against synthetic payloads and scripted models. Whether a given `:free` model is available and supports tool calling is **unverified**.
- **Deployment, beyond manual checks.**
  - The app is deployed (Vercel + Neon, stub mode) and was checked by hand.
  - There is no automated test against the deployment.
  - There's no internet-latency or concurrent-load measurement.
  - The current working tree is not yet deployed.
- **PostgreSQL beyond the opt-in suite and the live demo.**
  - The Prisma store, migration, seed and admin queries passed `npm run test:db` on a local PostgreSQL 16 test database.
  - The live app runs on Neon and was used by hand.
  - There's no automated suite against Neon or its pooler.
  - The regular `npm test` suites use the in-memory store.
- The UI in a real browser (it is covered by jsdom tests and an HTTP smoke test only) and with real streamed LLM output.

## Known limitations

- **Real model only manually checked.** The live app runs on the dev stub, which shows real tools, calculations and safeguards, but not conversation quality.
  - **With a real model:** answers depend on that model and its free-tier rate limits, and have only been checked by hand.
  - **When every real model fails:** the labelled stub answers and the conversation is flagged `model_degraded`.
- **Stub tuned to the evaluation.** The stub's 40/40 reflects pattern work against the golden set's own wording, not general language understanding.
- **No real authentication.** The demo user picker with a signed cookie is the agreed scope.
- **In-memory data** resets when the server restarts, and each serverless instance has its own copy. Use `DATA_BACKEND=prisma` for persistence.
- **Per-instance limits.** The chat rate limit (`CHAT_RATE_LIMIT_PER_MIN`, default 20 messages per minute per user) is per server instance.
- **Postgres:** automated tests ran on a local PostgreSQL 16 test database only. The live app on Neon was checked by hand, not by a test suite (see "Database").
- **UI tested without a browser.** The UI has been tested in jsdom and over local HTTP, but not in a real browser by an automated test, and not with a real LLM's streamed output.
- **Admin auth** is single-account HTTP Basic auth: there is no logout (close the browser), no roles, and the lockout counter is per server instance.
- **Token usage and cost** are recorded only if the provider reports them. The cost field's location was verified on synthetic OpenRouter payloads only.
- **Attention queue in a live demo.** With the dev stub, the admin "needs attention" queue stays empty unless the user asks for a person or for tax/legal advice. Those messages call `flag_for_human`, and the conversation appears there; nobody is notified automatically. Other flags (`unsupported_numbers`, `model_unavailable`, `model_degraded`) are demonstrated by the tests and the evaluation.

## Demo walkthrough (5–10 minutes, free)

The timed script is in [docs/walkthrough.md](docs/walkthrough.md). It covers two setups:
- **The live site** (commit `5996dba`): it has no hand-off route.
- **A local run of the current tree**: needs `LLM_PROVIDER=stub` in `.env.local`, or `npm run dev` calls a real model.

It lists which claims are measured and which are not.

## External dependencies

| Dependency | Status |
|---|---|
| PostgreSQL | Optional (`DATA_BACKEND=prisma`). Local install, or Neon (free tier) for deployment |
| Google Gemini API key | Optional, free tier (Google AI Studio; keep billing disabled). Used for manual testing. Without it the dev stub is used |
| OpenRouter API key | Optional fallback. Only `:free` model ids are accepted unless `OPENROUTER_ALLOW_PAID=true` (off by default). Never called by any test or evaluation; not used by the deployment |
| Vercel, Neon | Hosting for the live demo (free tiers) |
