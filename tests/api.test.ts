// API route handlers with a MOCKED container (in-memory stores + scripted model).
// Exercises cookie auth, input validation, and that identity never comes from the body.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "@/server/rateLimit";
import { createSessionToken, SESSION_COOKIE } from "@/server/session";
import { freshStores, scriptedModel, text, toolCall } from "./agentHelpers";

const container = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/container", () => ({ getContainer: async () => container.current }));

const { POST: chatPOST } = await import("@/app/api/chat/route");
const { POST: actionPOST } = await import("@/app/api/chat/actions/route");
const { POST: sessionPOST, GET: sessionGET } = await import("@/app/api/session/route");

function setup(steps: Parameters<typeof scriptedModel>[1] = [text("ok")], limit = 20) {
  const stores = freshStores();
  const model = scriptedModel("primary", steps);
  container.current = {
    stores,
    router: { primary: model, fallback: null, callTimeoutMs: 2_000 },
    config: { historyLimit: 30, turnDeadlineMs: 5_000 },
    modelMode: "dev-stub",
    dataBackend: "memory",
    chatLimiter: new RateLimiter(limit, 60_000),
  };
  return { stores, model };
}

async function req(url: string, body: unknown, userId?: string, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers.cookie = `${SESSION_COOKIE}=${await createSessionToken(userId)}`;
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

beforeEach(() => setup());

describe("POST /api/chat", () => {
  it("401 without a session cookie", async () => {
    const res = await chatPOST(await req("/api/chat", { message: "hi" }));
    expect(res.status).toBe(401);
  });

  it("401 with a tampered cookie", async () => {
    const r = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMDAyIn0.forged` },
      body: JSON.stringify({ message: "hi" }),
    });
    expect((await chatPOST(r)).status).toBe(401);
  });

  it("400 for empty, oversized, non-JSON, or extra fields (userId in body is rejected)", async () => {
    expect((await chatPOST(await req("/api/chat", { message: "   " }, "U001"))).status).toBe(400);
    expect((await chatPOST(await req("/api/chat", { message: "x".repeat(2001) }, "U001"))).status).toBe(400);
    expect((await chatPOST(await req("/api/chat", null, "U001", "{not json"))).status).toBe(400);
    const smuggled = await chatPOST(await req("/api/chat", { message: "hi", userId: "U002" }, "U001"));
    expect(smuggled.status).toBe(400);
    expect((await smuggled.json()).error.message).toMatch(/Unrecognized key/i);
  });

  it("200 happy path: identity comes from the cookie", async () => {
    const { stores } = setup([toolCall("portfolio_analytics", { sections: ["totals"] }), text("Your portfolio is ₹48.7 Cr.")]);
    const res = await chatPOST(await req("/api/chat", { message: "What is my total portfolio value?" }, "U003"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", reply: "Your portfolio is ₹48.7 Cr.", modelMode: "dev-stub" });
    expect(stores.state.conversations[0]!.userId).toBe("U003");
  });

  it("404 when continuing someone else's conversation", async () => {
    setup([text("hi"), text("never")]);
    const first = await (await chatPOST(await req("/api/chat", { message: "hi" }, "U001"))).json();
    const res = await chatPOST(await req("/api/chat", { conversationId: first.conversationId, message: "hi" }, "U002"));
    expect(res.status).toBe(404);
  });

  it("model outage still returns 200 with a safe reply (not a 500)", async () => {
    setup([new Error("503 upstream")]);
    const res = await chatPOST(await req("/api/chat", { message: "hi" }, "U001"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("error");
  });

  it("429 when the per-user rate limit is exceeded", async () => {
    setup([text("1"), text("2")], 1);
    expect((await chatPOST(await req("/api/chat", { message: "a" }, "U001"))).status).toBe(200);
    expect((await chatPOST(await req("/api/chat", { message: "b" }, "U001"))).status).toBe(429);
  });
});

describe("POST /api/chat/actions", () => {
  it("validates the decision and confirms only for the owner", async () => {
    const { stores } = setup([
      toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 14, unit: "CRORE" } } }),
      text("Confirm?"),
    ]);
    const turn = await (await chatPOST(await req("/api/chat", { message: "Update Bandra to ₹14 Cr" }, "U001"))).json();
    const payload = { conversationId: turn.conversationId, pendingActionId: turn.pendingAction.id, decision: "confirm" };

    expect((await actionPOST(await req("/api/chat/actions", { ...payload, decision: "yolo" }, "U001"))).status).toBe(400);
    expect((await actionPOST(await req("/api/chat/actions", payload, "U002"))).status).toBe(404);
    const ok = await actionPOST(await req("/api/chat/actions", payload, "U001"));
    expect(ok.status).toBe(200);
    expect(stores.state.properties.find((p) => p.id === "P001")!.currentValueInr).toBe(140_000_000);
  });
});

describe("/api/session", () => {
  it("sets an HTTP-only cookie for a real user and rejects unknown users", async () => {
    expect((await sessionPOST(await req("/api/session", { userId: "U999" }))).status).toBe(404);
    const res = await sessionPOST(await req("/api/session", { userId: "U002" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("GET lists demo users and the current one", async () => {
    const r = new NextRequest("http://localhost/api/session", {
      headers: { cookie: `${SESSION_COOKIE}=${await createSessionToken("U004")}` },
    });
    const body = await (await sessionGET(r)).json();
    expect(body.currentUserId).toBe("U004");
    expect(body.users.map((u: { id: string }) => u.id)).toEqual(["U001", "U002", "U003", "U004"]);
  });
});
