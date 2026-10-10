// Gemini provider through its OpenAI-compatible endpoint, exercised with an injected fetch that
// returns SYNTHETIC responses. No network, no real key, no Google call.
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "@/agent/config";
import { createGeminiModel, GEMINI_OPENAI_BASE_URL } from "@/agent/model";
import { TOOL_SPECS } from "@/agent/tools";
import { createRouter } from "@/server/container";
import { redactSecrets } from "@/server/redact";
import { handleChatTurn } from "@/server/services/chatService";
import { chatDeps, freshStores } from "./agentHelpers";

type Captured = { url: string; body: any; headers: Headers };
function fakeFetch(respond: (body: any) => Response) {
  const calls: Captured[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) };
    calls.push(c);
    return respond(c.body);
  }) as typeof fetch;
  return { f, calls };
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const chunk = (delta: Record<string, unknown>) => ({ id: "g", object: "chat.completion.chunk", created: 1, model: "gemini-test", choices: [{ index: 0, delta, finish_reason: null }] });
const opts = () => ({ tools: TOOL_SPECS, signal: new AbortController().signal });

describe("Gemini request shape", () => {
  it("calls the Gemini OpenAI-compatible endpoint with a bearer key and no OpenRouter-only fields", async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        id: "g", object: "chat.completion", created: 1, model: "gemini-test",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "portfolio_analytics", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 },
      }),
    );
    const m = await createGeminiModel("gemini-test", "test-key", { fetch: f }).invoke([new HumanMessage("hi")], opts());
    const c = calls[0]!;
    expect(c.url).toBe(`${GEMINI_OPENAI_BASE_URL}chat/completions`);
    expect(c.headers.get("authorization")).toBe("Bearer test-key");
    expect(c.body).toMatchObject({ model: "gemini-test", temperature: 0 });
    expect(c.body.tools).toHaveLength(TOOL_SPECS.length);
    expect(c.body).not.toHaveProperty("usage");
    expect(c.body).not.toHaveProperty("parallel_tool_calls");
    expect(c.headers.get("x-title")).toBeNull();
    expect(m.tool_calls?.[0]).toMatchObject({ name: "portfolio_analytics", args: {} });
    expect(m.usage_metadata).toMatchObject({ input_tokens: 900, output_tokens: 12 });
  });

  it("streams without requesting stream usage", async () => {
    const { f, calls } = fakeFetch(() => sse([chunk({ role: "assistant", content: "Hello " }), chunk({ content: "there" })]));
    const deltas: string[] = [];
    const m = await createGeminiModel("gemini-test", "k", { fetch: f }).stream!([new HumanMessage("hi")], opts(), (t) => deltas.push(t));
    expect(calls[0]!.body.stream).toBe(true);
    expect(calls[0]!.body).not.toHaveProperty("stream_options");
    expect(deltas).toEqual(["Hello ", "there"]);
    expect(m.content).toBe("Hello there");
  });
});

describe("provider selection", () => {
  const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
  it("LLM_PROVIDER=gemini with key + model → gemini (fallback model optional)", () => {
    const r = createRouter(loadAgentConfig(env({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k", LLM_PRIMARY_MODEL: "gemini-a", LLM_FALLBACK_MODEL: "gemini-b" })));
    expect(r.modelMode).toBe("gemini");
    expect([r.router.primary.id, r.router.fallback?.id]).toEqual(["gemini-a", "gemini-b"]);
  });

  it("missing Gemini key or model → dev stub (never a silent paid provider)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createRouter(loadAgentConfig(env({ LLM_PROVIDER: "gemini", LLM_PRIMARY_MODEL: "m" }))).modelMode).toBe("dev-stub");
    expect(createRouter(loadAgentConfig(env({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "o" }))).modelMode).toBe("dev-stub");
    expect(createRouter(loadAgentConfig(env({}))).modelMode).toBe("dev-stub");
    warn.mockRestore();
  });
});

describe("Gemini keys are redacted", () => {
  it("strips Google key formats and the configured key value", () => {
    const out = redactSecrets("bad key AIzaSyA1234567890abcdefghijklmno and AQ.Ab12345678901234567890xyz", {} as NodeJS.ProcessEnv);
    expect(out).not.toMatch(/AIzaSy|AQ\.Ab1/);
    expect(redactSecrets("echo my-gemini-secret-value", { GEMINI_API_KEY: "my-gemini-secret-value" } as unknown as NodeJS.ProcessEnv)).toBe("echo [REDACTED]");
  });
});

describe("end-to-end turn over the synthetic Gemini wire format", () => {
  it("tool call → our tool runs → streamed answer; tokens unknown when not streamed back", async () => {
    let n = 0;
    const { f } = fakeFetch((body) => {
      n++;
      if (n === 1) {
        return sse([chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "portfolio_analytics", arguments: '{"sections":["totals"]}' } }] })]);
      }
      expect(String(body.messages.find((m: any) => m.role === "tool")?.content)).toContain("₹29.7 Cr");
      return sse([chunk({ role: "assistant", content: "Your 3 properties are worth ₹29.7 Cr." })]);
    });
    const stores = freshStores();
    const r = await handleChatTurn(chatDeps(stores, createGeminiModel("gemini-test", "k", { fetch: f })), { userId: "U001", message: "total value?" }, () => {});
    expect(r).toMatchObject({ status: "ok", reply: "Your 3 properties are worth ₹29.7 Cr.", needsAttention: false });
    expect(stores.state.runs[0]!.run).toMatchObject({ model: "gemini-test", promptTokens: null, costUsd: null });
  });
});
