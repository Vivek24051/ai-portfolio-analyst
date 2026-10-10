// Admin authorization, conversation inspection, attention flags and execution traces.
// Storage: in-memory stores (MOCKED persistence — this does not prove PostgreSQL behaviour).
// Models: scripted fakes (no LLM, timings are not representative of OpenRouter).
import { AIMessage } from "@langchain/core/messages";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminCredentials, checkAdminAuth, parseBasicAuth, requireSameOrigin } from "@/server/admin/auth";
import { getConversationTrace, getOverview, listConversationsForAdmin, percentile, previewPayload, resolveAttention } from "@/server/admin/adminService";
import { RateLimiter } from "@/server/rateLimit";
import { handleChatTurn } from "@/server/services/chatService";
import { createSessionToken, SESSION_COOKIE } from "@/server/session";
import { chatDeps, freshStores, scriptedModel, text, toolCall } from "./agentHelpers";

const container = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/container", () => ({ getContainer: async () => container.current }));

const { proxy } = await import("@/proxy");
const { GET: overviewGET } = await import("@/app/api/admin/overview/route");
const { GET: listGET } = await import("@/app/api/admin/conversations/route");
const { GET: traceGET } = await import("@/app/api/admin/conversations/[id]/route");
const { POST: resolvePOST } = await import("@/app/admin/conversations/[id]/resolve/route");
const { POST: chatPOST } = await import("@/app/api/chat/route");

const PASSWORD = "correct-horse-battery";
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const GOOD = basic("admin", PASSWORD);
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

function setContainer(stores = freshStores()) {
  container.current = {
    stores,
    router: { primary: scriptedModel("p", [text("hi")]), fallback: null, callTimeoutMs: 2_000 },
    config: { historyLimit: 30, turnDeadlineMs: 5_000 },
    modelMode: "dev-stub",
    dataBackend: "memory",
    chatLimiter: new RateLimiter(50, 60_000),
  };
  return stores;
}

function req(url: string, init: { method?: string; auth?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers: Record<string, string> = { host: "localhost", "x-forwarded-for": "10.0.0.1", ...(init.headers ?? {}) };
  if (init.auth) headers.authorization = init.auth;
  return new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers, body: init.body });
}

const ctx = (id = "") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.stubEnv("ADMIN_USERNAME", "admin");
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  setContainer();
});
afterEach(() => vi.unstubAllEnvs());

/** Three conversations: a clean one, one with a fallback + tool error, one where both models fail. */
async function seedConversations() {
  const stores = setContainer();
  const ok = await handleChatTurn(
    chatDeps(stores, scriptedModel("primary", [toolCall("search_properties", { sortBy: "rent", limit: 1 }), text("P007 earns most.")])),
    { userId: "U003", message: "highest rent?", receivedAt: performance.now() },
  );
  const fallback = await handleChatTurn(
    chatDeps(
      stores,
      scriptedModel("primary", [new Error("429 rate limited key=sk-or-v1-SECRETSECRET")]),
      scriptedModel("fallback", [
        toolCall("search_properties", { filter: { assetClasses: ["Commercial"] } }),
        toolCall("flag_for_human", { reason: "advice_out_of_scope", note: "Asked for tax advice" }),
        text("A team member will follow up."),
      ]),
    ),
    { userId: "U001", message: "should I sell for tax reasons?" },
  );
  const failed = await handleChatTurn(
    chatDeps(stores, scriptedModel("primary", [new Error("503")]), scriptedModel("fallback", [new Error("503")])),
    { userId: "U002", message: "total value?" },
  );
  return { stores, ok, fallback, failed };
}

