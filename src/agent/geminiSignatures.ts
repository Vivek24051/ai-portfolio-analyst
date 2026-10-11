// Gemini "thought signatures" over the OpenAI-compatible endpoint.
//
// Gemini 3.x models attach an opaque signature to each tool call they make
// (`tool_calls[i].extra_content.google.thought_signature`) and reject the next request with HTTP 400
// ("Function call is missing a thought_signature") unless that signature is sent back on the same
// tool call. LangChain's OpenAI client drops `extra_content`, so this fetch wrapper:
//   1. records signatures from responses (JSON and streamed), keyed by tool-call id;
//   2. re-attaches them to the assistant tool calls in outgoing requests;
//   3. for a step whose signature is no longer known (history from before a restart, or written on
//      another server instance), sends Google's documented placeholder on the step's first call.
// Nothing else in the request or response is changed. Verified offline only (tests/geminiSignatures.test.ts).

/**
 * Placeholder signature Google documents for tool-call history that has no real signature (for
 * example a conversation started with another model). ASSUMPTION — not yet verified against a live
 * Gemini response.
 */
export const PLACEHOLDER_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const MAX_SIGNATURES = 500;
const MAX_SIGNATURE_LENGTH = 64_000;
const PENDING_WAIT_MS = 2_000;

/** Bounded tool-call id → signature store; the oldest entry is dropped when full. */
export class ThoughtSignatureStore {
  private readonly byId = new Map<string, string>();

  constructor(private readonly maxEntries = MAX_SIGNATURES) {}

  set(id: string, signature: string): void {
    if (!id || !signature || signature.length > MAX_SIGNATURE_LENGTH) return;
    this.byId.delete(id);
    this.byId.set(id, signature);
    while (this.byId.size > this.maxEntries) this.byId.delete(this.byId.keys().next().value!);
  }

  get(id: string): string | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }
}

/** One store per server process, shared by every Gemini model so a fallback model sees the history. */
const sharedStore = new ThoughtSignatureStore();

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const signatureOf = (toolCall: Json): string | undefined => {
  const google = isObj(toolCall.extra_content) && isObj(toolCall.extra_content.google) ? toolCall.extra_content.google : null;
  return typeof google?.thought_signature === "string" ? google.thought_signature : undefined;
};

/** Records signatures from a non-streamed chat completion. */
function recordFromCompletion(body: unknown, store: ThoughtSignatureStore): void {
  if (!isObj(body) || !Array.isArray(body.choices)) return;
  for (const choice of body.choices) {
    const calls = isObj(choice) && isObj(choice.message) && Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    for (const c of calls) if (isObj(c) && typeof c.id === "string") store.set(c.id, signatureOf(c) ?? "");
  }
}

/** Records signatures from an SSE stream: id and signature may arrive in different chunks of one call. */
function recordFromStream(text: string, store: ThoughtSignatureStore): void {
  const ids = new Map<string, string>(); // `${choice}:${index}` → id
  const sigs = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isObj(chunk) || !Array.isArray(chunk.choices)) continue;
    for (const choice of chunk.choices) {
      if (!isObj(choice) || !isObj(choice.delta) || !Array.isArray(choice.delta.tool_calls)) continue;
      for (const c of choice.delta.tool_calls) {
        if (!isObj(c)) continue;
        const key = `${String(choice.index ?? 0)}:${String(c.index ?? 0)}`;
        if (typeof c.id === "string" && c.id) ids.set(key, c.id);
        const sig = signatureOf(c);
        if (sig) sigs.set(key, sig);
      }
    }
  }
  for (const [key, sig] of sigs) {
    const id = ids.get(key);
    if (id) store.set(id, sig);
  }
}

/**
 * Puts signatures back on the assistant tool calls of an outgoing request body. Returns the new body,
 * or null when nothing needed changing. Each assistant step gets its known signatures; a step with no
 * known signature gets the placeholder on its first tool call (Gemini validates the first call of a step).
 */
export function addSignaturesToRequest(body: Json, store: ThoughtSignatureStore): Json | null {
  if (!Array.isArray(body.messages)) return null;
  let changed = false;
  const messages = body.messages.map((m) => {
    if (!isObj(m) || m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return m;
    const known = m.tool_calls.map((c) => (isObj(c) ? (signatureOf(c) ?? (typeof c.id === "string" ? store.get(c.id) : undefined)) : undefined));
    const anyKnown = known.some(Boolean);
    const toolCalls = m.tool_calls.map((c, i) => {
      if (!isObj(c) || signatureOf(c)) return c;
      const sig = known[i] ?? (!anyKnown && i === 0 ? PLACEHOLDER_THOUGHT_SIGNATURE : undefined);
      if (!sig) return c;
      changed = true;
      const extra = isObj(c.extra_content) ? c.extra_content : {};
      const google = isObj(extra.google) ? extra.google : {};
      return { ...c, extra_content: { ...extra, google: { ...google, thought_signature: sig } } };
    });
    return { ...m, tool_calls: toolCalls };
  });
  return changed ? { ...body, messages } : null;
}

/**
 * Wraps fetch for the Gemini client: re-attaches signatures to requests and records them from
 * responses. The base fetch is resolved per call, so a test's stubbed global fetch is honoured.
 */
export function withThoughtSignatures(base?: typeof fetch, store: ThoughtSignatureStore = sharedStore): typeof fetch {
  const pending = new Set<Promise<void>>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // A previous streamed response may still be being scanned: finish recording before reusing history.
    // Bounded: a hung or abandoned stream must never block the next request.
    if (pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PENDING_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    let outInit = init;
    if (typeof init?.body === "string") {
      try {
        const parsed: unknown = JSON.parse(init.body);
        const rewritten = isObj(parsed) ? addSignaturesToRequest(parsed, store) : null;
        if (rewritten) outInit = { ...init, body: JSON.stringify(rewritten) };
      } catch {
        // Not JSON: send unchanged.
      }
    }
    const response = await (base ?? globalThis.fetch)(input, outInit);
    if (!response.ok || !response.body) return response;
    const type = response.headers.get("content-type") ?? "";
    const copy = response.clone();
    const work = (async () => {
      try {
        if (type.includes("text/event-stream")) recordFromStream(await copy.text(), store);
        else if (type.includes("json")) recordFromCompletion(await copy.json(), store);
      } catch {
        // Recording is best-effort; the original response is unaffected.
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return response;
  }) as typeof fetch;
}
