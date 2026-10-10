import Link from "next/link";
import { notFound } from "next/navigation";
import { HttpError } from "@/server/errors";
import { getContainer } from "@/server/container";
import { getConversationTrace, type ConversationTrace, type TraceRun } from "@/server/admin/adminService";
import { requireAdminPage } from "@/server/admin/page";
import { ms, NA, num, StatusBadge, usd, when } from "../../format";

export const dynamic = "force-dynamic";

const SPAN_LABELS: Record<string, string> = {
  request_validation: "request (auth + validation)",
  context_load: "context load",
  agent: "agent (model + tools)",
  persist: "persist",
};

function SpanBar({ run }: { run: TraceRun }) {
  if (run.spans.length === 0 || run.totalMs <= 0) return null;
  return (
    <div className="spanbar" aria-label="Where time went">
      {run.spans.map((s, i) => (
        <span key={i} className={`seg seg-${i % 4}`} style={{ width: `${Math.max(1, (s.ms / run.totalMs) * 100)}%` }} title={`${SPAN_LABELS[s.name] ?? s.name}: ${s.ms} ms`}>
          {s.ms / run.totalMs > 0.12 ? `${SPAN_LABELS[s.name] ?? s.name} ${s.ms} ms` : ""}
        </span>
      ))}
    </div>
  );
}

