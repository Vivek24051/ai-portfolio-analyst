import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, secretKey, SessionConfigError, verifySessionToken } from "@/server/session";

const env = (over: Record<string, string | undefined>) => ({ ...over }) as NodeJS.ProcessEnv;
const STRONG = "a".repeat(16) + "b".repeat(16) + "c".repeat(8);

afterEach(() => vi.unstubAllEnvs());

describe("session secret policy", () => {
  it("production without SESSION_SECRET fails closed", () => {
    expect(() => secretKey(env({ NODE_ENV: "production" }))).toThrow(SessionConfigError);
  });

  it("unset NODE_ENV is treated as non-development", () => {
    expect(() => secretKey(env({}))).toThrow(/required outside local development/);
  });

  it("short secrets and the published dev value are rejected everywhere", () => {
    expect(() => secretKey(env({ NODE_ENV: "production", SESSION_SECRET: "too-short" }))).toThrow(/at least 32/);
    expect(() => secretKey(env({ NODE_ENV: "development", SESSION_SECRET: "short" }))).toThrow(/at least 32/);
    expect(() =>
      secretKey(env({ NODE_ENV: "production", SESSION_SECRET: "dev-only-insecure-session-secret-change-me-0123456789" })),
    ).toThrow(/published development value/);
  });

  it("development and test may use the dev-only fallback", () => {
    expect(secretKey(env({ NODE_ENV: "development" }))).toBeInstanceOf(Uint8Array);
    expect(secretKey(env({ NODE_ENV: "test" }))).toBeInstanceOf(Uint8Array);
  });

  it("a strong secret works in production", () => {
    expect(secretKey(env({ NODE_ENV: "production", SESSION_SECRET: STRONG }))).toBeInstanceOf(Uint8Array);
  });
});

describe("session tokens", () => {
  it("round-trips and rejects tampering or a different key", async () => {
    const token = await createSessionToken("U002");
    expect(await verifySessionToken(token)).toBe("U002");
    const [h, p, s] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "U001" })).toString("base64url");
    expect(await verifySessionToken(`${h}.${forgedPayload}.${s}`)).toBeNull();
    expect(await verifySessionToken(`${h}.${p}.${s}x`)).toBeNull();
    expect(await verifySessionToken("")).toBeNull();

    // A token signed with the dev key is invalid once a real secret is configured.
    vi.stubEnv("SESSION_SECRET", STRONG);
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("does not accept alg=none", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"U001"}').toString("base64url")}.`;
    expect(await verifySessionToken(none)).toBeNull();
  });
});
