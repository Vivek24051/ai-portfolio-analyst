import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { checkAdminAuth } from "./auth";

/**
 * Called at the top of EVERY admin page (not just the layout, which may not re-run on client
 * navigation). The proxy normally answers unauthenticated requests with a 401 challenge first;
 * this is the authoritative check, and on failure the page renders a 404 with no data.
 */
export async function requireAdminPage(): Promise<string> {
  const result = checkAdminAuth(await headers());
  if (!result.ok) notFound();
  return result.username;
}
