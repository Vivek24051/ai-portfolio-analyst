// Streaming route, conversation read APIs and stream events — MOCKED container (in-memory
// stores + scripted models). No network, no LLM.
import { AIMessage } from "@langchain/core/messages";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "@/agent/events";
import type { ChatModel } from "@/agent/model";
import { SseParser } from "@/lib/sse";
import { RateLimiter } from "@/server/rateLimit";
import { handleChatTurn } from "@/server/services/chatService";
import { createSessionToken, SESSION_COOKIE } from "@/server/session";
import { chatDeps, freshStores, scriptedModel, text, toolCall } from "./agentHelpers";

const container = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/container", () => ({ getContainer: async () => container.current }));

const { POST: streamPOST } = await import("@/app/api/chat/stream/route");
const { GET: listGET } = await import("@/app/api/conversations/route");
const { GET: viewGET } = await import("@/app/api/conversations/[id]/route");

/** A scripted model that also "streams" its text content word by word. */
function streamingModel(id: string, steps: AIMessage[]): ChatModel & { calls: number } {
  const m = {
    id,
    calls: 0,
    async invoke() {
      throw new Error("invoke should not be used when streaming is available");
    },
    async stream(_msgs: unknown, _opts: unknown, onDelta: (t: string) => void) {
      const step = steps[m.calls++];
      if (!step) throw new Error("script exhausted");
      for (const w of String(step.content).match(/\S+\s*/g) ?? []) onDelta(w);
      return step;
    },
  };
  return m;
}

function setup(primary: ChatModel, fallback: ChatModel | null = null) {
  const stores = freshStores();
  container.current = {
    stores,
    router: { primary, fallback, callTimeoutMs: 2_000 },
    config: { historyLimit: 30, turnDeadlineMs: 5_000 },
    modelMode: "dev-stub",
    dataBackend: "memory",
    chatLimiter: new RateLimiter(50, 60_000),
  };
  return stores;
}

async function cookie(userId: string) {
  return `${SESSION_COOKIE}=${await createSessionToken(userId)}`;
}

async function post(body: unknown, userId?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers.cookie = await cookie(userId);
  return streamPOST(new NextRequest("http://localhost/api/chat/stream", { method: "POST", headers, body: JSON.stringify(body) }));
}

async function readEvents(res: Response): Promise<ChatStreamEvent[]> {
  const parser = new SseParser();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: ChatStreamEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    events.push(...parser.push(decoder.decode(value, { stream: true })));
  }
  return events;
}

async function get(handler: (req: NextRequest, ctx: any) => Promise<Response>, url: string, userId: string, params?: object) {
  const req = new NextRequest(`http://localhost${url}`, { headers: { cookie: await cookie(userId) } });
  return handler(req, { params: Promise.resolve(params ?? {}) });
}

beforeEach(() => setup(scriptedModel("p", [text("hi")])));

describe("POST /api/chat/stream", () => {
  it("rejects before streaming: 401 / 400 / 404 are plain JSON errors", async () => {
    expect((await post({ message: "hi" })).status).toBe(401);
    expect((await post({ message: "" }, "U001")).status).toBe(400);
    expect((await post({ message: "hi", userId: "U002" }, "U001")).status).toBe(400);
    const notMine = await post({ message: "hi", conversationId: "C-does-not-exist" }, "U001");
    expect(notMine.status).toBe(404);
    expect(notMine.headers.get("content-type")).toContain("application/json");
  });

  it("streams start → status → tool_start/tool_end → deltas → done, with safe tool summaries", async () => {
    setup(
      streamingModel("p", [
        toolCall("search_properties", { sortBy: "rent", limit: 1 }),
        new AIMessage("P007 earns the most: ₹1.68 Cr a year."),
      ]),
    );
    const res = await post({ message: "Which property gives me the highest annual rent?" }, "U003");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("done");
    expect(types).toContain("tool_start");
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toEqual({ type: "tool_end", callId: expect.any(String), name: "search_properties", ok: true, summary: "3 matches" });
    const streamed = events.filter((e): e is Extract<ChatStreamEvent, { type: "delta" }> => e.type === "delta").map((e) => e.text).join("");
    expect(streamed).toBe("P007 earns the most: ₹1.68 Cr a year.");
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.result.reply).toBe("P007 earns the most: ₹1.68 Cr a year.");
    expect(done.result.toolActivity).toEqual([{ name: "search_properties", label: "Looking up your properties", ok: true, summary: "3 matches" }]);
    // No raw tool payloads in the stream
    expect(JSON.stringify(events)).not.toContain('"excludedFromRanking"');
  });

  it("model outage arrives as a done event with status error (not a broken stream)", async () => {
    setup(scriptedModel("p", [new Error("503")]));
    const events = await readEvents(await post({ message: "hi" }, "U001"));
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.result.status).toBe("error");
  });

  it("client disconnect does not abort the turn — it is still persisted", async () => {
    const stores = setup(streamingModel("p", [new AIMessage("A fairly long answer that keeps streaming for a while.")]));
    const res = await post({ message: "hi" }, "U001");
    await res.body!.cancel(); // user closes the tab immediately
    await vi.waitFor(() => expect(stores.state.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]), { timeout: 2_000 });
    expect(stores.state.runs).toHaveLength(1);
  });
});

