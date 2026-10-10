# Walkthrough script (5–10 minutes)

A spoken script for the submission walkthrough. Every claim below is checked against the code, the tests, or a measured report. Anything not measured is said out loud as not measured.

## Before you present

Pick **one** of these setups and say which one you are using.

| Setup | What it runs | Use it for |
|---|---|---|
| **A. Live site**: https://ai-portfolio-analyst-two.vercel.app | Commit `5996dba`, `LLM_PROVIDER=stub`, Neon PostgreSQL | Steps 1–4 and 6. It has **no hand-off route** (step 5), so its attention queue is usually empty |
| **B. Local**: the current working tree | Dev stub, in-memory data | Every step, including the hand-off and the attention queue |

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

**Say plainly:** "The live demo runs the **dev stub**: a keyword router, **not an LLM**. It calls the same real tools and safeguards. It was tuned against the 40 evaluation cases, so it shows the plumbing, not language understanding. **No real Gemini or OpenRouter call has been tested** in any automated test or evaluation."

### 3:30–4:30 · Writes need confirmation

| Message | Point it makes |
|---|---|
| "Update P001's annual rent to ₹80 lakh per year" | `propose_property_update` shows current → new, labelled **Not saved yet**; nothing is written |
| "cancel" (or the Cancel button) | The proposal is dropped. A "yes" or the Confirm button saves through `confirm_pending_action`, which re-checks the user, conversation, expiry and version, and writes an audit row. Confirm never calls the LLM |

### 4:30–5:00 · Hand-off (setup B only)

| Message | Point it makes |
|---|---|
| "I want to speak to a human advisor" | `flag_for_human` flags the conversation. The reply says **no one is contacted automatically**; a team member reviews the queue |

On setup A, skip this step and say that the hand-off route was added after the live commit.

### 5:00–6:30 · Admin: the business view

**Show:** `/admin` (Basic auth) → the conversation you just used → its execution trace.

**Say:**
- "The overview has a needs-attention queue with reasons, run metrics and users." (With setup B, the hand-off conversation is in the queue.)
- "The trace shows spans (request, context load, agent, persist), each model call and each tool call with redacted previews."
- "Tokens and cost show '—' because the stub doesn't report them. A missing metric is never shown as zero."
- "Every admin page and API checks Basic auth itself, and it fails closed without a strong password."

### 6:30–8:00 · Design decisions in the code

**Show:** [SOUL.md](../SOUL.md), then `src/agent/tools.ts`.

**Say:**
- "Nine tools with strict zod schemas. None of them takes a `userId`: the user comes from the signed cookie, and every store query is scoped to that user."
- "A same-turn self-confirm is blocked. A hypothetical has no path to the database."
- "The model chain is primary, then fallback, then the labelled stub. OpenRouter ids must end in `:free` unless paid use is explicitly enabled. All of this is tested offline with scripted models only."

### 8:00–10:00 · Evidence and limits

**Show:** a terminal running `npm test`, then [PERFORMANCE.md](../PERFORMANCE.md) §2 and §5–7.

**Say:**
- "`npm test`: 422 tests, all offline. The oracle reference policy passes 40 of 40 cases. The perturbed oracle, which has falsified figures, is caught by the faithfulness check: 1 of 34 replies faithful."
- "Measured: about 4 ms of server pipeline per turn in-process with a mock model, and about 10 ms per request over local HTTP with the stub."
- "**Not measured:** real-model latency and tool-calling quality, Postgres or Neon latency, and internet latency to the deployment."
- "Design-level latency: about 2 model calls per turn (p50), and tool schemas are about 83% of input tokens. Those are the first things I'd optimise."
- "At higher volume: prompt caching, trimmed tool schemas, a queue in front of a WhatsApp webhook, and a shared rate limit instead of a per-instance one."

## Questions to be ready for

- **Why not RAG or vector search?** The data is small and structured, and SQL filters are exact (DECISIONS D3).
- **Why a single agent?** An extra LLM hop per turn adds latency and cost and gains nothing at this size (D1).
- **What breaks with a real model?** It hasn't been measured. The guards in place: numeric faithfulness flags figures not in tool output, the 5-round tool budget, timeouts, and confirmation before writes.
- **What if a key is bad (401) or credits run out (402)?** No model on that provider is called again for the rest of the turn, including later tool rounds. A different, explicitly labelled provider can still be tried, and then the labelled stub, which flags the conversation `model_degraded`. All of this is tested with scripted models only.
