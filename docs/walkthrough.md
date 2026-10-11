# Walkthrough script (5–10 minutes)

A spoken script for the submission walkthrough. Every claim below is checked against the code, the tests, or a measured report. Anything not measured is said out loud as not measured.

## Before you present

Pick **one** of these setups and say which one you are using.

| Setup | What it runs | Use it for |
|---|---|---|
| **A. Live site**: https://ai-portfolio-analyst-two.vercel.app | Gemini 3.5 Flash Lite (free tier), Neon PostgreSQL | Every step. Uses free quota, about 2–4 calls per message |
| **B. Local, stub** (backup if the quota is used up) | Dev stub, in-memory data | Every step; replies are templates, labelled `[dev stub …]` |

For setup B:
1. `npm install`
2. `.env.local` needs `ADMIN_USERNAME` and `ADMIN_PASSWORD` (12 characters or more), and **`LLM_PROVIDER=stub`**. Any other value, such as `gemini` with a key, makes `npm run dev` call a real model.
3. `npm run dev`, then open http://localhost:3000 and http://localhost:3000/admin.

Have these open in tabs: [docs/architecture.md](architecture.md), [SOUL.md](../SOUL.md), [PERFORMANCE.md](../PERFORMANCE.md), and `src/agent/tools.ts`.

## Script

### 0:00–1:00 · The problem and the shape of the system

**Show:** [docs/architecture.md](architecture.md), the first diagram.

**Say:**
- "One user talks to one tool-calling agent, built with LangGraph. The model chooses tools; it never does arithmetic."
- "Every figure comes from deterministic domain code in `src/domain`. The model only phrases the tool output, and a faithfulness check flags any figure that isn't in that output."
- "Writes go through propose, then confirm. The business team gets a separate admin view with traces and an attention queue."

### 1:00–3:30 · Chat: analysis, context, hypotheticals

**Show:** the chat. Pick the demo client **Rahul** and send these in order.

| Message | Point it makes |
|---|---|
| "What does my portfolio look like?" | Totals and mix come from `portfolio_analytics`; the tool steps appear under "how I worked this out" |
| "How much of my portfolio is retail?" | ₹29.7 Cr in total, 71.38% retail; computed by the backend and hand-checked in the tests |
| "Which of those retail properties earns more annual rent?" | Follow-up context: the backend tracks the last result set as focus ids, so the agent doesn't rely on memory |
| "What if the annual rent of P001 increases by 10%?" | Hypothetical: the reply has a dashed border and the "Hypothetical scenario — your real portfolio is unchanged" banner; the scenario runs on a copy |
| "What is my portfolio's total appreciation since purchase?" | Honest gap: the dataset has no dates and no purchase prices, so it says it can't calculate this instead of inventing a number |

**Say plainly:**
- "The live demo runs **Gemini 3.5 Flash Lite on Google's free tier**. The model only chooses tools and phrases their output; every figure comes from the backend."
- "Gemini was checked by hand on these flows; the 40-case evaluation has **not** been run against it. The automated tests use scripted models and synthetic Gemini responses."
- "If Gemini is unavailable, a labelled keyword stub answers from the same tools and the conversation is flagged `model_degraded`."

(Setup B: say that the stub is a keyword router tuned to the evaluation cases, not an LLM.)

### 3:30–4:30 · Writes need confirmation

| Message | Point it makes |
|---|---|
| "Update P001's annual rent to ₹80 lakh per year" | `propose_property_update` shows current → new, labelled **Not saved yet**; nothing is written |
| "cancel" (or the Cancel button) | The proposal is dropped. A "yes" or the Confirm button saves through `confirm_pending_action`, which re-checks the user, conversation, expiry and version, and writes an audit row. Confirm never calls the LLM |

### 4:30–5:00 · Hand-off

| Message | Point it makes |
|---|---|
| "I want to speak to a human advisor" | `flag_for_human` flags the conversation. The reply says **no one is contacted automatically**; a team member reviews the queue |

### 5:00–6:30 · Admin: the business view

**Show:** `/admin` (Basic auth) → the conversation you just used → its execution trace.

**Say:**
- "The overview has a needs-attention queue with reasons, run metrics and users." The hand-off conversation from the previous step is in the queue.
- "The trace shows spans (request, context load, agent, persist), each model call and each tool call with redacted previews."
- "Tokens and cost show '—' because neither Gemini's streamed replies nor the stub report them. A missing metric is never shown as zero."
- "Every admin page and API checks Basic auth itself, and it fails closed without a strong password."

### 6:30–8:00 · Design decisions in the code

**Show:** [SOUL.md](../SOUL.md), then `src/agent/tools.ts`.

**Say:**
- "Nine tools with strict zod schemas. None of them takes a `userId`: the user comes from the signed cookie, and every store query is scoped to that user."
- "A same-turn self-confirm is blocked. A hypothetical has no path to the database."
- "The model chain is Gemini 3.5 Flash Lite, then 3.1 Flash Lite, then the labelled stub, with a cap of 4 model calls per message and quota cooldowns. OpenRouter ids must end in `:free` unless paid use is explicitly enabled. The chain's error handling is tested offline with scripted models only."
- "The first real Gemini test found a real bug: Gemini 3.x requires each tool call's thought signature back. The stub covered it, the trace showed the exact error, and I fixed it with a regression test (DECISIONS D59)."

### 8:00–10:00 · Evidence and limits

**Show:** a terminal running `npm test`, then [PERFORMANCE.md](../PERFORMANCE.md) §2 and §5–7.

**Say:**
- "`npm test`: 451 tests, all offline. The oracle reference policy passes 40 of 40 cases. The perturbed oracle, which has falsified figures, is caught by the faithfulness check: 1 of 34 replies faithful."
- "Measured: about 4 ms of server pipeline per turn in-process with a mock model, and about 10 ms per request over local HTTP with the stub."
- "Observed by hand with Gemini: about 3–4 seconds per tool-using turn. That's a handful of turns, not a benchmark."
- "**Not measured:** systematic Gemini latency and tool-calling quality, Postgres or Neon latency, and load."
- "Design-level latency: about 2 model calls per turn (p50), and tool schemas are about 83% of input tokens. Those are the first things I'd optimise."
- "At higher volume: prompt caching, trimmed tool schemas, a queue in front of a WhatsApp webhook, and a shared rate limit instead of a per-instance one."

## Questions to be ready for

- **Why not RAG or vector search?** The data is small and structured, and SQL filters are exact (DECISIONS D3).
- **Why a single agent?** An extra LLM hop per turn adds latency and cost and gains nothing at this size (D1).
- **What breaks with a real model?** Only a few flows were checked by hand, and the first test found the thought-signature bug. The guards in place: numeric faithfulness flags figures not in tool output, the 5-round tool budget, the per-message call cap, timeouts, and confirmation before writes.
- **What happens when the free quota runs out?** The 429 puts that model in a cooldown, the second model is tried, and then the labelled stub answers. No billing is enabled, so nothing is charged.
- **What if a key is bad (401) or credits run out (402)?** No model on that provider is called again for the rest of the turn, including later tool rounds. A different, explicitly labelled provider can still be tried, and then the labelled stub, which flags the conversation `model_degraded`. All of this is tested with scripted models only.
