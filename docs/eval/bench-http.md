# HTTP benchmark (local production build, dev stub)

> **Conditions:** `next start` on the same machine, loopback HTTP. Model mode reported by the server: **dev-stub**; data backend: **memory**.
> With the dev stub there is **no LLM**: these numbers are our HTTP + auth + validation + agent pipeline + persistence + SSE overhead only. They are **not** real-model latency and **not** internet latency.

| | |
|---|---|
| Date | 2026-10-10T09:08:46.783Z |
| Server | http://localhost:3123 |
| Machine | AMD Ryzen 7 4800HS with Radeon Graphics ×16 · win32 10.0.26200 · Node 20.20.2 (client and server on the same machine) |
| Workload | 4 prompts × 25 iterations per endpoint, sequential, after 1 warm-up pass |

| Measure (ms) | n | p50 | p95 | max |
|---|---|---|---|---|
| JSON /api/chat — client total | 100 | 9.6 | 12.5 | 17.1 |
| JSON /api/chat — server totalMs | 100 | 6.0 | 8.0 | 11.0 |
| SSE /api/chat/stream — response headers | 100 | 3.4 | 5.1 | 8.9 |
| SSE /api/chat/stream — first event | 100 | 10.3 | 13.6 | 20.8 |
| SSE /api/chat/stream — first answer token | 100 | 10.3 | 13.6 | 20.8 |
| SSE /api/chat/stream — done | 100 | 10.3 | 13.6 | 21.0 |
| SSE /api/chat/stream — server totalMs | 100 | 7.0 | 10.0 | 15.0 |
