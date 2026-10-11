// Gemini thought signatures over the OpenAI-compatible endpoint. OFFLINE: the real LangChain/OpenAI
// client talks to an injected fetch that returns SYNTHETIC responses; the global fetch is a spy that
// fails the test on any network attempt. The response shape (`extra_content.google.thought_signature`)
// follows Google's documentation; whether live Gemini accepts the replayed requests is NOT verified here.
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSignaturesToRequest, PLACEHOLDER_THOUGHT_SIGNATURE, ThoughtSignatureStore, withThoughtSignatures } from "@/agent/geminiSignatures";
import { createGeminiModel, createOpenRouterModel } from "@/agent/model";
import { TOOL_SPECS } from "@/agent/tools";
import { handleChatTurn } from "@/server/services/chatService";
import { freshStores } from "./agentHelpers";

let networkSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  networkSpy = vi.fn(async () => {
    throw new Error("network access attempted");
  });
  vi.stubGlobal("fetch", networkSpy);
});
afterEach(() => {
  expect(networkSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

type Body = { messages: Array<{ role: string; tool_calls?: Array<Record<string, any>> }>; stream?: boolean };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

const SIG = "c2lnbmF0dXJlLWZyb20tZ2VtaW5p"; // synthetic, opaque
const toolCallResponse = (id: string, name = "portfolio_analytics") =>
  json({
    id: "g", object: "chat.completion", created: 1, model: "gemini-test",
    choices: [{
      index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" }, extra_content: { google: { thought_signature: SIG } } }] },
    }],
  });
const textResponse = (content: string) =>
  json({ id: "g", object: "chat.completion", created: 1, model: "gemini-test", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });

/** Replays responses and records each request body; a request is rejected like Gemini does if a signature is missing. */
function fakeGemini(responses: Array<(body: Body) => Response>) {
  const bodies: Body[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    const step = responses[bodies.length - 1];
    if (!step) throw new Error("no synthetic response left");
    return step(body);
  }) as typeof fetch;
  return { f, bodies };
}
const assistantToolCalls = (b: Body) => b.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
const sigOf = (c: Record<string, any>) => c.extra_content?.google?.thought_signature;
const opts = () => ({ tools: TOOL_SPECS, signal: new AbortController().signal });

describe("Gemini thought signatures are sent back with the tool call (real client, synthetic wire)", () => {
  it("invoke: the signature from the tool-call response is on that tool call in the next request", async () => {
    const { f, bodies } = fakeGemini([() => toolCallResponse("call-a"), () => textResponse("done")]);
    const model = createGeminiModel("gemini-test", "test-key-not-real", { fetch: f });
    const first = await model.invoke([new HumanMessage("portfolio overview")], opts());
    expect(first.tool_calls?.[0]?.id).toBe("call-a");
    await model.invoke(
      [new HumanMessage("portfolio overview"), first, new ToolMessage({ content: "{}", tool_call_id: "call-a", name: "portfolio_analytics" })],
      opts(),
    );
    const replayed = assistantToolCalls(bodies[1]!);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ id: "call-a", function: { name: "portfolio_analytics" } });
    expect(sigOf(replayed[0]!)).toBe(SIG);
  });

  it("stream: a signature split from its id across SSE chunks is recorded and sent back", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id: "g", object: "chat.completion.chunk", created: 1, model: "gemini-test", choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const { f, bodies } = fakeGemini([
      () =>
        sse([
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-s", type: "function", function: { name: "portfolio_analytics", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" }, extra_content: { google: { thought_signature: SIG } } }] }),
          chunk({}, "tool_calls"),
        ]),
      () => textResponse("done"),
    ]);
    const model = createGeminiModel("gemini-test", "test-key-not-real", { fetch: f });
    const first = await model.stream!([new HumanMessage("portfolio overview")], opts(), () => {});
    await model.invoke(
      [new HumanMessage("portfolio overview"), first, new ToolMessage({ content: "{}", tool_call_id: "call-s", name: "portfolio_analytics" })],
      opts(),
    );
    expect(sigOf(assistantToolCalls(bodies[1]!)[0]!)).toBe(SIG);
  });

  it("history with no known signature (restart / other instance) gets the documented placeholder", async () => {
    const { f, bodies } = fakeGemini([() => textResponse("done")]);
    const model = createGeminiModel("gemini-test", "test-key-not-real", { fetch: f });
    const old = new AIMessage({ content: "", tool_calls: [{ id: "old-1", name: "portfolio_analytics", args: {}, type: "tool_call" }] });
    await model.invoke([new HumanMessage("hi"), old, new ToolMessage({ content: "{}", tool_call_id: "old-1", name: "portfolio_analytics" })], opts());
    expect(sigOf(assistantToolCalls(bodies[0]!)[0]!)).toBe(PLACEHOLDER_THOUGHT_SIGNATURE);
  });

  it("end to end (streamed, as the chat uses): a Gemini turn that calls a tool ends with the model's own answer, not the stub", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id: "g", object: "chat.completion.chunk", created: 1, model: "gemini-test", choices: [{ index: 0, delta, finish_reason: finish }],
    });
    let sawSignature = false;
    const { f, bodies } = fakeGemini([
      () =>
        sse([
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-e2e", type: "function", function: { name: "portfolio_analytics", arguments: "{}" }, extra_content: { google: { thought_signature: SIG } } }] }),
          chunk({}, "tool_calls"),
        ]),
      (body) => {
        // Behave like Gemini 3: reject the follow-up if the signature is missing.
        sawSignature = sigOf(assistantToolCalls(body)[0] ?? {}) === SIG;
        if (!sawSignature) return new Response(JSON.stringify([{ error: { code: 400, message: "Function call is missing a thought_signature" } }]), { status: 400, headers: { "content-type": "application/json" } });
        return sse([chunk({ role: "assistant", content: "Your portfolio is worth ₹29.7 Cr." }), chunk({}, "stop")]);
      },
    ]);
    const gem = createGeminiModel("gemini-test", "test-key-not-real", { fetch: f });
    const r = await handleChatTurn(
      { stores: freshStores(), router: { primary: gem, fallback: null, callTimeoutMs: 5_000 }, historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "What does my portfolio look like?" },
    );
    expect(bodies.map((b) => b.stream)).toEqual([true, true]);
    expect(sawSignature).toBe(true);
    expect(r).toMatchObject({ status: "ok", reply: "Your portfolio is worth ₹29.7 Cr.", telemetry: { model: "gemini-test", fallbackUsed: false } });
    expect(r.needsAttention).toBe(false);
  });

  it("OpenRouter requests are left untouched (no extra_content added)", async () => {
    const { f, bodies } = fakeGemini([() => textResponse("done")]);
    const model = createOpenRouterModel("vendor/x:free", "test-key-not-real", { fetch: f });
    const old = new AIMessage({ content: "", tool_calls: [{ id: "old-1", name: "portfolio_analytics", args: {}, type: "tool_call" }] });
    await model.invoke([new HumanMessage("hi"), old, new ToolMessage({ content: "{}", tool_call_id: "old-1", name: "portfolio_analytics" })], opts());
    expect(sigOf(assistantToolCalls(bodies[0]!)[0]!)).toBeUndefined();
  });
});

