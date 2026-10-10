# Architecture

> All components below are built. Deployed on Vercel + Neon in **stub mode** (`LLM_PROVIDER=stub`, no LLM). See the README for what has and has not been verified against real services — in particular, no real Gemini/OpenRouter call is part of any automated test.

```mermaid
flowchart LR
  subgraph Browser
    Chat["Chat UI (/) — WhatsApp-style<br/>reducer + SSE client"]
    Admin["/admin — ops dashboard<br/>Basic auth (proxy + every page/API)"]
  end

  subgraph Next["Next.js app (Node runtime)"]
    Session["/api/session<br/>signed HTTP-only cookie"]
    API["POST /api/chat/stream (SSE)<br/>POST /api/chat (JSON)<br/>strict body · cookie → userId · rate limit"]
    Hist["GET /api/conversations[/:id]<br/>display-ready history"]
    Btn["POST /api/chat/actions<br/>Confirm/Cancel — no LLM"]
    Svc["chatService<br/>load history + state + portfolio<br/>turn deadline · persist · telemetry"]
    Graph["LangGraph<br/>agent ⇄ tools · max 5 rounds<br/>final no-tools call · limit node"]
    Router["Model router<br/>primary → fallback (may be another provider)<br/>→ dev stub last resort<br/>per-call timeout · per-turn circuit breaker"]
    Tools["9 tools<br/>strict zod · trusted ToolContext<br/>structured errors"]
    Domain["Domain core<br/>analytics · scenario · money<br/>normalise · location · validation"]
    Actions["Propose → confirm service"]
    Stores["User-scoped stores<br/>Prisma | in-memory"]
  end

  LLM[("Gemini (free tier) · OpenRouter (:free ids only by default)<br/>or dev stub (default, no LLM)")]
  DB[("PostgreSQL / Neon<br/>or in-memory")]

  Chat --> Session
  Chat --> API --> Svc --> Graph
  Chat --> Hist --> Stores
  Chat --> Btn --> Actions
  Graph --> Router <--> LLM
  Graph --> Tools --> Domain
  Tools --> Actions --> Stores
  Tools --> Stores
  Svc --> Stores --> DB
  Admin --> AdminSvc["adminService<br/>AdminStore (only cross-user port)"] --> DB
```

## One turn

```mermaid
sequenceDiagram
  participant U as User
  participant API as /api/chat
  participant S as chatService
  participant G as LangGraph
  participant M as Model (primary → fallback → stub)
  participant T as Tools
  participant DB as Stores
  U->>API: {message, conversationId?} + cookie
  API->>S: userId (from cookie), message
  S->>DB: conversation (scoped), last 30 msgs, state, properties
  S->>G: history + system prompt (rules, numberless index, focus, scenario, pending)
  loop at most 5 tool rounds
    G->>M: messages + tool specs
    M-->>G: tool calls
    G->>T: validate (zod) + execute with trusted userId
    T->>DB: scoped reads / staged writes
    T-->>G: pre-formatted results or structured errors
  end
  G->>M: messages (+ tools unless budget spent)
  M-->>G: final answer
  S->>DB: append turn + state + attention flag (atomic)
  S->>DB: run telemetry (spans, LLM calls, tool calls)
  G-->>U: SSE: status · tool_start/tool_end · delta (streamed answer)
  S-->>U: SSE done: reply, pendingAction card?, hypothetical?, toolActivity, telemetry
```

## Key invariants (enforced in code, covered by tests)

- **User scoping.** The user id comes only from the signed cookie. Tool and API schemas are strict, so an injected `userId` is rejected. Every store query filters by `userId`, so another user's record looks the same as one that doesn't exist.
- **Numbers.** Every figure comes from `src/domain`. Tools return pre-formatted strings, and the prompt's property index has no numbers.
- **Hypotheticals.** Scenarios run on a cloned portfolio and are tagged `hypothetical: true`. They have no path to the database.
- **Writes.** Every write needs a pending action. Confirmation happens in a later turn, with either a clear yes or the button, which never calls the LLM. Writes are transactional and use optimistic locking.
- **Bounded execution.** At most 5 tool rounds. Each model call has its own timeout and the turn has an overall deadline; the user always gets a reply.
  - **Model failures:** a failing model moves on to the fallback (which may be another provider), then to the labelled dev stub when the last resort is enabled.
  - **Account errors:** a 401/402 is never retried on the same provider for the rest of the turn, including later tool rounds.
  - **Per-turn circuit breaker:** a model that failed is not called again in that turn.
  - **Visibility:** a stub last-resort answer flags the conversation `model_degraded`.
- **Free-only by default.** `LLM_PROVIDER=stub` builds no model client. OpenRouter model ids must end in `:free` unless `OPENROUTER_ALLOW_PAID=true` (default off); the evaluation runner enforces the same rule. Keys are never logged or shown; provider errors are redacted before storage.
