# AI Real Estate Portfolio Analyst

A conversational AI analyst for a real-estate portfolio, with a WhatsApp-style chat and a separate business operations dashboard. Users can ask about their portfolio, explore what-if scenarios, and add or update properties. Every figure is calculated by the backend, and every write requires the user's confirmation.

> **Status: in progress.**
>
> | Phase | Scope | Status |
> |---|---|---|
> | 0 | Scaffold, schema, seed | ✅ |
> | 1 | Domain core and tests | ✅ |
> | 2 | Agent and tools | ⏳ |
> | 3 | Chat UI | ⏳ |
> | 4 | Admin and observability | ⏳ |
> | 5 | Evaluation and performance | ⏳ |
> | 6 | Docs and deploy prep | ⏳ |
>
> Sections marked _(planned)_ describe work that is not built yet.

## Documents

| File | Contents |
|---|---|
| [SOUL.md](SOUL.md) | The agent's role, voice, boundaries, and when it asks questions or hands off to a human |
| [DECISIONS.md](DECISIONS.md) | Decision log: engineering choices and trade-offs |
| [PERFORMANCE.md](PERFORMANCE.md) | Latency methodology and measured results |
| [docs/architecture.md](docs/architecture.md) | End-to-end architecture diagram |
| [data/original/](data/original/) | The assignment PDF and dataset files, unmodified |

## Stack

- **Next.js 16** (App Router) and **TypeScript**. One deployable unit contains the chat UI, the admin UI, and the API routes.
- **PostgreSQL** with **Prisma 6**. Neon in production, any local Postgres in development.
- **LangGraph.js** for a single tool-calling agent loop with explicit step limits _(planned)_.
- **OpenRouter** as the model gateway, with a configurable primary and fallback model _(planned)_.
- **Vitest** for unit tests.

## Project layout

```
src/
  domain/          Pure, framework-free logic (unit-tested)
    money.ts         {amount, unit} → whole INR; crore/lakh formatting
    normalize.ts     "Commercial Office"/"Office" → OFFICE; COMMERCIAL = retail + office
    location.ts      "Locality, City" parsing; Alibaug/state handling; Delhi NCR expansion
    filters.ts       Strict zod filter schema shared by all read tools
    analytics.ts     Totals, breakdowns, yields, tie-aware rankings, group comparison
    scenario.ts      What-if engine over a cloned portfolio (never writes)
    propertyChanges.ts  Create/update validation, missing-field detection, duplicate check
    affirmation.ts   Deterministic "is this a clear yes?" check
  data/seedData.ts   CSV → validated domain records, with a normalisation report
  server/
    stores/          Persistence interfaces; Prisma and in-memory implementations, all user-scoped
    services/propertyActions.ts  Propose → confirm write flow
    db.ts            Prisma client singleton
  app/               Next.js routes (chat/admin UI planned)
prisma/              schema.prisma, seed.ts
tests/               Vitest suites, run against the real assignment CSVs
```

## Setup (local)

Prerequisites: Node ≥ 20.9 and a PostgreSQL database (local install, Docker, or a free Neon branch).

```bash
npm install
cp .env.example .env            # then set DATABASE_URL / DIRECT_URL (and later the OpenRouter key)
npm run db:seed:dry             # validate + normalise the CSVs without touching a database
npm run db:migrate              # create tables
npm run db:seed                 # load users and properties (idempotent)
npm test                        # unit tests (no database or API key needed)
npm run dev
```

## Dataset files

The assignment's files are **not committed** to this repository. Before running seeds or tests, put the original `users.csv`, `properties.csv` and `sample_requests.csv` in `data/original/`. The seed script and the test suite read from there, and treat those files as read-only.

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

`npm test` runs the unit suites against the **actual** assignment CSVs. Expected figures were derived by hand, for example U001 = ₹29.7 Cr with 71.38% retail. The suites cover:

- money conversion
- normalisation
- location parsing
- seed validation
- analytics, including ties, the empty portfolio, and ownership weighting
- filters (sample requests R001–R003)
- scenarios: excluding Bandra, and checking that real records are never modified
- create/update validation and duplicate detection
- the propose/confirm flow: same-turn block, affirmation check, expiry, optimistic-lock conflict, and double-confirm
- cross-user authorization

## Known limitations (so far)

- No real authentication. A demo user picker with a signed cookie is planned, as agreed for the assignment.
- No integration tests against a live database yet. The Prisma store mirrors the in-memory store's scoping rules but has not been run against Postgres in this repo yet.

## External dependencies

| Dependency | Status |
|---|---|
| PostgreSQL | Local install, or Neon (free tier) for deployment |
| OpenRouter API key | _(planned)_ Paid usage; nothing is called without a key in `.env` |
