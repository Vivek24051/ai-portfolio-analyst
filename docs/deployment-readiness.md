# Deployment readiness (Vercel Hobby + free PostgreSQL)

> **Status:** not deployed. Nothing on this page has been checked against live provider documentation or accounts. Every provider limit below must be verified manually before acting on it.

## Blockers

| # | Blocker | Status |
|---|---|---|
| B1 | Storage defaults to in-memory unless `DATA_BACKEND=prisma`. On serverless, each instance would have its own data, which resets on cold start. | Set `DATA_BACKEND=prisma` in the deployment environment. |
| B2 | The Prisma store, migration, and seed needed verification against PostgreSQL. | **Resolved locally:** `npm run test:db` passed 14/14 on a local PostgreSQL 16 test database (Docker). **Hosted PostgreSQL compatibility and permissions are unverified.** Still to do: run it against a separate **test** branch or database at the hosting provider before going live (see the note on privileges below). |

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
| `LLM_PROVIDER` | `stub` for the first deployment, so no model API can be called |
| **Do not set** | `GEMINI_API_KEY`, `OPENROUTER_API_KEY` |

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

## Order of operations (when approved)

1. Create an empty local test database and run `npm run test:db` until it passes, which clears B2.
2. Create the free database, run `npm run db:deploy` and `npm run db:seed` once from your machine with its URLs in the shell, and run `npm run test:db` against a separate **test** database or branch.
3. Import the repository into Vercel, set the environment variables above (`LLM_PROVIDER=stub`), and add no payment method.
4. Deploy, then smoke-test:
   - `/api/session` reports `modelMode: "dev-stub"` and `dataBackend: "prisma"`;
   - a chat as Rahul works;
   - the conversation appears in `/admin` and survives a redeploy.