describe("admin auth primitives", () => {
  it("is disabled unless a strong password is configured (no dev fallback)", () => {
    expect(adminCredentials(env({}))).toBeNull();
    expect(adminCredentials(env({ ADMIN_PASSWORD: "short" }))).toBeNull();
    expect(adminCredentials(env({ ADMIN_PASSWORD: PASSWORD }))).toEqual({ username: "admin", password: PASSWORD });
    expect(checkAdminAuth(new Headers({ authorization: GOOD }), env({ NODE_ENV: "development" }))).toEqual({ ok: false, reason: "not_configured" });
  });

  it("parses Basic headers strictly (passwords may contain colons)", () => {
    expect(parseBasicAuth(basic("admin", "a:b:c"))).toEqual({ username: "admin", password: "a:b:c" });
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth("Basic !!!")).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`)).toBeNull();
    expect(parseBasicAuth(null)).toBeNull();
  });

  it("accepts only exact credentials", () => {
    const cfg = env({ ADMIN_PASSWORD: PASSWORD });
    const limiter = new RateLimiter(100, 60_000);
    expect(checkAdminAuth(new Headers({ authorization: GOOD }), cfg, limiter)).toEqual({ ok: true, username: "admin" });
    expect(checkAdminAuth(new Headers({ authorization: basic("admin", `${PASSWORD}x`) }), cfg, limiter).ok).toBe(false);
    expect(checkAdminAuth(new Headers({ authorization: basic("root", PASSWORD) }), cfg, limiter).ok).toBe(false);
    expect(checkAdminAuth(new Headers(), cfg, limiter)).toEqual({ ok: false, reason: "missing" });
  });

  it("locks out a client after repeated failures — even a correct password is refused during lockout", () => {
    const cfg = env({ ADMIN_PASSWORD: PASSWORD });
    const limiter = new RateLimiter(3, 60_000);
    const h = (auth: string) => new Headers({ authorization: auth, "x-forwarded-for": "203.0.113.9" });
    for (let i = 0; i < 3; i++) expect(checkAdminAuth(h(basic("admin", "wrong")), cfg, limiter).ok).toBe(false);
    expect(checkAdminAuth(h(GOOD), cfg, limiter)).toEqual({ ok: false, reason: "throttled" });
    // Another client is unaffected.
    expect(checkAdminAuth(new Headers({ authorization: GOOD, "x-forwarded-for": "198.51.100.1" }), cfg, limiter).ok).toBe(true);
  });

  it("CSRF guard requires a same-origin Origin/Referer", () => {
    const mk = (h: Record<string, string>) => new Request("http://localhost/x", { method: "POST", headers: { host: "localhost", ...h } });
    expect(() => requireSameOrigin(mk({ origin: "http://localhost" }))).not.toThrow();
    expect(() => requireSameOrigin(mk({ referer: "http://localhost/admin/conversations/C1" }))).not.toThrow();
    expect(() => requireSameOrigin(mk({ origin: "https://evil.example" }))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(mk({}))).toThrow(/Cross-origin/);
  });
});

describe("proxy (browser challenge layer)", () => {
  it("challenges unauthenticated admin requests with 401 + WWW-Authenticate", async () => {
    const res = proxy(req("/admin"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('Basic realm="Portfolio Admin"');
    expect(await res.text()).not.toContain(PASSWORD);
  });

  it("503 when admin is not configured; passes through with no-store when authenticated", () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect(proxy(req("/admin", { auth: GOOD })).status).toBe(503);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const ok = proxy(req("/admin/conversations", { auth: GOOD }));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});

describe("admin API endpoints enforce auth themselves (not only via the proxy)", () => {
  const endpoints: Array<[string, () => Promise<Response>]> = [
    ["overview", () => overviewGET(req("/api/admin/overview"))],
    ["list", () => listGET(req("/api/admin/conversations"))],
    ["trace", () => traceGET(req("/api/admin/conversations/C0001"), ctx("C0001"))],
    ["resolve", () => resolvePOST(req("/admin/conversations/C0001/resolve", { method: "POST", headers: { origin: "http://localhost" } }), ctx("C0001"))],
  ];

  it.each(endpoints)("%s → 401 without credentials", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("a chat session cookie does not grant admin access", async () => {
    const cookie = `${SESSION_COOKIE}=${await createSessionToken("U001")}`;
    expect((await overviewGET(req("/api/admin/overview", { headers: { cookie } }))).status).toBe(401);
  });

  it("admin credentials do not grant chat access (chat stays user-scoped)", async () => {
    const res = await chatPOST(req("/api/chat", { method: "POST", auth: GOOD, headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) }));
    expect(res.status).toBe(401);
  });

  it("returns data with valid credentials, never echoing secrets", async () => {
    await seedConversations();
    const res = await overviewGET(req("/api/admin/overview", { auth: GOOD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("SECRETSECRET");
  });
});

describe("conversation inspection and attention flags", () => {
  it("overview lists users, flagged conversations with reasons, and run metrics", async () => {
    const { stores } = await seedConversations();
    const o = await getOverview(stores);
    expect(o.users.map((u) => [u.id, u.conversations, u.flagged])).toEqual([
      ["U001", 1, 1],
      ["U002", 1, 1],
      ["U003", 1, 0],
      ["U004", 0, 0],
    ]);
    expect(o.attention.map((a) => [a.userId, a.reason.split(":")[0]!.split(" ")[0]]).sort()).toEqual([
      ["U001", "handoff"],
      ["U002", "model_unavailable"],
    ]);
    expect(o.metrics).toMatchObject({ runs: 3, errorRuns: 1, fallbackRuns: 1, runsWithTokenUsage: 0, runsWithCost: 0 });
    expect(o.metrics.latencyP50Ms).not.toBeNull(); // computed from the 2 OK runs that called a model
    expect(o.metrics.modelsSeen.sort()).toEqual(["fallback", "primary"]);
  });

  it("list filters by user and attention; flagged conversations sort first", async () => {
    const { stores } = await seedConversations();
    const all = await listConversationsForAdmin(stores);
    expect(all.slice(0, 2).every((r) => r.needsAttention)).toBe(true);
    expect((await listConversationsForAdmin(stores, { needsAttention: true })).map((r) => r.userId).sort()).toEqual(["U001", "U002"]);
    const u3 = await listConversationsForAdmin(stores, { userId: "U003" });
    expect(u3).toHaveLength(1);
    expect(u3[0]).toMatchObject({ messages: 4, runs: 1, errorRuns: 0, lastRunStatus: "OK", needsAttention: false });
  });

  it("resolve clears the flag, keeps the reason, records who/when; a later failure re-flags", async () => {
    const { stores, failed } = await seedConversations();
    const r = await resolvePOST(
      req(`/admin/conversations/${failed.conversationId}/resolve`, { method: "POST", auth: GOOD, headers: { origin: "http://localhost" } }),
      ctx(failed.conversationId),
    );
    expect(await r.json()).toEqual({ conversationId: failed.conversationId, resolved: true, alreadyClear: false });
    let c = (await stores.admin.getConversation(failed.conversationId))!;
    expect(c).toMatchObject({ needsAttention: false, attentionReason: "model_unavailable", attentionResolvedBy: "admin" });
    expect(c.attentionResolvedAt).toBeInstanceOf(Date);

    expect(await resolveAttention(stores, failed.conversationId, "admin")).toMatchObject({ resolved: false, alreadyClear: true });

    await handleChatTurn(chatDeps(stores, scriptedModel("p", [new Error("503")])), { userId: "U002", conversationId: failed.conversationId, message: "again?" });
    c = (await stores.admin.getConversation(failed.conversationId))!;
    expect(c).toMatchObject({ needsAttention: true, attentionReason: "model_unavailable", attentionResolvedAt: null, attentionResolvedBy: null });
  });

  it("resolve: cross-origin is rejected; HTML form post redirects back to the trace", async () => {
    const { failed } = await seedConversations();
    const id = failed.conversationId;
    const cross = await resolvePOST(req(`/admin/conversations/${id}/resolve`, { method: "POST", auth: GOOD, headers: { origin: "https://evil.example" } }), ctx(id));
    expect(cross.status).toBe(403);
    const form = await resolvePOST(
      req(`/admin/conversations/${id}/resolve`, {
        method: "POST",
        auth: GOOD,
        headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      ctx(id),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe(`http://localhost/admin/conversations/${id}`);
  });

  it("unknown conversation → 404", async () => {
    expect((await traceGET(req("/api/admin/conversations/C-nope", { auth: GOOD }), ctx("C-nope"))).status).toBe(404);
  });
});