describe("signature store and request rewriting (units)", () => {
  it("known signatures go on their own calls; the placeholder only on the first call of an unknown step", () => {
    const store = new ThoughtSignatureStore();
    store.set("a1", "sig-a1");
    const body = {
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", tool_calls: [{ id: "a1" }, { id: "a2" }] },
        { role: "assistant", tool_calls: [{ id: "b1" }, { id: "b2" }] },
        { role: "assistant", tool_calls: [{ id: "c1", extra_content: { google: { thought_signature: "already" } } }] },
      ],
    };
    const out = addSignaturesToRequest(body, store)!;
    const calls = (out.messages as Body["messages"]).slice(1).map((m) => m.tool_calls!.map(sigOf));
    expect(calls).toEqual([["sig-a1", undefined], [PLACEHOLDER_THOUGHT_SIGNATURE, undefined], ["already"]]);
    expect(addSignaturesToRequest({ messages: [{ role: "user", content: "x" }] }, store)).toBeNull(); // nothing to change
  });

  it("the store is bounded (oldest dropped) and ignores empty or oversized signatures", () => {
    const store = new ThoughtSignatureStore(2);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    expect(store.size).toBe(2);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBe("3");
    store.set("d", "");
    store.set("e", "x".repeat(70_000));
    expect(store.get("d")).toBeUndefined();
    expect(store.get("e")).toBeUndefined();
  });

  it("a hung streamed response never blocks the next request for long", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const base = (async () => {
        call++;
        if (call === 1) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } }); // never ends
        return textResponse("ok");
      }) as typeof fetch;
      const f = withThoughtSignatures(base, new ThoughtSignatureStore());
      await f("https://example.invalid", { method: "POST", body: "{}" });
      const second = f("https://example.invalid", { method: "POST", body: "{}" });
      await vi.advanceTimersByTimeAsync(2_001);
      expect((await second).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
