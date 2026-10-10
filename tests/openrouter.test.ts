// OpenRouter integration exercised through the REAL LangChain/OpenAI client with an injected fetch
// that returns SYNTHETIC OpenRouter-format payloads. No network, no key, no cost.
// What this proves: our request shape, response/stream parsing, usage+cost extraction, error
// handling, timeouts and fallback against the documented wire format. What it cannot prove: how a
// live provider actually behaves (latency, model quality, exact fields it returns).
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createOpenRouterModel, extractCostUsd, invokeWithFallback, isAccountError, ModelUnavailableError } from "@/agent/model";
import { RunRecorder } from "@/agent/telemetry";
import { TOOL_SPECS } from "@/agent/tools";
import { handleChatTurn } from "@/server/services/chatService";
import { chatDeps, freshStores, scriptedModel, text } from "./agentHelpers";

type Captured = { url: string; body: any; headers: Headers; signal: AbortSignal | null };

function fakeFetch(respond: (body: any, captured: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const c: Captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers), signal: init?.signal ?? null };
    calls.push(c);
    return respond(c.body, c);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "gen-1", object: "chat.completion.chunk", created: 1, model: "vendor/model", choices: [{ index: 0, delta, finish_reason: null }], ...extra,
});

const toolCompletion = (args: string) => ({
  id: "gen-1", object: "chat.completion", created: 1, model: "vendor/model",
  choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_properties", arguments: args } }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, cost: 0.00123 },
});

const opts = (tools = TOOL_SPECS) => ({ tools, signal: new AbortController().signal });

describe("request shape", () => {
  it("posts to OpenRouter with tools, temperature 0, usage accounting and the bearer key", async () => {
    const { f, calls } = fakeFetch(() => json(toolCompletion('{"sortBy":"rent","limit":1}')));
    await createOpenRouterModel("vendor/model", "sk-or-v1-test", { fetch: f }).invoke([new HumanMessage("hi")], opts());
    expect(calls).toHaveLength(1); // maxRetries: 0 — no hidden SDK retries
    const c = calls[0]!;
    expect(c.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(c.headers.get("authorization")).toBe("Bearer sk-or-v1-test");
    expect(c.body).toMatchObject({ model: "vendor/model", temperature: 0, parallel_tool_calls: true, usage: { include: true } });
    expect(c.body.tools.map((t: any) => t.function.name)).toEqual(TOOL_SPECS.map((t) => t.function.name));
  });
});

describe("response parsing (non-streaming)", () => {
  it("parses tool calls, token usage and provider-reported cost", async () => {
    const { f } = fakeFetch(() => json(toolCompletion('{"sortBy":"rent","limit":1}')));
    const m = await createOpenRouterModel("vendor/model", "k", { fetch: f }).invoke([new HumanMessage("hi")], opts());
    expect(m.tool_calls).toEqual([{ id: "call_1", name: "search_properties", args: { sortBy: "rent", limit: 1 }, type: "tool_call" }]);
    expect(m.usage_metadata).toMatchObject({ input_tokens: 1234, output_tokens: 56 });
    expect(extractCostUsd(m)).toBe(0.00123); // response_metadata.usage.cost
  });

  it("unparseable tool arguments surface as invalid_tool_calls (handled by the graph)", async () => {
    const { f } = fakeFetch(() => json(toolCompletion("{not json")));
    const m = await createOpenRouterModel("vendor/model", "k", { fetch: f }).invoke([new HumanMessage("hi")], opts());
    expect(m.tool_calls ?? []).toEqual([]);
    expect(m.invalid_tool_calls?.[0]).toMatchObject({ id: "call_1", name: "search_properties" });
  });

  it("missing usage leaves cost and tokens unknown (null), not zero", async () => {
    const body = toolCompletion("{}");
    delete (body as any).usage;
    const { f } = fakeFetch(() => json(body));
    const m = await createOpenRouterModel("vendor/model", "k", { fetch: f }).invoke([new HumanMessage("hi")], opts());
    expect(extractCostUsd(m)).toBeNull();
    expect(m.usage_metadata?.input_tokens ?? null).toBeNull();
  });
});

describe("streaming", () => {
  it("streams text deltas and returns the full message with usage and cost", async () => {
    const { f, calls } = fakeFetch(() =>
      sse([
        chunk({ role: "assistant", content: "Your portfolio " }),
        chunk({ content: "is ₹29.7 Cr." }),
        { id: "gen-1", object: "chat.completion.chunk", created: 1, model: "vendor/model", choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, cost: 0.0002 } },
      ]),
    );
    const deltas: string[] = [];
    const m = await createOpenRouterModel("vendor/model", "k", { fetch: f }).stream!([new HumanMessage("hi")], opts(), (t) => deltas.push(t));
    expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(["Your portfolio ", "is ₹29.7 Cr."]);
    expect(m.content).toBe("Your portfolio is ₹29.7 Cr.");
    expect(m.usage_metadata).toMatchObject({ input_tokens: 100, output_tokens: 7 });
    expect(extractCostUsd(m)).toBe(0.0002);
  });

  it("reassembles tool-call arguments split across stream chunks", async () => {
    const { f } = fakeFetch(() =>
      sse([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "run_scenario", arguments: '{"excludeProp' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'ertyIds":["P001"]}' } }] }),
      ]),
    );
    const deltas: string[] = [];
    const m = await createOpenRouterModel("vendor/model", "k", { fetch: f }).stream!([new HumanMessage("hi")], opts(), (t) => deltas.push(t));
    expect(deltas).toEqual([]); // no user-visible text for a pure tool call
    expect(m.tool_calls).toEqual([expect.objectContaining({ id: "call_9", name: "run_scenario", args: { excludePropertyIds: ["P001"] } })]);
  });
});