describe("execution traces", () => {
  it("shows model calls (incl. failed primary + fallback), tool calls, spans and errors — redacted", async () => {
    const { stores, fallback } = await seedConversations();
    const trace = await getConversationTrace(stores, fallback.conversationId);
    expect(trace.conversation).toMatchObject({ userId: "U001", userName: "Rahul Mehta", needsAttention: true });
    expect(trace.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "TOOL", "ASSISTANT", "TOOL", "ASSISTANT"]);

    const [run] = trace.runs;
    expect(run).toMatchObject({ status: "OK", model: "fallback", fallbackUsed: true, toolRounds: 2 });
    expect(run!.llmCalls.map((c) => [c.model, c.ok, c.isFallback])).toEqual([
      ["primary", false, false],
      ["fallback", true, true],
      ["fallback", true, true],
      ["fallback", true, true],
    ]);
    expect(run!.llmCalls[0]!.error).toContain("429");
    expect(run!.llmCalls[0]!.error).not.toContain("SECRETSECRET"); // redacted before storage
    expect(run!.toolCalls.map((t) => [t.position, t.name, t.ok, t.error])).toEqual([
      [0, "search_properties", false, "invalid_arguments"],
      [1, "flag_for_human", true, null],
    ]);
    expect(run!.toolCalls[0]!.argsPreview).toContain("Commercial");
    expect(run!.spans.map((s) => s.name)).toEqual(["context_load", "agent", "persist"]);
    // Missing ≠ zero: the scripted provider reported no usage, so totals are unknown.
    expect(run).toMatchObject({ promptTokens: null, completionTokens: null, costUsd: null });
  });

  it("request_validation span is recorded when the route supplies the receipt time", async () => {
    const { stores, ok } = await seedConversations();
    const trace = await getConversationTrace(stores, ok.conversationId);
    expect(trace.runs[0]!.spans.map((s) => s.name)).toEqual(["request_validation", "context_load", "agent", "persist"]);
  });

  it("errored runs carry the error; model-free (button) runs show zero model calls", async () => {
    const { stores, failed } = await seedConversations();
    const t = await getConversationTrace(stores, failed.conversationId);
    expect(t.runs[0]).toMatchObject({ status: "ERROR", model: null });
    expect(t.runs[0]!.error).toMatch(/All models failed/);
  });

  it("payload previews are redacted and size-capped", () => {
    const big = { note: "x".repeat(5000), key: "sk-or-v1-abcdefghijklmnop", conn: "postgresql://u:p@h/db" };
    const p = previewPayload(big);
    expect(p.length).toBeLessThanOrEqual(1500);
    expect(p).not.toContain("sk-or-v1-abcdefghijklmnop");
    expect(previewPayload({ conn: "postgresql://u:p@h/db" })).not.toContain("u:p@h");
  });

  it("percentile uses nearest-rank and returns null for no data", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([300, 100, 200], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 95)).toBe(400);
  });
});

describe("token usage is recorded only when the provider reports it", () => {
  it("records reported tokens and keeps reported zeros as zero", async () => {
    const stores = freshStores();
    const withUsage = (content: string, input: number, output: number) =>
      new AIMessage({ content, usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } });
    await handleChatTurn(chatDeps(stores, scriptedModel("p", [withUsage("hello", 120, 0)])), { userId: "U001", message: "hi" });
    expect(stores.state.runs[0]!.run).toMatchObject({ promptTokens: 120, completionTokens: 0, costUsd: null });
  });
});
