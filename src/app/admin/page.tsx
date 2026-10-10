import Link from "next/link";
import { getContainer } from "@/server/container";
import { getOverview } from "@/server/admin/adminService";
import { requireAdminPage } from "@/server/admin/page";
import { ms, num, when } from "./format";

export const dynamic = "force-dynamic";

export default async function AdminOverview() {
  await requireAdminPage();
  const c = await getContainer();
  const { users, attention, metrics, sampledRuns } = await getOverview(c.stores);

  return (
    <>
      <section>
        <h2>
          Needs attention <span className="count">{attention.length}</span>
        </h2>
        {attention.length === 0 ? (
          <p className="muted">No flagged conversations.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Conversation</th>
                <th>User</th>
                <th>Why</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((a) => (
                <tr key={a.conversationId} className="flagged">
                  <td>
                    <Link href={`/admin/conversations/${a.conversationId}`}>{a.conversationId}</Link>
                  </td>
                  <td>
                    {a.userName} <span className="muted">({a.userId})</span>
                  </td>
                  <td className="reason">{a.reason}</td>
                  <td>{when(a.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Agent runs</h2>
        <p className="muted small">
          Computed from the {sampledRuns} most recent runs recorded in this store. Latency is end-to-end server time per turn
          (successful turns with at least one model call). &ldquo;—&rdquo; means no data, not zero.
        </p>
        <div className="cards">
          <div className="card">
            <span className="label">Runs</span>
            <strong>{metrics.runs}</strong>
          </div>
          <div className="card">
            <span className="label">Errors</span>
            <strong className={metrics.errorRuns ? "err-text" : ""}>{metrics.errorRuns}</strong>
          </div>
          <div className="card">
            <span className="label">Fallback used</span>
            <strong>{metrics.fallbackRuns}</strong>
          </div>
          <div className="card">
            <span className="label">p50 latency</span>
            <strong>{ms(metrics.latencyP50Ms)}</strong>
          </div>
          <div className="card">
            <span className="label">p95 latency</span>
            <strong>{ms(metrics.latencyP95Ms)}</strong>
          </div>
          <div className="card">
            <span className="label">Runs with token usage</span>
            <strong>
              {metrics.runsWithTokenUsage} / {metrics.runs}
            </strong>
          </div>
          <div className="card">
            <span className="label">Runs with cost</span>
            <strong>
              {metrics.runsWithCost} / {metrics.runs}
            </strong>
          </div>
          <div className="card">
            <span className="label">Models seen</span>
            <strong className="small">{metrics.modelsSeen.length ? metrics.modelsSeen.join(", ") : "—"}</strong>
          </div>
        </div>
      </section>

      <section>
        <h2>Users</h2>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>City</th>
              <th>Conversations</th>
              <th>Flagged</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/admin/conversations?user=${u.id}`}>{u.name}</Link> <span className="muted">({u.id})</span>
                </td>
                <td>{u.city}</td>
                <td>{num(u.conversations)}</td>
                <td className={u.flagged ? "err-text" : ""}>{u.flagged}</td>
                <td>{when(u.lastActivity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
