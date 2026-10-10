// Provider selection, especially LLM_PROVIDER=stub (forced dev stub). Offline: global fetch is
// replaced by a spy so any attempted network request would be recorded (and fail).
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "@/agent/config";
import { DEV_STUB_ID } from "@/agent/devStubModel";
import { createRouter } from "@/server/container";
import { handleChatTurn } from "@/server/services/chatService";
import { freshStores } from "./agentHelpers";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
const BOTH_KEYS = { GEMINI_API_KEY: "g-key-not-real", OPENROUTER_API_KEY: "o-key-not-real", LLM_PRIMARY_MODEL: "some-model", LLM_FALLBACK_MODEL: "other-model" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LLM_PROVIDER=stub forces the dev stub", () => {
  it.each(["stub", "STUB", "  Stub  "])("%j wins over Gemini and OpenRouter keys", (value) => {
    const r = createRouter(loadAgentConfig(env({ LLM_PROVIDER: value, ...BOTH_KEYS })));
    expect(r.modelMode).toBe("dev-stub");
    expect(r.router.primary.id).toBe(DEV_STUB_ID);
    expect(r.router.fallback).toBeNull();
  });

  it("a full chat turn makes no external request (fetch never called)", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { router } = createRouter(loadAgentConfig(env({ LLM_PROVIDER: "stub", ...BOTH_KEYS })));
    const r = await handleChatTurn(
      { stores: freshStores(), router, historyLimit: 30, turnDeadlineMs: 10_000 },
      { userId: "U001", message: "What does my portfolio look like?" },
      () => {}, // streaming path, as in the UI
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "ok", telemetry: { model: DEV_STUB_ID } });
    expect(r.reply).toMatch(/^\[dev stub — template reply, no LLM\]/);
  });
});

describe("fail-safe for unrecognised values", () => {
  it.each(["none", "gemni", "openai", "claude"])("LLM_PROVIDER=%j with keys present → stub, with a generic warning", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = createRouter(loadAgentConfig(env({ LLM_PROVIDER: value, ...BOTH_KEYS })));
    expect(r.modelMode).toBe("dev-stub");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognised LLM_PROVIDER value; using the dev stub"));
  });

  it("a secret-like invalid setting is never emitted to logs (regression: LOW 4)", () => {
    const secretLike = "sk-or-v1-0123456789abcdefSECRET";
    const logged: string[] = [];
    const capture = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    for (const level of ["warn", "error", "info", "log"] as const) vi.spyOn(console, level).mockImplementation(capture);
    const r = createRouter(loadAgentConfig(env({ LLM_PROVIDER: secretLike, ...BOTH_KEYS })));
    expect(r.modelMode).toBe("dev-stub");
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain("0123456789abcdef");
      expect(line.toLowerCase()).not.toContain(secretLike.toLowerCase());
    }
  });
});

describe("unchanged behaviour when LLM_PROVIDER is omitted or explicit", () => {
  it("omitted, no keys → stub", () => {
    expect(createRouter(loadAgentConfig(env({}))).modelMode).toBe("dev-stub");
  });

  it("omitted with an OpenRouter key → OpenRouter (legacy rule; constructing the client makes no request)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = createRouter(loadAgentConfig(env({ OPENROUTER_API_KEY: "o", LLM_PRIMARY_MODEL: "m" })));
    expect(r.modelMode).toBe("openrouter");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explicit gemini / openrouter select their provider", () => {
    expect(createRouter(loadAgentConfig(env({ LLM_PROVIDER: "gemini", ...BOTH_KEYS }))).modelMode).toBe("gemini");
    expect(createRouter(loadAgentConfig(env({ LLM_PROVIDER: "openrouter", ...BOTH_KEYS }))).modelMode).toBe("openrouter");
  });

  it("explicit openrouter without its key → stub, not another provider", () => {
    expect(createRouter(loadAgentConfig(env({ LLM_PROVIDER: "openrouter", GEMINI_API_KEY: "g", LLM_PRIMARY_MODEL: "m" }))).modelMode).toBe("dev-stub");
  });
});
