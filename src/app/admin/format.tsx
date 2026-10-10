// Display helpers for the admin pages. `null` always renders as "—" (not reported / unknown),
// so a missing metric can never be mistaken for a measured zero.

export function NA({ why = "not reported" }: { why?: string }) {
  return (
    <span className="na" title={why}>
      —
    </span>
  );
}

export const ms = (v: number | null | undefined) => (v === null || v === undefined ? <NA why="not recorded" /> : `${v.toLocaleString("en-IN")} ms`);
export const num = (v: number | null | undefined, why = "not reported by provider") =>
  v === null || v === undefined ? <NA why={why} /> : v.toLocaleString("en-IN");
export const usd = (v: number | null | undefined) => (v === null || v === undefined ? <NA why="not reported by provider" /> : `$${v.toFixed(6)}`);
export const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : <NA why="never" />);

export function StatusBadge({ status }: { status: "OK" | "ERROR" | null }) {
  if (!status) return <NA why="no runs" />;
  return <span className={`badge ${status === "OK" ? "ok" : "err"}`}>{status}</span>;
}
