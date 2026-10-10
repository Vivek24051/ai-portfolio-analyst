// Dev stub template replies: readable, built only from tool output (no LLM, no network).
import { describe, expect, it } from "vitest";
import { checkNumericFaithfulness } from "@/agent/faithfulness";
import { createDevStubModel } from "@/agent/devStubModel";
import { formatToolResultForStub } from "@/agent/stubFormat";
import { handleChatTurn } from "@/server/services/chatService";
import { freshStores } from "./agentHelpers";

const deps = () => ({
  stores: freshStores(),
  router: { primary: createDevStubModel({ streamDelayMs: 0 }), fallback: null, callTimeoutMs: 5_000 },
  historyLimit: 30,
  turnDeadlineMs: 10_000,
});

describe("dev stub template replies", () => {
  it("portfolio overview is readable prose with the real figures, not raw JSON", async () => {
    const r = await handleChatTurn(deps(), { userId: "U001", message: "What does my portfolio look like?" });
    expect(r.reply).toMatch(/^\[dev stub — template reply, no LLM\]/);
    expect(r.reply).toContain("You own **3 properties** worth **₹29.7 Cr**, earning **₹1.32 Cr** a year in rent.");
    expect(r.reply).toContain("- Retail: **₹21.2 Cr** (71.38%) · 2 properties");
    expect(r.reply).not.toContain('{"');
    expect(r.needsAttention).toBe(false); // every figure traces to tool output
  });

  it("search results list one line per property; ties and exclusions are stated", async () => {
    const yieldReply = (await handleChatTurn(deps(), { userId: "U004", message: "Which property has the best yield?" })).reply;
    expect(yieldReply).toContain("tie for first place");
    expect(yieldReply).toContain("- #1 **P010**: Retail — Mall retail, Whitefield, Bengaluru · **₹4.8 Cr** · rent ₹36 L/yr · yield 7.5% · Tenanted");
    expect(yieldReply).toContain("Not ranked: P012 — no rental income (Self-occupied).");

    const rentReply = (await handleChatTurn(deps(), { userId: "U003", message: "Which property has the highest rent?" })).reply;
    expect(rentReply).toContain('**P007**: Office (recorded as "Commercial Office"), Golf Course Road, Gurugram');

    const mumbai = (await handleChatTurn(deps(), { userId: "U002", message: "Show me my properties in Mumbai" })).reply;
    expect(mumbai).toContain("Found **2 properties**");
    expect(mumbai).not.toContain("P006");
  });

  it("templates never introduce numbers that are not in the tool output", () => {
    const tool = JSON.stringify({
      scope: "whole portfolio",
      totals: { properties: 1, totalValue: "₹4.8 Cr", annualRent: "₹36 L", grossYieldAllProperties: "7.5%", grossYieldIncomeProducingOnly: "7.5%" },
      byAssetClass: [{ group: "Retail", count: 1, value: "₹4.8 Cr", shareOfValue: "100%" }],
      dataGaps: ["…"],
    });
    const text = formatToolResultForStub("portfolio_analytics", tool);
    expect(checkNumericFaithfulness(text, [tool]).unsupported).toEqual([]);
  });

  it("errors, empty results and unknown tools get short readable messages", () => {
    expect(formatToolResultForStub("search_properties", '{"error":"invalid_arguments"}')).toContain("didn't work (invalid_arguments)");
    expect(formatToolResultForStub("search_properties", '{"matchCount":0,"properties":[]}')).toContain("No properties in your portfolio match that.");
    expect(formatToolResultForStub("run_scenario", "{}")).toContain("The run_scenario step finished.");
    expect(formatToolResultForStub("x", "not json")).toContain("unexpected result");
  });
});