describe("errors, timeouts and fallback", () => {
  const router = (primaryFetch: typeof fetch, callTimeoutMs = 2_000) => ({
    primary: createOpenRouterModel("vendor/primary", "k", { fetch: primaryFetch }),
    fallback: scriptedModel("fallback", [text("fallback ok")]),
    callTimeoutMs,
  });
  const turnSignal = () => new AbortController().signal;

  it.each([429, 500, 502, 503])("HTTP %i → one attempt, then the fallback answers", async (status) => {
    const { f, calls } = fakeFetch(() => json({ error: { message: "upstream busy", code: status } }, status));
    const rec = new RunRecorder();
    const r = await invokeWithFallback(router(f), [new HumanMessage("hi")], { tools: null, turnSignal: turnSignal() }, rec);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ modelId: "fallback", usedFallback: true, primaryFailed: true });
    expect(rec.llmCalls[0]!.error).toContain(String(status));
  });

  it.each([401, 402])("HTTP %i (key / credits) → no fallback attempt, clear error", async (status) => {
    const { f } = fakeFetch(() => json({ error: { message: "account problem", code: status } }, status));
    const r = router(f);
    const rec = new RunRecorder();
    const err = await invokeWithFallback(r, [new HumanMessage("hi")], { tools: null, turnSignal: turnSignal() }, rec).catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).causes.join(" ")).toMatch(/fallback skipped/);
    expect((r.fallback as ReturnType<typeof scriptedModel>).calls).toHaveLength(0);
    expect(isAccountError({ status })).toBe(true);
  });

  it("provider error bodies echoing secrets are redacted before storage", async () => {
    const { f } = fakeFetch(() => json({ error: { message: "bad request for key sk-or-v1-abcdef1234567890" } }, 400));
    const rec = new RunRecorder();
    await invokeWithFallback(router(f), [new HumanMessage("hi")], { tools: null, turnSignal: turnSignal() }, rec);
    expect(rec.llmCalls[0]!.error).not.toContain("abcdef1234567890");
    expect(rec.llmCalls[0]!.error).toContain("[REDACTED]");
  });

  it("a hung connection is aborted at the per-call timeout (the fetch signal fires) and falls back", async () => {
    let seenSignal: AbortSignal | null = null;
    const { f } = fakeFetch((_b, c) => {
      seenSignal = c.signal;
      return new Promise<Response>((_res, rej) => c.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    });
    const rec = new RunRecorder();
    const started = Date.now();
    const r = await invokeWithFallback(router(f, 50), [new HumanMessage("hi")], { tools: null, turnSignal: turnSignal() }, rec);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(seenSignal!.aborted).toBe(true); // the HTTP request itself is cancelled, not just ignored
    expect(r.modelId).toBe("fallback");
    expect(rec.llmCalls[0]!.error).toBe("timeout after 50 ms");
  });

  it("network errors and garbage 200 bodies fall back", async () => {
    for (const respond of [
      () => {
        throw new TypeError("fetch failed: ECONNRESET");
      },
      () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]) {
      const { f } = fakeFetch(respond as () => Response);
      const r = await invokeWithFallback(router(f), [new HumanMessage("hi")], { tools: null, turnSignal: turnSignal() }, new RunRecorder());
      expect(r.modelId).toBe("fallback");
    }
  });
});

describe("end-to-end turn over the synthetic OpenRouter wire format", () => {
  it("tool call → our tool runs → final streamed answer; usage and cost recorded on the run", async () => {
    let n = 0;
    const { f } = fakeFetch((body) => {
      n++;
      expect(body.stream).toBe(true); // with an event sink every call streams, including tool calls
      if (n === 1) {
        return sse([
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_properties", arguments: '{"sortBy":"rent","limit":1}' } }] }),
          { id: "gen-1", object: "chat.completion.chunk", created: 1, model: "vendor/model", choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, cost: 0.00123 } },
        ]);
      }
      // Second call must include our tool result for call_1.
      const toolMsg = body.messages.find((m: any) => m.role === "tool");
      expect(toolMsg?.tool_call_id).toBe("call_1");
      expect(String(toolMsg?.content)).toContain("P007");
      return sse([
        chunk({ role: "assistant", content: "P007 earns the most: ₹1.68 Cr a year." }),
        { id: "gen-2", object: "chat.completion.chunk", created: 1, model: "vendor/model", choices: [], usage: { prompt_tokens: 1500, completion_tokens: 12, total_tokens: 1512, cost: 0.0004 } },
      ]);
    });
    const stores = freshStores();
    const r = await handleChatTurn(
      chatDeps(stores, createOpenRouterModel("vendor/model", "k", { fetch: f })),
      { userId: "U003", message: "Which property gives me the highest annual rent?" },
      () => {}, // an event sink → the streaming path is used
    );
    expect(r).toMatchObject({ status: "ok", reply: "P007 earns the most: ₹1.68 Cr a year.", needsAttention: false });
    expect(stores.state.runs[0]!.run).toMatchObject({ promptTokens: 1234 + 1500, completionTokens: 56 + 12, costUsd: 0.00123 + 0.0004 });
  });
});
