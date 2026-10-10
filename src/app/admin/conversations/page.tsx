import Link from "next/link";
import { getContainer } from "@/server/container";
import { listConversationsForAdmin } from "@/server/admin/adminService";
import { requireAdminPage } from "@/server/admin/page";
import { StatusBadge, when } from "../format";

export const dynamic = "force-dynamic";

export default async function AdminConversations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const userId = sp.user && /^[A-Za-z0-9_-]{1,32}$/.test(sp.user) ? sp.user : undefined;
  const needsAttention = sp.attention === "1" ? true : undefined;
  const c = await getContainer();
  const [rows, users] = await Promise.all([listConversationsForAdmin(c.stores, { userId, needsAttention }), c.stores.users.list()]);

  const link = (q: Record<string, string | undefined>) => {
    const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
    const s = params.toString();
    return `/admin/conversations${s ? `?${s}` : ""}`;
  };

  return (
    <section>
      <h2>
        Conversations <span className="count">{rows.length}</span>
      </h2>
      <div className="filters">
        <Link className={!needsAttention ? "active" : ""} href={link({ user: userId })}>
          All
        </Link>
        <Link className={needsAttention ? "active" : ""} href={link({ user: userId, attention: "1" })}>
          Needs attention
        </Link>
        <span className="sep">|</span>
        <Link className={!userId ? "active" : ""} href={link({ attention: needsAttention ? "1" : undefined })}>
          All users
        </Link>
        {users.map((u) => (
          <Link key={u.id} className={userId === u.id ? "active" : ""} href={link({ user: u.id, attention: needsAttention ? "1" : undefined })}>
            {u.name}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="muted">No conversations match.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Conversation</th>
              <th>User</th>
              <th>Messages</th>
              <th>Runs</th>
              <th>Errors</th>
              <th>Last run</th>
              <th>Attention</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.needsAttention ? "flagged" : ""}>
                <td>
                  <Link href={`/admin/conversations/${r.id}`}>{r.id}</Link>
                </td>
                <td>
                  {r.userName} <span className="muted">({r.userId})</span>
                </td>
                <td>{r.messages}</td>
                <td>{r.runs}</td>
                <td className={r.errorRuns ? "err-text" : ""}>{r.errorRuns}</td>
                <td>
                  <StatusBadge status={r.lastRunStatus} />
                </td>
                <td className="reason">
                  {r.needsAttention ? (
                    <>
                      <span className="badge err">flagged</span> {r.attentionReason}
                    </>
                  ) : r.attentionResolvedAt ? (
                    <span className="muted">resolved {when(r.attentionResolvedAt)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{when(r.lastMessageAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