function RunDetails({ run, index }: { run: TraceRun; index: number }) {
  return (
    <details className={`run ${run.status === "ERROR" ? "run-error" : ""}`} open={run.status === "ERROR" || index === 0}>
      <summary>
        <StatusBadge status={run.status} /> <strong>{when(run.startedAt)}</strong> · {run.model ?? "no model call"}
        {run.fallbackUsed && <span className="badge warn">fallback</span>} · total {ms(run.totalMs)} · LLM {ms(run.llmMs)} · tools{" "}
        {ms(run.toolMs)} · rounds {run.toolRounds ?? <NA />}
      </summary>
      {run.error && <pre className="error-box">{run.error}</pre>}
      <SpanBar run={run} />
      <dl className="kv">
        <dt>Prompt tokens</dt>
        <dd>{num(run.promptTokens)}</dd>
        <dt>Completion tokens</dt>
        <dd>{num(run.completionTokens)}</dd>
        <dt>Cost</dt>
        <dd>{usd(run.costUsd)}</dd>
        <dt>Numeric faithfulness</dt>
        <dd>
          {run.faithfulness === null ? (
            <NA why="not checked (error turn)" />
          ) : run.faithfulness.unsupported.length === 0 ? (
            <span className="badge ok">{run.faithfulness.checked} figures, all traced to tool output</span>
          ) : (
            <span className="badge err">unsupported: {run.faithfulness.unsupported.join(", ")}</span>
          )}
        </dd>
        <dt>Run id</dt>
        <dd className="mono">{run.id}</dd>
      </dl>

      <h4>Model calls ({run.llmCalls.length})</h4>
      {run.llmCalls.length === 0 ? (
        <p className="muted small">None (e.g. Confirm-button path, which does not call the LLM).</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Model</th>
              <th>Outcome</th>
              <th>Duration</th>
              <th>First token</th>
              <th>Tools bound</th>
              <th>Tokens in / out</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {run.llmCalls.map((c, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  {c.model} {c.isFallback && <span className="badge warn">fallback</span>}
                </td>
                <td>{c.ok ? <span className="badge ok">ok</span> : <span className="badge err" title={c.error ?? ""}>{c.error ?? "error"}</span>}</td>
                <td>{ms(c.ms)}</td>
                <td>{c.streamed ? ms(c.ttftMs) : <NA why="not streamed" />}</td>
                <td>{c.withTools ? "yes" : "no"}</td>
                <td>
                  {num(c.promptTokens)} / {num(c.completionTokens)}
                </td>
                <td>{usd(c.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Tool calls ({run.toolCalls.length})</h4>
      {run.toolCalls.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Tool</th>
              <th>Outcome</th>
              <th>Duration</th>
              <th>Arguments / result (preview, redacted)</th>
            </tr>
          </thead>
          <tbody>
            {run.toolCalls.map((t) => (
              <tr key={t.position} className={t.ok ? "" : "flagged"}>
                <td>{t.position + 1}</td>
                <td className="mono">{t.name}</td>
                <td>{t.ok ? <span className="badge ok">ok</span> : <span className="badge err">{t.error ?? "error"}</span>}</td>
                <td>{ms(t.durationMs)}</td>
                <td>
                  <details>
                    <summary>args</summary>
                    <pre>{t.argsPreview}</pre>
                  </details>
                  <details>
                    <summary>result</summary>
                    <pre>{t.resultPreview}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function Transcript({ messages }: { messages: ConversationTrace["messages"] }) {
  return (
    <ol className="transcript">
      {messages.map((m) => (
        <li key={m.id} className={`tm tm-${m.role.toLowerCase()}`}>
          <span className="who">{m.role === "TOOL" ? `tool · ${m.toolName}` : m.role.toLowerCase()}</span>
          <span className="muted small"> {when(m.createdAt)}</span>
          {m.toolCalls.length > 0 && (
            <div className="calls">
              {m.toolCalls.map((t, i) => (
                <details key={i}>
                  <summary>
                    → calls <span className="mono">{t.name}</span>
                  </summary>
                  <pre>{t.argsPreview}</pre>
                </details>
              ))}
            </div>
          )}
          {m.role === "TOOL" ? (
            <details>
              <summary>result (preview)</summary>
              <pre>{m.text}</pre>
            </details>
          ) : (
            m.text && <p className="text">{m.text}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

export default async function AdminConversation({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  if (!id || id.length > 64) notFound();
  const c = await getContainer();
  let trace: ConversationTrace;
  try {
    trace = await getConversationTrace(c.stores, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const conv = trace.conversation;

  return (
    <>
      <p>
        <Link href="/admin/conversations">← Conversations</Link>
      </p>
      <section className={conv.needsAttention ? "attention-panel flagged" : "attention-panel"}>
        <h2>
          {conv.id} <span className="muted">· {conv.userName} ({conv.userId})</span>
        </h2>
        <p className="muted small">
          Started {when(conv.createdAt)} · last activity {when(conv.lastMessageAt)}
        </p>
        {conv.needsAttention ? (
          <div className="attention">
            <p>
              <span className="badge err">Needs attention</span> <strong>{conv.attentionReason ?? "(no reason recorded)"}</strong>
            </p>
            <form method="post" action={`/admin/conversations/${encodeURIComponent(conv.id)}/resolve`}>
              <button type="submit" className="btn">
                Mark as resolved
              </button>
            </form>
          </div>
        ) : conv.attentionResolvedAt ? (
          <p className="muted">
            Previously flagged: “{conv.attentionReason}” — resolved by {conv.attentionResolvedBy} at {when(conv.attentionResolvedAt)}
          </p>
        ) : (
          <p className="muted">Not flagged.</p>
        )}
        <dl className="kv">
          <dt>Focus properties</dt>
          <dd>{conv.state.focusPropertyIds.join(", ") || <NA why="none" />}</dd>
          <dt>Active scenario</dt>
          <dd>{conv.state.activeScenario ? <span className="badge warn">hypothetical active</span> : <NA why="none" />}</dd>
          <dt>Consecutive failed turns</dt>
          <dd>{conv.state.consecutiveFailures}</dd>
          <dt>Open proposals</dt>
          <dd>
            {trace.pendingActions.length === 0 ? (
              <NA why="none" />
            ) : (
              trace.pendingActions.map((a) => (
                <span key={a.id}>
                  {a.type} {a.propertyId ?? ""}: {a.diff.map((d) => `${d.label} ${d.before ?? ""}→${d.after}`).join("; ")} (expires {when(a.expiresAt)})
                </span>
              ))
            )}
          </dd>
        </dl>
      </section>

      <div className="split">
        <section>
          <h3>Transcript ({trace.messages.length} messages)</h3>
          <Transcript messages={trace.messages} />
        </section>
        <section>
          <h3>Execution trace ({trace.runs.length} runs, newest first)</h3>
          {trace.runs.length === 0 ? <p className="muted">No runs recorded.</p> : trace.runs.map((r, i) => <RunDetails key={r.id} run={r} index={i} />)}
        </section>
      </div>
    </>
  );
}
