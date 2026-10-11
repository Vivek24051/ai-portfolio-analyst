# Deployment readiness (Vercel Hobby + free PostgreSQL)

> **Status: deployed with Gemini (free tier)** at https://ai-portfolio-analyst-two.vercel.app (Vercel + Neon), commit `29c4b6d`, since 2026-10-11.
> - **Model chain:** `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → labelled stub.
> - **History:** the site ran `LLM_PROVIDER=stub` until then.
>
> **Checked by hand on the live site by the owner (2026-10-11):**
> - `model: gemini` and `data: prisma` in the admin header;
> - an overview and a follow-up answered by Gemini with correct tool figures, and no fallback or attention flag;
> - **earlier, in stub mode:** chat, admin login, conversation storage in Neon, and the update → confirm/cancel flow.
>
> **Test path before switching:** the Gemini settings were first tried on a Vercel **Preview** scoped to a `gemini-preview` branch, with in-memory data so Neon was untouched. That first test exposed the thought-signature bug (D59).
>
> There is **no automated test against the deployment**. Provider limits were read from the owner's AI Studio rate-limit screen on 2026-10-11 (Flash Lite models: 15 RPM, 500 RPD each); Vercel and Neon limits were not checked against live documentation.

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
| `LLM_PROVIDER` | `gemini` (current live setting). `stub` switches back to the stub with no model client at all; redeploy after changing |
| `GEMINI_API_KEY` | Production only, type Secret: a key from a Google AI Studio project with **billing disabled** |
| `LLM_PRIMARY_MODEL` / `LLM_FALLBACK_MODEL` | `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite` (Production only) |
| `LLM_FALLBACK_PROVIDER` | `gemini` |
| `LLM_STUB_LAST_RESORT` | `true` |
| `LLM_MAX_MODEL_CALLS_PER_TURN` | `4` |
| `CHAT_RATE_LIMIT_PER_MIN` | `3` (protects the free quota; per server instance) |
| `OPENROUTER_ALLOW_PAID` | Leave unset or `false` (default). Only `true`/`1` allows paid OpenRouter models |
| **Do not set** | `OPENROUTER_API_KEY` |

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

## Enabling a real model (free-only; done on 2026-10-11)

Configuration only, plus the thought-signature fix (D59) found by the first real test.

**Settings:**
- `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` and `LLM_PRIMARY_MODEL`: a model your AI Studio project shows free quota for.
- `LLM_FALLBACK_PROVIDER=gemini` and `LLM_FALLBACK_MODEL`: a second free model with its own quota. OpenRouter `:free` is also possible but was not used.
- `LLM_STUB_LAST_RESORT` stays `true` (the default).

**Guarantees in code (offline tests):**
- OpenRouter ids without `:free` are refused unless `OPENROUTER_ALLOW_PAID=true`.
- A 400 invalid key, 401, 402 or 403 is never retried on the same provider; a 429 cools that model down across turns; at most 4 real calls per message.
- If every real model fails, the labelled stub answers and the conversation is flagged `model_degraded`.

**Checked by hand:**
- both Flash Lite models are on the free tier for this project;
- AI Studio lists function calling for both;
- `gemini-3.5-flash-lite` completed tool-using turns in about 3–4 s, well within `maxDuration` (R3).

**Not verified:** behaviour when the free quota is exhausted live, and the fallback model's own tool calling (it hasn't answered a live turn yet).

Keep billing disabled (Gemini) and credits at zero (OpenRouter).

## Order of operations (as carried out)

1. ✅ A local test database: `npm run test:db` passed (14/14).
2. ✅ The Neon database was migrated and seeded; the app reads it. ⚠️ `npm run test:db` against a separate hosted **test** branch was **not** run.
3. ✅ Imported into Vercel with `LLM_PROVIDER=stub` and no payment method.
4. ✅ Deployed and smoke-tested by hand. There is no automated check, and survival across a redeploy was not separately recorded. The checks were:
   - `/api/session` reports `modelMode: "dev-stub"` and `dataBackend: "prisma"`;
   - a chat as Rahul works;
   - the conversation appears in `/admin` and survives a redeploy.
5. ✅ Gemini tested on a branch-scoped Vercel Preview (`gemini-preview`, in-memory data), then locally. The thought-signature bug was found and fixed (D59).
6. ✅ Production switched to `LLM_PROVIDER=gemini` with Production-only Gemini variables, redeployed, and checked by hand (see the status note).
