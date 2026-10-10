// Admin pages rendered on the server (react-dom/server) with MOCKED request headers and an
// in-memory container. Verifies page-level authorization (defense in depth behind the proxy)
// and that the trace page shows "—" — not 0 — for metrics the provider did not report.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "@/server/rateLimit";
import { handleChatTurn } from "@/server/services/chatService";
import { chatDeps, freshStores, scriptedModel, text, toolCall } from "./agentHelpers";

const state = vi.hoisted(() => ({ container: null as unknown, auth: null as string | null }));
vi.mock("@/server/container", () => ({ getContainer: async () => state.container }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.auth ? { authorization: state.auth, "x-forwarded-for": "10.9.9.9" } : {}),
}));

const { default: AdminOverview } = await import("@/app/admin/page");
const { default: AdminConversations } = await import("@/app/admin/conversations/page");
const { default: AdminConversation } = await import("@/app/admin/conversations/[id]/page");

const PASSWORD = "correct-horse-battery";
const GOOD = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;

async function seed() {
  const stores = freshStores();
  state.container = {
    stores,
    router: { primary: scriptedModel("p", []), fallback: null, callTimeoutMs: 1000 },
    config: { historyLimit: 30, turnDeadlineMs: 5000 },
    modelMode: "dev-stub",
    dataBackend: "memory",
    chatLimiter: new RateLimiter(50, 60_000),
  };
  const ok = await handleChatTurn(
    chatDeps(stores, scriptedModel("primary", [toolCall("search_properties", { sortBy: "rent", limit: 1 }), text("P007 <b>earns</b> most.")])),
    { userId: "U003", message: "highest rent?" },
  );
  const bad = await handleChatTurn(chatDeps(stores, scriptedModel("primary", [new Error("503 upstream")])), { userId: "U002", message: "total?" });
  return { ok, bad };
}

const is404 = (e: unknown) => String((e as { digest?: string }).digest ?? "").includes("404");

beforeEach(() => {
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  state.auth = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("admin pages: authorization inside the page", () => {
  it("every page refuses (404, no data) without credentials, even if the proxy were bypassed", async () => {
    const { ok } = await seed();
    for (const render of [
      () => AdminOverview(),
      () => AdminConversations({ searchParams: Promise.resolve({}) }),
      () => AdminConversation({ params: Promise.resolve({ id: ok.conversationId }) }),
    ]) {
      const err = await render().then(() => null, (e: unknown) => e);
      expect(is404(err)).toBe(true);
    }
  });

  it("wrong password is also refused", async () => {
    await seed();
    state.auth = `Basic ${Buffer.from("admin:nope-nope-nope").toString("base64")}`;
    expect(is404(await AdminOverview().then(() => null, (e: unknown) => e))).toBe(true);
  });
});

describe("admin pages: content", () => {
  it("overview shows the attention queue with the reason, users and run counts", async () => {
    const { bad } = await seed();
    state.auth = GOOD;
    const html = renderToStaticMarkup(await AdminOverview());
    expect(html).toContain("Needs attention");
    expect(html).toContain(bad.conversationId);
    expect(html).toContain("model_unavailable");
    expect(html).toContain("Arjun Kapoor");
    expect(html).not.toContain(PASSWORD);
  });

  it("conversation list filters to flagged conversations", async () => {
    const { ok, bad } = await seed();
    state.auth = GOOD;
    const html = renderToStaticMarkup(await AdminConversations({ searchParams: Promise.resolve({ attention: "1" }) }));
    expect(html).toContain(bad.conversationId);
    expect(html).not.toContain(`>${ok.conversationId}<`);
  });

  it("trace page shows model/tool calls, escapes content, and renders unreported tokens as — (not 0)", async () => {
    const { ok } = await seed();
    state.auth = GOOD;
    const html = renderToStaticMarkup(await AdminConversation({ params: Promise.resolve({ id: ok.conversationId }) }));
    expect(html).toContain("search_properties");
    expect(html).toContain("Model calls (2)");
    expect(html).toContain("Tool calls (1)");
    expect(html).toContain("&lt;b&gt;earns&lt;/b&gt;"); // model text is escaped, not rendered as HTML
    expect(html).toMatch(/<dt>Prompt tokens<\/dt><dd><span class="na" title="not reported by provider">—<\/span><\/dd>/);
    expect(html).toContain("Not flagged.");
  });

  it("unknown conversation id renders 404", async () => {
    await seed();
    state.auth = GOOD;
    expect(is404(await AdminConversation({ params: Promise.resolve({ id: "C-missing" }) }).then(() => null, (e: unknown) => e))).toBe(true);
  });
});
