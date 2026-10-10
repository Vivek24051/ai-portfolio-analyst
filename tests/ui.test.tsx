// @vitest-environment jsdom
// UI component tests (React Testing Library + jsdom). The network is MOCKED: fetch returns canned
// API responses, including a streamed SSE body. No server, no LLM.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "@/agent/events";
import { ChatApp } from "@/components/ChatApp";
import { MessageBubble } from "@/components/MessageBubble";
import { PendingActionCard } from "@/components/PendingActionCard";
import { encodeSse } from "@/lib/sse";
import type { ChatTurnResult, PendingActionView } from "@/server/services/chatService";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Whitespace-normalised text assertion (avoids a jest-dom dependency). */
function expectText(el: Element | null, expected: string) {
  expect((el?.textContent ?? "").replace(/\s+/g, " ")).toContain(expected);
}

const at = new Date().toISOString();
const future = new Date(Date.now() + 10 * 60_000).toISOString();
const pending: PendingActionView = {
  id: "PA1",
  type: "UPDATE_PROPERTY",
  propertyId: "P001",
  diff: [{ field: "currentValueInr", label: "Current value", before: "₹12 Cr", after: "₹12.5 Cr" }],
  expiresAt: future,
};

const result = (over: Partial<ChatTurnResult> = {}): ChatTurnResult => ({
  conversationId: "C1",
  runId: "r1",
  reply: "ok",
  status: "ok",
  pendingAction: null,
  hypothetical: false,
  handoff: false,
  toolActivity: [],
  needsAttention: false,
  telemetry: { totalMs: 1, llmMs: 0, toolMs: 0, llmCalls: 1, toolCalls: 0, toolRounds: 0, model: "m", fallbackUsed: false },
  ...over,
});

describe("MessageBubble", () => {
  it("marks hypothetical answers clearly", () => {
    render(
      <MessageBubble
        message={{ id: "1", role: "assistant", text: "Without Bandra: **₹17.7 Cr**", createdAt: at, hypothetical: true, toolActivity: [] }}
      />,
    );
    expectText(screen.getByRole("note"), "Hypothetical scenario — your real portfolio is unchanged");
    expect(screen.getByText("₹17.7 Cr").tagName).toBe("STRONG");
  });

  it("renders model text safely (no HTML injection)", () => {
    const { container } = render(
      <MessageBubble
        message={{ id: "1", role: "assistant", text: '<img src=x onerror="alert(1)"><script>alert(1)</script>', createdAt: at, hypothetical: false, toolActivity: [] }}
      />,
    );
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders bullet lists and collapsible tool activity", () => {
    render(
      <MessageBubble
        message={{
          id: "1",
          role: "assistant",
          text: "Your retail:\n\n- P001 Bandra\n- P003 Lower Parel",
          createdAt: at,
          hypothetical: false,
          toolActivity: [{ name: "search_properties", label: "Looking up your properties", ok: true, summary: "2 matches" }],
        }}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /1 step/ }));
    expect(screen.getByText("2 matches")).toBeTruthy();
  });
});

describe("RichText: lists that follow a heading line (Gemini style)", () => {
  it("renders '* ' lines under 'Key highlights:' as a bullet list, not literal asterisks", () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: "1",
          role: "assistant",
          text: "Your portfolio has 3 properties.\n\nKey highlights:\n* **Asset Class:** 71.38% Retail\n* **Occupancy:** 28.62% Vacant\n\nPlease note purchase prices are missing.",
          createdAt: at,
          hypothetical: false,
          toolActivity: [],
        }}
      />,
    );
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["Asset Class: 71.38% Retail", "Occupancy: 28.62% Vacant"]);
    expect(container.textContent).not.toContain("* ");
    expect(container.textContent).toContain("Key highlights:");
    expect(container.querySelector("li strong")?.textContent).toBe("Asset Class:");
  });
});

