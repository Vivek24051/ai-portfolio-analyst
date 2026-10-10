// Gemini quota and credential safeguards. OFFLINE: Gemini models run through the real LangChain/OpenAI
// client with an injected fetch that returns SYNTHETIC responses; the global fetch is a spy that fails
// the test if anything tries the network. The error body shapes are assumptions modelled on Google's
// documented error format; real Gemini responses have not been observed by this project.
import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_MODEL_CALLS_PER_TURN, loadAgentConfig } from "@/agent/config";
import { createDevStubModel, DEV_STUB_ID, DEV_STUB_LAST_RESORT_ID, LAST_RESORT_PREFIX, LAST_RESORT_TEMPLATE_LABEL } from "@/agent/devStubModel";
import {
  COOLDOWN_DEFAULT_MS,
  COOLDOWN_MAX_MS,
  COOLDOWN_MIN_MS,
  createGeminiModel,
  invokeWithFallback,
  isAccountError,
  ModelCooldowns,
  ModelUnavailableError,
  rateLimitCooldownMs,
  type ChatModel,
  type ModelRouter,
} from "@/agent/model";
import { RunRecorder } from "@/agent/telemetry";
import { getConversationTrace } from "@/server/admin/adminService";
import { createRouter } from "@/server/container";
import { handleChatTurn } from "@/server/services/chatService";
import { freshStores, scriptedModel, text, toolCall } from "./agentHelpers";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
const labelled = <M extends ChatModel>(m: M, provider: string): M & { provider: string } => Object.assign(m, { provider });
const signal = () => new AbortController().signal;
const ask = (q = "portfolio overview") => [new HumanMessage(q)];
const lastResortStub = () => createDevStubModel({ streamDelayMs: 0, lastResort: true });
const err = (status: number, message = `HTTP ${status} from provider`) => Object.assign(new Error(message), { status });

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

