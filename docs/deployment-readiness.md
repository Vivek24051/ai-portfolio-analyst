# Deployment readiness (Vercel Hobby + free PostgreSQL)

> **Status: deployed in stub mode** at https://ai-portfolio-analyst-two.vercel.app (Vercel + Neon), `LLM_PROVIDER=stub`.
>
> **Checked by hand on the live site by the owner:**
> - `model: dev-stub` and `data: prisma` in the admin header;
> - chat, admin login and the conversation list work;
> - conversations are stored in Neon;
> - the retail-share, missing-ROI-data and update → confirm/cancel flows (commit `5996dba`).
>
> There is **no automated test against the deployment**. Later commits and the current working tree are **not deployed**. Provider limits on this page (Vercel, Neon, Gemini, OpenRouter) have **not** been checked against live documentation or accounts.

## Blockers

| # | Blocker | Status |
|---|---|---|
| B1 | Storage defaults to in-memory unless `DATA_BACKEND=prisma`. On serverless, each instance would have its own data, which resets on cold start. | Set `DATA_BACKEND=prisma` in the deployment environment. |
| B2 | The Prisma store, migration, and seed needed verification against PostgreSQL. | **Resolved locally:** `npm run test:db` passed 14/14 on a local PostgreSQL 16 test database (Docker). **Hosted PostgreSQL compatibility and permissions are unverified.** The app itself now runs on Neon (checked by hand), but `npm run test:db` has **not** been run against a hosted test branch or database (see the note on privileges below). |

### Note: privilege-sensitive guard probes

The suite's rolled-back guard probes need privileges that a hosted database role may not have:
- **Privilege-sensitive:** `CREATE SCHEMA` and `SET LOCAL ROLE pg_monitor`. If the role lacks them, these probes **fail** rather than skip.
- **Skippable:** the `postgres_fdw` foreign-table probe. It is skipped automatically when the extension can't be created.

There is no guarantee that the hosted test-database run will pass. A failure in these probes points to missing privileges, not necessarily to a fault in the Prisma layer. Check the actual failure before drawing conclusions.

## Implemented

- **R1:** the seed transaction has explicit limits (`maxWait` 10 s, `timeout` 30 s; justified in `prisma/seedDatabase.ts`). Request-path transactions keep Prisma's defaults.
- **R2:** `LLM_PROVIDER=stub` forces the dev stub whatever keys are present, and any unrecognised `LLM_PROVIDER` value also falls back to the stub. Covered by `tests/providerSelection.test.ts`, which asserts that no `fetch` is made.

## Recommendations not applied (need verification first)

These are deliberately **not** changed in code, because the right values depend on current provider limits that haven't been checked.

| # | Area | Current configuration | Recommendation |
|---|---|---|---|
| R3 | Function duration | `maxDuration = 60` on `/api/chat` and `/api/chat/stream`; `CHAT_TURN_DEADLINE_MS` default 50 s; per-call timeout 20 s | Check the Hobby plan's current maximum function duration. If it is below 60 s, lower `maxDuration` and set `CHAT_TURN_DEADLINE_MS` a few seconds under it. With the dev stub, a turn takes milliseconds, so this only matters for a real model. |
| R4 | Database connection | `DATABASE_URL` (runtime) and `DIRECT_URL` (migrations) come from env; no pool settings in code | Use the provider's **pooled** URL for `DATABASE_URL` and the **direct** URL for `DIRECT_URL`. Consider `sslmode=require`, a `connect_timeout` that allows for auto-suspend wake-up (e.g. 15 s), and a small `connection_limit`. Add `pgbouncer=true` only if Prisma reports prepared-statement errors through the pooler. Confirm all of these against the provider's current Prisma guidance. |
| R5 | Region | Not configured | Put the database in the same region as the functions; cross-region round trips add up over ~10 queries per chat turn. |

## Production environment variables (Production **and** Preview)

| Variable | Value |
|---|---|
| `DATA_BACKEND` | `prisma` |
| `DATABASE_URL` / `DIRECT_URL` | Provider's pooled / direct connection strings |
| `SESSION_SECRET` | New random value, ≥ 32 characters. Don't reuse the local one. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / a strong password of ≥ 12 characters |
| `LLM_PROVIDER` | `stub` (current live setting): no model client is built and no model API can be called |
| `OPENROUTER_ALLOW_PAID` | Leave unset or `false` (default). Only `true`/`1` allows paid OpenRouter models |
| **Do not set (stub mode)** | `GEMINI_API_KEY`, `OPENROUTER_API_KEY` |

`.env.local` is git-ignored and is **not** uploaded by a Git-based deployment. Set every value above in the provider dashboard.

## Manual checks before any deployment

- **Vercel Hobby:**
  - It is for personal, non-commercial use. Decide whether an interview assignment qualifies.
  - Check the current function duration limit and usage quotas.
  - Check whether your repository type (personal vs. organisation) is supported.
- **Free Postgres (e.g. Neon):**
  - Is a card required?
  - What are the storage and compute limits?
  - How does auto-suspend behave?
- **Gemini, later only:** a free-tier key on a project with billing **disabled**.

## Enabling a real model later (free-only; not done)

This is configuration only; the code is in place and tested offline with scripted models.

**Settings:**
- `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` and `LLM_PRIMARY_MODEL`: a model your AI Studio project shows free quota for.
- Optionally `LLM_FALLBACK_PROVIDER=openrouter`, `OPENROUTER_API_KEY` and `LLM_FALLBACK_MODEL=<vendor/model>:free`.
- `LLM_STUB_LAST_RESORT` stays `true` (the default).

**Guarantees in code (offline tests):**
- OpenRouter ids without `:free` are refused unless `OPENROUTER_ALLOW_PAID=true`.
- A 401/402 is never retried on the same provider.
- If every real model fails, the labelled stub answers and the conversation is flagged `model_degraded`.

**Not verified:**
- that any specific model is free, available, or supports tool calling;
- real-model latency within `maxDuration` (R3);
- behaviour under the free-tier rate limits.

Verify these manually before switching, and keep billing disabled (Gemini) and credits at zero (OpenRouter).

## Order of operations (as carried out)

1. ✅ A local test database: `npm run test:db` passed (14/14).
2. ✅ The Neon database was migrated and seeded; the app reads it. ⚠️ `npm run test:db` against a separate hosted **test** branch was **not** run.
3. ✅ Imported into Vercel with `LLM_PROVIDER=stub` and no payment method.
4. ✅ Deployed and smoke-tested by hand. There is no automated check, and survival across a redeploy was not separately recorded. The checks were:
   - `/api/session` reports `modelMode: "dev-stub"` and `dataBackend: "prisma"`;
   - a chat as Rahul works;
   - the conversation appears in `/admin` and survives a redeploy.