describe("stream events at the service level", () => {
  it("fallback after a partially streamed primary emits reset before the fallback's text", async () => {
    const primary: ChatModel = {
      id: "p",
      invoke: async () => {
        throw new Error("unused");
      },
      async stream(_m, _o, onDelta) {
        onDelta("Half an ans");
        throw new Error("connection reset");
      },
    };
    const fallback = streamingModel("f", [new AIMessage("Complete answer.")]);
    const events: ChatStreamEvent[] = [];
    const r = await handleChatTurn(chatDeps(freshStores(), primary, fallback), { userId: "U001", message: "hi" }, (e) => events.push(e));
    const seq = events.filter((e) => e.type === "delta" || e.type === "reset").map((e) => (e.type === "delta" ? e.text : "<reset>"));
    expect(seq).toEqual(["Half an ans", "<reset>", "Complete ", "answer."]);
    expect(r.reply).toBe("Complete answer.");
    expect(r.telemetry.fallbackUsed).toBe(true);
  });

  it("a throwing event sink never breaks the turn", async () => {
    const r = await handleChatTurn(chatDeps(freshStores(), scriptedModel("p", [text("ok")])), { userId: "U001", message: "hi" }, () => {
      throw new Error("socket closed");
    });
    expect(r).toMatchObject({ status: "ok", reply: "ok" });
  });
});

describe("conversation read APIs", () => {
  it("lists only the caller's conversations and returns a display-ready transcript", async () => {
    const stores = setup(
      scriptedModel("p", [
        toolCall("run_scenario", { excludePropertyIds: ["P001"] }),
        text("Hypothetically ₹17.7 Cr."),
        toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 12.5, unit: "CRORE" } } }),
        text("Confirm the change?"),
      ]),
    );
    const deps = chatDeps(stores, (container.current as any).router.primary);
    const t1 = await handleChatTurn(deps, { userId: "U001", message: "What if I exclude Bandra?" });
    await handleChatTurn(deps, { userId: "U001", conversationId: t1.conversationId, message: "Set Bandra to 12.5 Cr" });

    const mine = await (await get(listGET, "/api/conversations", "U001")).json();
    expect(mine.conversations).toHaveLength(1);
    expect(mine.conversations[0].preview).toBe("Confirm the change?");
    const theirs = await (await get(listGET, "/api/conversations", "U002")).json();
    expect(theirs.conversations).toEqual([]);

    const view = await (await get(viewGET, `/api/conversations/${t1.conversationId}`, "U001", { id: t1.conversationId })).json();
    expect(view.messages.map((m: any) => [m.role, m.text, m.hypothetical])).toEqual([
      ["user", "What if I exclude Bandra?", false],
      ["assistant", "Hypothetically ₹17.7 Cr.", true],
      ["user", "Set Bandra to 12.5 Cr", false],
      ["assistant", "Confirm the change?", false],
    ]);
    expect(view.messages[1].toolActivity[0]).toMatchObject({ name: "run_scenario", summary: "hypothetical result ready (real portfolio unchanged)" });
    expect(view.pendingAction).toMatchObject({ propertyId: "P001", diff: [{ before: "₹12 Cr", after: "₹12.5 Cr" }] });

    const blocked = await get(viewGET, `/api/conversations/${t1.conversationId}`, "U002", { id: t1.conversationId });
    expect(blocked.status).toBe(404);
  });
});
