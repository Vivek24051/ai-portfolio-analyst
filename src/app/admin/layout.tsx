import type { Metadata } from "next";
import Link from "next/link";
import { getContainer } from "@/server/container";
import { requireAdminPage } from "@/server/admin/page";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ops dashboard · Portfolio Analyst", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();
  const c = await getContainer();
  return (
    <div className="admin">
      <header className="admin-head">
        <strong>Portfolio Analyst · Operations</strong>
        <nav>
          <Link href="/admin">Overview</Link>
          <Link href="/admin/conversations">Conversations</Link>
          <Link href="/admin/conversations?attention=1">Needs attention</Link>
        </nav>
        <span className="env">
          <span className={`badge ${c.modelMode !== "dev-stub" ? "ok" : "warn"}`}>model: {c.modelMode}</span>{" "}
          <span className={`badge ${c.dataBackend === "prisma" ? "ok" : "warn"}`}>data: {c.dataBackend}</span>{" "}
          <span className="muted">signed in as {admin}</span>
        </span>
      </header>
      {c.dataBackend === "memory" && (
        <p className="notice">
          In-memory data: everything here lives in this server process only and resets on restart. It does not show
          PostgreSQL persistence.
        </p>
      )}
      {c.modelMode === "dev-stub" && (
        <p className="notice">
          Dev stub model: runs and timings below come from a keyword stub, not an LLM. They are not representative of real
          OpenRouter latency, token usage or cost.
        </p>
      )}
      <main className="admin-main">{children}</main>
    </div>
  );
}