describe("PendingActionCard", () => {
  it("shows the before/after diff and wires Confirm / Edit / Cancel", () => {
    const onConfirm = vi.fn();
    const onEdit = vi.fn();
    const onCancel = vi.fn();
    render(<PendingActionCard action={pending} busy={false} onConfirm={onConfirm} onEdit={onEdit} onCancel={onCancel} />);
    const card = screen.getByTestId("pending-card");
    expectText(card, "Update P001?");
    expectText(card, "Not saved yet");
    expectText(card, "₹12 Cr → ₹12.5 Cr");
    fireEvent.click(screen.getByRole("button", { name: /Confirm/ }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect([onConfirm, onEdit, onCancel].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("disables actions once expired", () => {
    render(<PendingActionCard action={{ ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() }} busy={false} onConfirm={vi.fn()} onEdit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
    expect(screen.getByText(/proposal expired/)).toBeTruthy();
  });
});

// ---------- ChatApp end-to-end against a mocked fetch ----------

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function sseResponse(events: ChatStreamEvent[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(encoder.encode(encodeSse(e)));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw new Error(`unmocked ${method} ${url}`);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const users = [
  { id: "U001", name: "Rahul Mehta", city: "Mumbai" },
  { id: "U002", name: "Priya Shah", city: "Mumbai" },
];

describe("ChatApp", () => {
  it("demo sign-in: picking a user posts only the user id, then shows the chat", async () => {
    let current: string | null = null;
    const calls = mockFetch({
      "GET /api/session": () => jsonRes({ currentUserId: current, users, modelMode: "dev-stub", dataBackend: "memory" }),
      "POST /api/session": () => {
        current = "U001";
        return jsonRes({ currentUserId: "U001" });
      },
      "GET /api/conversations": () => jsonRes({ conversations: [] }),
    });
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Rahul Mehta/ }));
    expect(await screen.findByText(/Hi Rahul!/)).toBeTruthy();
    expectText(screen.getByRole("status"), "Demo mode");
    expect(calls.find((c) => c.url === "POST /api/session")?.body).toEqual({ userId: "U001" });
  });

  it("streams a reply, shows a proposal card, and confirms via the button endpoint", async () => {
    const calls = mockFetch({
      "GET /api/session": () => jsonRes({ currentUserId: "U001", users, modelMode: "openrouter", dataBackend: "prisma" }),
      "GET /api/conversations": () => jsonRes({ conversations: [] }),
      "POST /api/chat/stream": () =>
        sseResponse([
          { type: "start", conversationId: "C1", runId: "r1" },
          { type: "tool_start", callId: "t1", name: "propose_property_update", label: "Preparing a change for your confirmation" },
          { type: "tool_end", callId: "t1", name: "propose_property_update", ok: true, summary: "awaiting your confirmation" },
          { type: "delta", text: "I'll update P001 to ₹12.5 Cr. " },
          { type: "delta", text: "Shall I go ahead?" },
          {
            type: "done",
            result: result({
              reply: "I'll update P001 to ₹12.5 Cr. Shall I go ahead?",
              pendingAction: pending,
              toolActivity: [{ name: "propose_property_update", label: "Preparing a change for your confirmation", ok: true, summary: "awaiting your confirmation" }],
            }),
          },
        ]),
      "POST /api/chat/actions": () => jsonRes(result({ runId: "r2", reply: "✅ Saved. P001 (Bandra West, Mumbai) is updated." })),
    });
    render(<ChatApp />);
    const input = await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByRole("status")).toBeNull(); // no demo banner with a real model configured

    fireEvent.change(input, { target: { value: "Change my Bandra retail property value to ₹12.5 crore" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const card = await screen.findByTestId("pending-card");
    expectText(card, "₹12 Cr → ₹12.5 Cr");
    expect(screen.getByText("I'll update P001 to ₹12.5 Cr. Shall I go ahead?")).toBeTruthy();
    // The request carried only the message — no user id, no conversation yet.
    expect(calls.find((c) => c.url === "POST /api/chat/stream")?.body).toEqual({ message: "Change my Bandra retail property value to ₹12.5 crore" });

    fireEvent.click(within(card).getByRole("button", { name: /Confirm/ }));
    expect(await screen.findByText("✅ Saved. P001 (Bandra West, Mumbai) is updated.")).toBeTruthy();
    expect(screen.queryByTestId("pending-card")).toBeNull();
    expect(calls.find((c) => c.url === "POST /api/chat/actions")?.body).toEqual({ conversationId: "C1", pendingActionId: "PA1", decision: "confirm" });
  });

  it("Edit prefills the composer instead of saving", async () => {
    mockFetch({
      "GET /api/session": () => jsonRes({ currentUserId: "U001", users, modelMode: "dev-stub", dataBackend: "memory" }),
      "GET /api/conversations": () => jsonRes({ conversations: [{ id: "C1", lastMessageAt: at, preview: "Confirm?" }] }),
      "GET /api/conversations/C1": () => jsonRes({ id: "C1", messages: [], pendingAction: pending }),
    });
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Confirm\?/ })); // open conversation from sidebar
    const card = await screen.findByTestId("pending-card");
    fireEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Change the proposal: "));
  });

  it("network failure shows a retryable error; Retry re-sends without duplicating the message", async () => {
    let attempt = 0;
    mockFetch({
      "GET /api/session": () => jsonRes({ currentUserId: "U001", users, modelMode: "dev-stub", dataBackend: "memory" }),
      "GET /api/conversations": () => jsonRes({ conversations: [] }),
      "POST /api/chat/stream": () => {
        attempt++;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return sseResponse([
          { type: "start", conversationId: "C1", runId: "r1" },
          { type: "done", result: result({ reply: "Your portfolio is ₹29.7 Cr." }) },
        ]);
      },
    });
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "What does my portfolio look like?" }));
    expectText(await screen.findByRole("alert"), "Couldn't reach the server");
    expect(screen.getByText("Not sent")).toBeTruthy();

    await act(async () => fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" })));
    expect(await screen.findByText("Your portfolio is ₹29.7 Cr.")).toBeTruthy();
    expect(screen.getAllByText("What does my portfolio look like?").filter((el) => el.closest("[data-testid='msg-user']"))).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rate limit (429) is shown as a friendly error", async () => {
    mockFetch({
      "GET /api/session": () => jsonRes({ currentUserId: "U001", users, modelMode: "dev-stub", dataBackend: "memory" }),
      "GET /api/conversations": () => jsonRes({ conversations: [] }),
      "POST /api/chat/stream": () => jsonRes({ error: { code: "rate_limited", message: "Too many messages. Please wait a moment." } }, 429),
    });
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Which property generates the most rent?" }));
    expectText(await screen.findByRole("alert"), "Too many messages. Please wait a moment.");
  });
});