// ---- Synthetic Gemini wire responses -------------------------------------------------------------

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const okText = (content: string) =>
  jsonResponse(200, {
    id: "g", object: "chat.completion", created: 1, model: "gemini-test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });

const googleError = (code: number, status: string, message: string, details: unknown[] = []) => ({ error: { code, message, status, details } });

const INVALID_KEY = googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
  { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
]);
const UNAUTHENTICATED = googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
const PERMISSION_DENIED = googleError(403, "PERMISSION_DENIED", "The caller does not have permission.");
const quota = (message: string, retryDelay?: string) =>
  googleError(429, "RESOURCE_EXHAUSTED", message, retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []);

/** A Gemini model over the real client; `responses` are replayed one per request. */
function wireGemini(id: string, responses: Array<() => Response>) {
  const requests: string[] = [];
  const f = (async (url: RequestInfo | URL) => {
    requests.push(String(url));
    const next = responses[requests.length - 1];
    if (!next) throw new Error(`${id}: no synthetic response left`);
    return next();
  }) as typeof fetch;
  return Object.assign(createGeminiModel(id, "test-key-not-real", { fetch: f }), { requests });
}

const router = (over: Partial<ModelRouter> & Pick<ModelRouter, "primary">): ModelRouter => ({
  fallback: null,
  lastResort: lastResortStub(),
  callTimeoutMs: 2_000,
  ...over,
});

// ---- Account errors --------------------------------------------------------------------------------

describe("Gemini credential errors are account errors (no retry with the same key)", () => {
  it.each([
    ["400 API key not valid (object body)", 400, INVALID_KEY],
    ["400 API key not valid (array body)", 400, [INVALID_KEY]],
    ["401 UNAUTHENTICATED", 401, UNAUTHENTICATED],
    ["403 PERMISSION_DENIED", 403, PERMISSION_DENIED],
  ])("%s: the same-key Gemini fallback is never called; the labelled stub answers", async (_label, status, body) => {
    const gemA = wireGemini("gem-a", [() => jsonResponse(status, body)]);
    const gemB = labelled(scriptedModel("gem-b", [text("must not be called")]), "gemini");
    const rec = new RunRecorder();
    const r = await invokeWithFallback(router({ primary: gemA, fallback: gemB }), ask(), { tools: null, turnSignal: signal() }, rec);
    expect(gemA.requests).toHaveLength(1);
    expect(gemB.calls).toHaveLength(0);
    expect(r).toMatchObject({ modelId: DEV_STUB_LAST_RESORT_ID, usedLastResort: true, failedModelIds: ["gem-a", "gem-b"] });
    expect(JSON.stringify(rec.llmCalls)).not.toContain("test-key-not-real");
  });

  it("a 400 that is NOT about the key (bad request) is an ordinary failure: the fallback is still tried", async () => {
    const gemA = wireGemini("gem-a", [() => jsonResponse(400, googleError(400, "INVALID_ARGUMENT", "Invalid JSON payload received."))]);
    const gemB = labelled(scriptedModel("gem-b", [text("answered by gem-b")]), "gemini");
    const r = await invokeWithFallback(router({ primary: gemA, fallback: gemB }), ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(r.modelId).toBe("gem-b");
  });

  it("classification: 401/402/403 and an invalid-key 400 are account errors; other statuses are not", () => {
    for (const s of [401, 402, 403]) expect(isAccountError(err(s))).toBe(true);
    expect(isAccountError(Object.assign(err(400, "400 API key not valid. Please pass a valid API key."), {}))).toBe(true);
    expect(isAccountError(Object.assign(err(400, "400 status code (no body)"), { error: { details: [{ reason: "API_KEY_INVALID" }] } }))).toBe(true);
    for (const s of [400, 404, 408, 429, 500, 503]) expect(isAccountError(err(s, "something else"))).toBe(false);
    expect(isAccountError(new Error("no status"))).toBe(false);
  });

  it("an account error also cools the model down, so the next turns don't resend the bad key", async () => {
    let clock = 1_000_000;
    const cooldowns = new ModelCooldowns(() => clock);
    const gemA = wireGemini("gem-a", [() => jsonResponse(401, UNAUTHENTICATED)]);
    const gemB = labelled(scriptedModel("gem-b", [text("must not be called")]), "gemini");
    const r = router({ primary: gemA, fallback: gemB, cooldowns });
    await invokeWithFallback(r, ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    const next = await invokeWithFallback(r, ask(), { tools: null, turnSignal: signal() }, new RunRecorder()); // a new turn
    expect(gemA.requests).toHaveLength(1);
    expect(gemB.calls).toHaveLength(0);
    expect(next.usedLastResort).toBe(true);
    expect(cooldowns.remainingMs(gemA)).toBe(COOLDOWN_DEFAULT_MS);
    expect(cooldowns.remainingMs(gemB)).toBe(COOLDOWN_DEFAULT_MS);
  });
});

// ---- 429 cooldown ----------------------------------------------------------------------------------

describe("429 / quota: bounded cooldown across turns", () => {
  it("Retry-After is respected: the model is skipped by later turns until it ends, then called again", async () => {
    let clock = 1_000_000;
    const cooldowns = new ModelCooldowns(() => clock);
    const gem = wireGemini("gem-a", [() => jsonResponse(429, quota("Resource has been exhausted (e.g. check quota)."), { "retry-after": "30" }), () => okText("back")]);
    const r = router({ primary: gem, cooldowns });

    const t1 = await invokeWithFallback(r, ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(t1.usedLastResort).toBe(true);
    expect(cooldowns.remainingMs(gem)).toBe(30_000);

    clock += 29_000;
    const t2 = await invokeWithFallback(r, ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(gem.requests).toHaveLength(1); // not called during the cooldown
    expect(t2.usedLastResort).toBe(true);
    expect(t2.causes.join(" ")).toMatch(/gem-a: skipped \(cooling down .*1 s left\)/);

    clock += 1_001;
    const t3 = await invokeWithFallback(r, ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(gem.requests).toHaveLength(2);
    expect(t3.modelId).toBe("gem-a");
    expect(cooldowns.size).toBe(0); // expired entries are dropped
  });

  it("429 without any retry hint uses the conservative default cooldown", async () => {
    const clock = 5_000;
    const cooldowns = new ModelCooldowns(() => clock);
    const gem = wireGemini("gem-a", [() => jsonResponse(429, quota("Resource has been exhausted (e.g. check quota)."))]);
    await invokeWithFallback(router({ primary: gem, cooldowns }), ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(cooldowns.remainingMs(gem)).toBe(COOLDOWN_DEFAULT_MS);
  });

  it("without a header, Gemini's RetryInfo.retryDelay in the body is used (object and array bodies)", async () => {
    for (const body of [quota("Quota exceeded.", "12s"), [quota("Quota exceeded.", "12s")]]) {
      const cooldowns = new ModelCooldowns(() => 0);
      const gem = wireGemini("gem-a", [() => jsonResponse(429, body)]);
      await invokeWithFallback(router({ primary: gem, cooldowns }), ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
      expect(cooldowns.remainingMs(gem)).toBe(12_000);
    }
  });

  it("a cooldown on one model does not block a different Gemini model (separate quota) in the same turn", async () => {
    const cooldowns = new ModelCooldowns(() => 0);
    const gemA = wireGemini("gem-a", [() => jsonResponse(429, quota("Quota exceeded."), { "retry-after": "10" })]);
    const gemB = labelled(scriptedModel("gem-b", [text("from gem-b")]), "gemini");
    const r = await invokeWithFallback(router({ primary: gemA, fallback: gemB, cooldowns }), ask(), { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(r.modelId).toBe("gem-b");
    expect(cooldowns.remainingMs(gemB)).toBe(0);
  });

  it("every real model cooling down and no stub: ModelUnavailableError, without sending any request", async () => {
    const cooldowns = new ModelCooldowns(() => 0);
    const gem = wireGemini("gem-a", []);
    cooldowns.start(gem, 60_000);
    const e = await invokeWithFallback(router({ primary: gem, lastResort: null, cooldowns }), ask(), { tools: null, turnSignal: signal() }, new RunRecorder()).catch((x) => x);
    expect(e).toBeInstanceOf(ModelUnavailableError);
    expect((e as Error).message).toMatch(/No model available/);
    expect(gem.requests).toHaveLength(0);
  });

  it("cooldown length: Retry-After seconds or HTTP date, body hints, daily quota, and clamping", () => {
    const now = Date.UTC(2026, 9, 11, 12, 0, 0);
    const e429 = (message: string, headers?: Record<string, string>, error?: unknown) =>
      Object.assign(new Error(message), { status: 429, ...(headers ? { headers: new Headers(headers) } : {}), ...(error ? { error } : {}) });
    expect(rateLimitCooldownMs(e429("x", { "retry-after": "45" }), now)).toBe(45_000);
    expect(rateLimitCooldownMs(e429("x", { "retry-after": new Date(now + 20_000).toUTCString() }), now)).toBe(20_000);
    expect(rateLimitCooldownMs(e429("x", { "retry-after": new Date(now - 60_000).toUTCString() }), now)).toBe(COOLDOWN_MIN_MS);
    expect(rateLimitCooldownMs(e429("x", { "retry-after": "0" }), now)).toBe(COOLDOWN_MIN_MS);
    expect(rateLimitCooldownMs(e429("x", { "retry-after": "999999" }), now)).toBe(COOLDOWN_MAX_MS);
    expect(rateLimitCooldownMs(e429("x", { "retry-after": "soon" }), now)).toBe(COOLDOWN_DEFAULT_MS); // unparseable
    expect(rateLimitCooldownMs(e429("429 Quota exceeded. Please retry in 7.2s."), now)).toBe(7_200);
    expect(rateLimitCooldownMs(e429("429 Quota exceeded for metric generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel"), now)).toBe(COOLDOWN_MAX_MS);
    expect(rateLimitCooldownMs(e429("x", { "retry-after": "5" }, quota("Daily limit reached", "5s")), now)).toBe(COOLDOWN_MAX_MS); // daily wins
    expect(rateLimitCooldownMs(e429("x", undefined, quota("Quota exceeded.", "33s")), now)).toBe(33_000);
    expect(rateLimitCooldownMs(e429("no hint"), now)).toBe(COOLDOWN_DEFAULT_MS);
  });

  it("ModelCooldowns is bounded, uses no timers, and expires lazily", () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const c = new ModelCooldowns(() => clock, 2);
      const m = (id: string) => ({ id, provider: "gemini" }) as ChatModel;
      c.start(m("a"), 10_000);
      c.start(m("b"), 5_000);
      c.start(m("c"), 20_000); // full: the entry ending soonest ("b") is dropped
      expect(c.size).toBe(2);
      expect(c.remainingMs(m("b"))).toBe(0);
      expect(c.remainingMs(m("c"))).toBe(20_000);
      c.start(m("a"), 1_000); // never shortens an existing cooldown
      expect(c.remainingMs(m("a"))).toBe(10_000);
      expect(vi.getTimerCount()).toBe(0);
      clock = 30_000;
      expect(c.remainingMs(m("a"))).toBe(0);
      expect(c.remainingMs(m("c"))).toBe(0);
      expect(c.size).toBe(0);
      // Same id on another provider is a different entry.
      c.start({ id: "x", provider: "gemini" } as ChatModel, 1_000);
      expect(c.remainingMs({ id: "x", provider: "openrouter" } as ChatModel)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Per-turn cap ----------------------------------------------------------------------------------

describe("hard cap on real model calls per turn (scripted Gemini, in-memory store)", () => {
  const turn = (stores: ReturnType<typeof freshStores>, r: ModelRouter, message: string) =>
    handleChatTurn({ stores, router: r, historyLimit: 30, turnDeadlineMs: 10_000 }, { userId: "U001", message });

  it("a model that keeps calling tools is stopped at the cap; the labelled stub answers and the turn is flagged", async () => {
    const stores = freshStores();
    const gem = labelled(scriptedModel("gem-a", Array.from({ length: 10 }, () => toolCall("portfolio_analytics", {}))), "gemini");
    const r = await turn(stores, router({ primary: gem, maxRealCallsPerTurn: 2 }), "What does my portfolio look like?");
    expect(gem.calls).toHaveLength(2);
    expect(r.status).toBe("ok");
    expect(r.reply.startsWith(LAST_RESORT_TEMPLATE_LABEL)).toBe(true);
    expect(r.telemetry).toMatchObject({ model: DEV_STUB_LAST_RESORT_ID, fallbackUsed: true });
    const trace = await getConversationTrace(stores, r.conversationId);
    expect(trace.conversation.attentionReason).toMatch(/^model_degraded: .*per-turn cap of 2 real model calls/);
    expect(trace.runs[0]!.llmCalls.filter((c) => c.provider === "gemini")).toHaveLength(2);
  });

  it("the cap counts the whole chain: a failed primary and its fallback both use it", async () => {
    const gemA = labelled(scriptedModel("gem-a", [err(503)]), "gemini");
    const gemB = labelled(scriptedModel("gem-b", [toolCall("portfolio_analytics", {}), text("must not be reached")]), "gemini");
    const r = await turn(freshStores(), router({ primary: gemA, fallback: gemB, maxRealCallsPerTurn: 2 }), "What does my portfolio look like?");
    expect(gemA.calls).toHaveLength(1);
    expect(gemB.calls).toHaveLength(1); // the second round would be the third real call
    expect(r.telemetry.model).toBe(DEV_STUB_LAST_RESORT_ID);
  });

  it("a proposal made before the cap is still only staged: nothing is written without confirmation", async () => {
    const stores = freshStores();
    const before = JSON.stringify(stores.state.properties.find((p) => p.id === "P001"));
    const gem = labelled(
      scriptedModel("gem-a", [toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 14, unit: "CRORE" } } }), toolCall("confirm_pending_action", {})]),
      "gemini",
    );
    const r = await turn(stores, router({ primary: gem, maxRealCallsPerTurn: 1 }), "Update P001's value to ₹14 Cr");
    expect(gem.calls).toHaveLength(1); // the second call (an attempted confirm) never happens
    expect(r.status).toBe("ok");
    expect(JSON.stringify(stores.state.properties.find((p) => p.id === "P001"))).toBe(before);
    expect(stores.state.pendingActions.filter((a) => a.status === "PENDING")).toHaveLength(1);
  });

  it("config: default cap, clamping to 1–12, and the stub-only router has no cap or cooldowns", () => {
    expect(loadAgentConfig(env({})).maxModelCallsPerTurn).toBe(DEFAULT_MAX_MODEL_CALLS_PER_TURN);
    expect(DEFAULT_MAX_MODEL_CALLS_PER_TURN).toBe(4);
    for (const [raw, expected] of [["2", 2], ["0", 4], ["-3", 4], ["abc", 4], ["0.5", 1], ["99", 12], ["6.9", 6]] as const) {
      expect(loadAgentConfig(env({ LLM_MAX_MODEL_CALLS_PER_TURN: raw })).maxModelCallsPerTurn).toBe(expected);
    }
    const stub = createRouter(loadAgentConfig(env({ LLM_PROVIDER: "stub" }))).router;
    expect(stub.maxRealCallsPerTurn).toBeUndefined();
    expect(stub.cooldowns ?? null).toBeNull();
    const gemini = createRouter(loadAgentConfig(env({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-not-real", LLM_PRIMARY_MODEL: "gem-a", LLM_MAX_MODEL_CALLS_PER_TURN: "3" }))).router;
    expect(gemini.maxRealCallsPerTurn).toBe(3);
    expect(gemini.cooldowns).toBeInstanceOf(ModelCooldowns);
    expect(gemini.fallback).toBeNull(); // no fallback model configured: never an OpenRouter one
  });
});

// ---- Last-resort wording ---------------------------------------------------------------------------

describe("last-resort stub wording", () => {
  const ENV_NAMES = /LLM_|GEMINI|OPENROUTER|API key|_KEY|LLM_PROVIDER/i;
  const failingGemini = () => labelled(scriptedModel("gem-a", [err(503), err(503)]), "gemini");

  it("unrecognised question during a Gemini outage: says the AI model is unavailable, not 'no LLM configured', and names no settings", async () => {
    const stores = freshStores();
    const r = await handleChatTurn({ stores, router: router({ primary: failingGemini() }), historyLimit: 30, turnDeadlineMs: 10_000 }, { userId: "U001", message: "tell me a joke" });
    expect(r.reply.startsWith(LAST_RESORT_PREFIX)).toBe(true);
    expect(r.reply).not.toMatch(/no LLM configured/);
    expect(r.reply).not.toMatch(ENV_NAMES);
    const trace = await getConversationTrace(stores, r.conversationId);
    expect(trace.conversation.attentionReason).toMatch(/^model_degraded: .*gem-a: .*HTTP 503/);
  });

  it("template answers during an outage carry the 'AI model unavailable' label", async () => {
    const r = await handleChatTurn(
      { stores: freshStores(), router: router({ primary: failingGemini() }), historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "What does my portfolio look like?" },
    );
    expect(r.reply.startsWith(LAST_RESORT_TEMPLATE_LABEL)).toBe(true);
    expect(r.reply).not.toMatch(/no LLM configured/);
  });

  it("stub mode (no real model) keeps its own label, and its help text names no settings either", async () => {
    const stub = createDevStubModel({ streamDelayMs: 0 });
    expect(stub.id).toBe(DEV_STUB_ID);
    const r = await handleChatTurn(
      { stores: freshStores(), router: { primary: stub, fallback: null, callTimeoutMs: 2_000 }, historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "tell me a joke" },
    );
    expect(r.reply).toMatch(/^\[dev stub — no LLM configured\]/);
    expect(r.reply).not.toMatch(ENV_NAMES);
  });
});
