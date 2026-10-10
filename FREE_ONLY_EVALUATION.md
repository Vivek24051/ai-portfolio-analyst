# Free-only evaluation

Everything here runs **locally and offline at zero cost**. No step calls OpenRouter, Gemini, or any other LLM endpoint, uses a database, or needs an API key. Results come from mocked models, so they are **grader and control tests, not AI-quality results**.

(Separately, the app can be pointed at Google Gemini's free tier for **manual** demos; see the README, "Optional: connect Google Gemini". Nothing in this document uses it, and the tests mock it.)

## Prerequisites

- Node ≥ 20.9.
- `npm install`. This is the only step that needs network access: it downloads packages from the npm registry.
- The synthetic dataset is committed in `data/seed/`.
- No `.env` file is needed for the commands below.

Optional, to stop the build tools' anonymous telemetry pings (these are free and not needed by any step): set `NEXT_TELEMETRY_DISABLED=1` and `CHECKPOINT_DISABLE=1`. The Prisma migration test already disables Prisma's check itself.

## 1. The safety net: tests, types, build

```bash
npm test            # 289 tests, all offline; models, storage and network are mocked
npm run typecheck   # tsc --noEmit
npm run build       # prisma generate + next build; needs no environment variables
```

`npm test` already includes the golden-set controls (`tests/eval.test.ts`): the oracle must pass every case, and the perturbed control must be caught.

## 2. Control runs on the golden set (40 cases, 50 turns)

```bash
npm run eval:oracle      # writes docs/eval/oracle.md
npm run eval:perturbed   # writes docs/eval/perturbed.md
npm run eval:stub        # writes docs/eval/dev-stub.md
# add  -- --no-write  to print the summary without touching the committed reports
```

| Run | What the "model" is | Expected result | What it proves |
|---|---|---|---|
| **Oracle** (positive control) | A scripted ideal agent that replays each case's reference tool calls and builds its reply only from tool output | 40/40 cases, 0 safety violations | The tools, deterministic figures, flags, proposals, hypothetical isolation, and safety checks give exactly the expected outcome for a correct agent. The expectations themselves are consistent. |
| **Perturbed** (negative control: figures) | The oracle, with every ₹ amount +10% and every % +3 points in the reply | Numeric faithfulness about 1/34, expected figures about 1/23, while tool selection and arguments stay 100% | The number checks catch fabricated figures, independently of tool behaviour |
| **Dev stub** (negative control: behaviour) | The keyword router used when no key is configured | About 17/40 cases; clarification 0/7; hypothetical labelling 0/5 | The behavioural graders catch an agent that doesn't ask, propose, or label hypotheticals |

Pass/fail counts are deterministic. Timings in these reports include the offline token-estimation wrapper, so they are **not** latency figures.

## 3. Local benchmarks (our own overhead, no model)

```bash
npm run bench -- --iterations 30    # in-process pipeline, oracle mock → docs/eval/bench-inprocess.md
```

HTTP benchmark against a local production build, using the dev stub with no artificial delay:

```bash
npm run build
# terminal 1 (bash syntax; use your shell's equivalent to set env vars)
SESSION_SECRET=<any 32+ char string> DEV_STUB_STREAM_DELAY_MS=0 CHAT_RATE_LIMIT_PER_MIN=100000 npx next start -p 3123
# terminal 2
BENCH_URL=http://localhost:3123 npm run bench:http -- --iterations 25   # → docs/eval/bench-http.md
```

Last measured (AMD Ryzen 7 4800HS, Windows 11, Node 20.20.2):

| Benchmark | p50 | p95 |
|---|---|---|
| In-process server time per turn | 4.1 ms | 6.4 ms |
| JSON over local HTTP | 9.6 ms | 12.5 ms |

Absolute timings vary by machine. Neither benchmark includes LLM latency.

## 4. Coverage

```bash
npm run test:coverage
```

Last result: 90.2% lines, 75.49% branches. The Prisma store and `db.ts` are at 0%, because no test uses a real database.

## 5. Intentionally not performed (needs real or paid infrastructure)

| Validation | Why it isn't done here |
|---|---|
| Real-LLM tool selection, accuracy, faithfulness, clarification | Needs a paid model API |
| Real model latency, time to first token, token usage, cost | Needs a paid model API |
| Live OpenRouter response format (e.g. where `usage.cost` appears) | Needs the live API. Verified only on synthetic payloads (`tests/openrouter.test.ts`) |
| Prisma store, migration, and seed against PostgreSQL | Needs a database. Type-checked, plus an offline migration-drift test |
| Deployment, internet latency, concurrent load | No deployment; single local client only |

The runner's `--mode openrouter` exists for a future real-model evaluation. It is **not** part of this free-only process and refuses to run without explicit opt-in flags (`EVAL_ALLOW_PAID=1`, `--confirm-paid`) and spend caps.
