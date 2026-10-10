// Mixed-provider fallback (Gemini → OpenRouter :free → stub) and the free-only guard. OFFLINE:
// models are scripted fakes labelled with a provider, client construction is checked with a fetch
// spy, and no real key, endpoint or account is ever used.
import { HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_MODEL_CALLS_PER_TURN, loadAgentConfig } from "@/agent/config";
import { DEV_STUB_ID, DEV_STUB_LAST_RESORT_ID, createDevStubModel } from "@/agent/devStubModel";
import { invokeWithFallback, ModelCooldowns, ModelUnavailableError, type ChatModel, type ModelRouter } from "@/agent/model";
import { RunRecorder } from "@/agent/telemetry";
import { getConversationTrace } from "@/server/admin/adminService";
import { createRouter, isAllowedOpenRouterModel } from "@/server/container";
import { handleChatTurn } from "@/server/services/chatService";
import { freshStores, hangingModel, scriptedModel, text, toolCall } from "./agentHelpers";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
const KEYS = { GEMINI_API_KEY: "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE0000", OPENROUTER_API_KEY: "sk-or-v1-fakefakefakefake0000" };
const err = (status: number, message = `HTTP ${status} from provider`) => Object.assign(new Error(message), { status });
const labelled = <M extends ChatModel>(m: M, provider: string): M & { provider: string } => Object.assign(m, { provider });
const signal = () => new AbortController().signal;
const ask = [new HumanMessage("hi")];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration: chain, free-only guard, safe defaults (no network)", () => {
  const build = (vars: Record<string, string>) => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", fetchSpy);
    return { r: createRouter(loadAgentConfig(env(vars))), fetchSpy };
  };
  const GEMINI_PLUS_FREE = { ...KEYS, LLM_PROVIDER: "gemini", LLM_PRIMARY_MODEL: "gem-a", LLM_FALLBACK_PROVIDER: "openrouter", LLM_FALLBACK_MODEL: "vendor/x:free" };

  it("Gemini primary → OpenRouter :free fallback → stub last resort; building it makes no request", () => {
    const { r, fetchSpy } = build(GEMINI_PLUS_FREE);
    expect(r.modelMode).toBe("gemini");
    expect(r.modelChain).toEqual(["gemini:gem-a", "openrouter:vendor/x:free", "stub"]);
    expect(r.router.primary.provider).toBe("gemini");
    expect(r.router.fallback?.provider).toBe("openrouter");
    // Behind a real model the stub is the labelled last resort, never "no LLM configured".
    expect(r.router.lastResort?.id).toBe(DEV_STUB_LAST_RESORT_ID);
    expect(r.router.lastResort?.id).not.toBe(DEV_STUB_ID);
    // Quota guards are on for real chains: a cooldown store and the default per-turn call cap.
    expect(r.router.cooldowns).toBeInstanceOf(ModelCooldowns);
    expect(r.router.maxRealCallsPerTurn).toBe(DEFAULT_MAX_MODEL_CALLS_PER_TURN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an empty environment builds only the stub: no client, no fallback provider, paid OpenRouter off", () => {
    const { r, fetchSpy } = build({});
    const c = loadAgentConfig(env({}));
    expect(r.modelMode).toBe("dev-stub");
    expect(r.modelChain).toEqual(["stub"]);
    expect(c).toMatchObject({ provider: null, fallbackProvider: null, openRouterAllowPaid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("LLM_PROVIDER=stub stays the safe default: no client, no fallback, whatever else is set", () => {
    const { r, fetchSpy } = build({ ...GEMINI_PLUS_FREE, LLM_PROVIDER: "stub", OPENROUTER_ALLOW_PAID: "true" });
    expect(r.modelMode).toBe("dev-stub");
    expect(r.modelChain).toEqual(["stub"]);
    expect(r.router.fallback).toBeNull();
    expect(r.router.lastResort ?? null).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses non-free OpenRouter ids by default (fallback and primary); the warning never echoes values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { r } = build({ ...GEMINI_PLUS_FREE, LLM_FALLBACK_MODEL: "vendor/paid-model" });
    expect(r.modelChain).toEqual(["gemini:gem-a", "stub"]); // no paid fallback
    const primary = build({ ...KEYS, LLM_PROVIDER: "openrouter", LLM_PRIMARY_MODEL: "vendor/paid-model" }).r;
    expect(primary.modelMode).toBe("dev-stub"); // never falls through to a paid model
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain('only ":free" model ids are allowed');
    expect(logged).not.toContain("vendor/paid-model");
    for (const k of Object.values(KEYS)) expect(logged).not.toContain(k);
  });

  it("paid OpenRouter models need the explicit opt-in, which is off by default and only 'true'/'1' enables", () => {
    expect(loadAgentConfig(env({})).openRouterAllowPaid).toBe(false);
    for (const v of ["yes", "on", "TRUE ", ""]) expect(loadAgentConfig(env({ OPENROUTER_ALLOW_PAID: v })).openRouterAllowPaid).toBe(v.trim().toLowerCase() === "true");
    expect(isAllowedOpenRouterModel("vendor/x:free", false)).toBe(true);
    expect(isAllowedOpenRouterModel("vendor/x", false)).toBe(false);
    expect(isAllowedOpenRouterModel("vendor/x:freebie", false)).toBe(false);
    expect(isAllowedOpenRouterModel("vendor/x", true)).toBe(true);
    const { r } = build({ ...KEYS, LLM_PROVIDER: "openrouter", LLM_PRIMARY_MODEL: "vendor/paid-model", OPENROUTER_ALLOW_PAID: "true" });
    expect(r.modelMode).toBe("openrouter");
  });

  it("stub last resort can be turned off; the stub can also be the explicit fallback", () => {
    expect(build({ ...GEMINI_PLUS_FREE, LLM_STUB_LAST_RESORT: "false" }).r.modelChain).toEqual(["gemini:gem-a", "openrouter:vendor/x:free"]);
    const stubFallback = build({ ...KEYS, LLM_PROVIDER: "gemini", LLM_PRIMARY_MODEL: "gem-a", LLM_FALLBACK_PROVIDER: "stub" }).r;
    expect(stubFallback.modelChain).toEqual(["gemini:gem-a", "stub"]);
    expect(stubFallback.router.lastResort ?? null).toBeNull();
  });

  it("a missing fallback key or an unrecognised fallback provider gives no fallback (values never logged)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noKey = build({ GEMINI_API_KEY: KEYS.GEMINI_API_KEY, LLM_PROVIDER: "gemini", LLM_PRIMARY_MODEL: "gem-a", LLM_FALLBACK_PROVIDER: "openrouter", LLM_FALLBACK_MODEL: "vendor/x:free" }).r;
    expect(noKey.modelChain).toEqual(["gemini:gem-a", "stub"]);
    const secretLike = "sk-or-v1-pastedbymistake00000000";
    const unknown = build({ ...GEMINI_PLUS_FREE, LLM_FALLBACK_PROVIDER: secretLike }).r;
    expect(unknown.modelChain).toEqual(["gemini:gem-a", "stub"]);
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("unrecognised LLM_FALLBACK_PROVIDER");
    expect(logged).not.toContain(secretLike);
  });

  it("the model chain description contains model ids only, never keys", () => {
    const { r } = build(GEMINI_PLUS_FREE);
    for (const k of Object.values(KEYS)) expect(r.modelChain.join(" ")).not.toContain(k);
  });
});

describe("invokeWithFallback: errors, cross-provider fallback, last resort (scripted models)", () => {
  const chain = (gemini: ChatModel, openrouter: ChatModel | null, withStub = true, callTimeoutMs = 2_000): ModelRouter & { lastResort: ChatModel | null } => ({
    primary: gemini,
    fallback: openrouter,
    lastResort: withStub ? createDevStubModel({ streamDelayMs: 0 }) : null,
    callTimeoutMs,
  });

  it.each([429, 500, 503])("Gemini %i → the OpenRouter fallback answers; the stub is not used", async (status) => {
    const gem = labelled(scriptedModel("gem-a", [err(status)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [text("from openrouter")]), "openrouter");
    const rec = new RunRecorder();
    const r = await invokeWithFallback(chain(gem, or), ask, { tools: null, turnSignal: signal() }, rec);
    expect(r).toMatchObject({ modelId: "vendor/x:free", usedFallback: true, primaryFailed: true, usedLastResort: false, failedModelIds: ["gem-a"] });
    expect(rec.llmCalls.map((c) => [c.model, c.provider, c.ok, c.isFallback, c.lastResort])).toEqual([
      ["gem-a", "gemini", false, false, false],
      ["vendor/x:free", "openrouter", true, true, false],
    ]);
  });

  it("a Gemini timeout moves on to the fallback", async () => {
    const gem = labelled(hangingModel("gem-a"), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [text("ok")]), "openrouter");
    const rec = new RunRecorder();
    const r = await invokeWithFallback(chain(gem, or, true, 50), ask, { tools: null, turnSignal: signal() }, rec);
    expect(r.modelId).toBe("vendor/x:free");
    expect(rec.llmCalls[0]!.error).toMatch(/timeout after 50 ms/);
  });

  it("both real models fail → the labelled dev stub answers as the last resort", async () => {
    const gem = labelled(scriptedModel("gem-a", [err(429)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [err(503)]), "openrouter");
    const rec = new RunRecorder();
    const r = await invokeWithFallback(chain(gem, or), [new HumanMessage("portfolio overview")], { tools: null, turnSignal: signal() }, rec);
    expect(r).toMatchObject({ modelId: DEV_STUB_ID, usedFallback: true, usedLastResort: true, failedModelIds: ["gem-a", "vendor/x:free"] });
    expect(rec.llmCalls.at(-1)).toMatchObject({ model: DEV_STUB_ID, provider: "stub", ok: true, isFallback: true, lastResort: true });
  });

  it.each([401, 402])("Gemini %i (account error) does not block a DIFFERENT provider: OpenRouter is still tried", async (status) => {
    const gem = labelled(scriptedModel("gem-a", [err(status)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [text("ok")]), "openrouter");
    const r = await invokeWithFallback(chain(gem, or), ask, { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(r.modelId).toBe("vendor/x:free");
  });

  it.each([401, 402])("%i on OpenRouter is never retried on another OpenRouter model (same key/credits); the stub answers", async (status) => {
    const a = labelled(scriptedModel("vendor/a:free", [err(status)]), "openrouter");
    const b = labelled(scriptedModel("vendor/b:free", [text("must not be called")]), "openrouter");
    const r = await invokeWithFallback(chain(a, b), [new HumanMessage("portfolio overview")], { tools: null, turnSignal: signal() }, new RunRecorder());
    expect(b.calls).toHaveLength(0);
    expect(r).toMatchObject({ modelId: DEV_STUB_ID, usedLastResort: true });
    // The skipped model is reported to the per-turn circuit breaker, so later rounds skip it too.
    expect(r.failedModelIds).toEqual(["vendor/a:free", "vendor/b:free"]);
  });

  it("an unlabelled model after an account error is treated as the same account (never retried)", async () => {
    const a = labelled(scriptedModel("vendor/a:free", [err(402)]), "openrouter");
    const unknown = scriptedModel("unknown-provider", [text("must not be called")]);
    const e = await invokeWithFallback(chain(a, unknown, false), ask, { tools: null, turnSignal: signal() }, new RunRecorder()).catch((x) => x);
    expect(e).toBeInstanceOf(ModelUnavailableError);
    expect(unknown.calls).toHaveLength(0);
  });

  it("without a last resort, all failures still end in ModelUnavailableError (original semantics)", async () => {
    const gem = labelled(scriptedModel("gem-a", [err(503)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [err(503)]), "openrouter");
    const e = await invokeWithFallback(chain(gem, or, false), ask, { tools: null, turnSignal: signal() }, new RunRecorder()).catch((x) => x);
    expect(e).toBeInstanceOf(ModelUnavailableError);
    expect((e as ModelUnavailableError).causes).toHaveLength(2);
  });

  it("circuit breaker: models that failed earlier this turn are skipped, but the last link is always tried", async () => {
    const gem = labelled(scriptedModel("gem-a", [text("must not be called")]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [text("must not be called")]), "openrouter");
    const r = await invokeWithFallback(chain(gem, or), [new HumanMessage("portfolio overview")], { tools: null, turnSignal: signal(), skipModelIds: ["gem-a", "vendor/x:free"] }, new RunRecorder());
    expect(gem.calls).toHaveLength(0);
    expect(or.calls).toHaveLength(0);
    expect(r.modelId).toBe(DEV_STUB_ID);

    const onlyOne = labelled(scriptedModel("gem-solo", [text("still tried")]), "gemini");
    const solo = await invokeWithFallback({ primary: onlyOne, fallback: null, callTimeoutMs: 2_000 }, ask, { tools: null, turnSignal: signal(), skipModelIds: ["gem-solo"] }, new RunRecorder());
    expect(solo.modelId).toBe("gem-solo"); // nothing else to try, so it is not skipped
  });

  it("provider error text echoing keys is redacted in telemetry and in the error causes", async () => {
    const gem = labelled(scriptedModel("gem-a", [err(400, `bad key ${KEYS.GEMINI_API_KEY}`)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [err(400, `Authorization: Bearer ${KEYS.OPENROUTER_API_KEY}`)]), "openrouter");
    const rec = new RunRecorder();
    const e = await invokeWithFallback(chain(gem, or, false), ask, { tools: null, turnSignal: signal() }, rec).catch((x) => x);
    const everything = JSON.stringify(rec.llmCalls) + (e as ModelUnavailableError).causes.join(" ");
    for (const k of Object.values(KEYS)) expect(everything).not.toContain(k);
    expect(everything).toContain("[REDACTED]");
  });
});

describe("end-to-end chat turn with the mixed chain (scripted providers, in-memory store)", () => {
  it("per-turn circuit breaker across graph rounds: a failed Gemini is not called again in the same turn", async () => {
    const gem = labelled(scriptedModel("gem-a", [err(429)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [toolCall("portfolio_analytics", {}), text("Here is your overview.")]), "openrouter");
    const r = await handleChatTurn(
      { stores: freshStores(), router: { primary: gem, fallback: or, lastResort: createDevStubModel({ streamDelayMs: 0 }), callTimeoutMs: 2_000 }, historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "What does my portfolio look like?" },
    );
    expect(gem.calls).toHaveLength(1); // round 2 skipped it
    expect(r).toMatchObject({ status: "ok", reply: "Here is your overview.", telemetry: { fallbackUsed: true, model: "vendor/x:free" } });
    expect(r.needsAttention).toBe(false); // a normal fallback keeps the original semantics
  });

  it.each([401, 402])("%i: a same-provider fallback skipped in round 1 is not called in a later tool round either", async (status) => {
    // Round 1: Gemini primary gets an account error, the Gemini fallback is skipped (same key/credits),
    // and the stub answers with a tool call. Round 2 must not try the skipped Gemini fallback.
    const stores = freshStores();
    const gemA = labelled(scriptedModel("gem-a", [err(status)]), "gemini");
    const gemB = labelled(scriptedModel("gem-b", [text("must not be called")]), "gemini");
    const r = await handleChatTurn(
      { stores, router: { primary: gemA, fallback: gemB, lastResort: createDevStubModel({ streamDelayMs: 0 }), callTimeoutMs: 2_000 }, historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "What does my portfolio look like?" },
    );
    expect(gemA.calls).toHaveLength(1);
    expect(gemB.calls).toHaveLength(0);
    expect(r.status).toBe("ok");
    expect(r.reply).toMatch(/^\[dev stub — template reply, no LLM\]/);
    expect(r.telemetry).toMatchObject({ fallbackUsed: true, model: DEV_STUB_ID });
    expect(r.needsAttention).toBe(true);
    const trace = await getConversationTrace(stores, r.conversationId);
    expect(trace.conversation.attentionReason).toMatch(/^model_degraded/);
    const calls = trace.runs[0]!.llmCalls;
    expect(calls.filter((c) => c.model !== DEV_STUB_ID).map((c) => [c.model, c.ok])).toEqual([["gem-a", false]]);
    expect(calls.filter((c) => c.model === DEV_STUB_ID).length).toBeGreaterThanOrEqual(2); // tool round + answer
  });

  it("stub last resort: labelled reply, fallback metric set, conversation flagged and visible in the admin trace", async () => {
    const stores = freshStores();
    const gem = labelled(scriptedModel("gem-a", [err(503)]), "gemini");
    const or = labelled(scriptedModel("vendor/x:free", [err(429)]), "openrouter");
    const r = await handleChatTurn(
      { stores, router: { primary: gem, fallback: or, lastResort: createDevStubModel({ streamDelayMs: 0 }), callTimeoutMs: 2_000 }, historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "What does my portfolio look like?" },
    );
    expect(r.status).toBe("ok");
    expect(r.reply).toMatch(/^\[dev stub — template reply, no LLM\]/); // clearly identified
    expect(r.telemetry).toMatchObject({ fallbackUsed: true, model: DEV_STUB_ID });
    expect(r.needsAttention).toBe(true);
    expect(gem.calls).toHaveLength(1);
    expect(or.calls).toHaveLength(1);
    const trace = await getConversationTrace(stores, r.conversationId);
    expect(trace.conversation.attentionReason).toMatch(/^model_degraded/);
    expect(trace.runs[0]!.llmCalls.some((c) => c.lastResort && c.provider === "stub")).toBe(true);
  });
});
