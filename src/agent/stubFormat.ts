// Readable replies for the DEV STUB (no LLM). Fixed templates over the tool's own output:
// every figure is copied verbatim from the tool result, nothing is computed or invented, so the
// numeric-faithfulness check still holds. A real model would phrase answers itself.

type Json = Record<string, any>;

const LABEL = "[dev stub — template reply, no LLM]";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function propertyLine(p: Json): string {
  // Skip a sub-type that only repeats the type ("Office" / "Office").
  const base = String(p.type).split(" ")[0]!.toLowerCase();
  const type = p.subType && String(p.subType).toLowerCase() !== base ? `${p.type} — ${p.subType}` : p.type;
  const rent = p.annualRent && p.annualRent !== "none" ? ` · rent ${p.annualRent}/yr` : " · no rent";
  const yieldPart = p.grossYield ? ` · yield ${p.grossYield}` : "";
  const rank = typeof p.rank === "number" ? `#${p.rank} ` : "";
  return `- ${rank}**${p.id}**: ${type}, ${p.location} · **${p.value}**${rent}${yieldPart} · ${p.occupancy}`;
}

function bucketLines(buckets: Json[] | undefined): string[] {
  return (buckets ?? []).map((b) => `- ${b.group}: **${b.value}** (${b.shareOfValue}) · ${plural(b.count, "property", "properties")}`);
}

function formatAnalytics(r: Json): string {
  const parts: string[] = [];
  const t = r.totals;
  if (t) {
    const scope = r.shareOfWholePortfolioValue ? ` (${r.shareOfWholePortfolioValue} of your portfolio)` : "";
    const yields = t.grossYieldAllProperties
      ? ` Gross yield ${t.grossYieldAllProperties}${t.grossYieldIncomeProducingOnly ? ` (${t.grossYieldIncomeProducingOnly} on rent-earning properties)` : ""}.`
      : "";
    parts.push(`You own **${plural(t.properties, "property", "properties")}** worth **${t.totalValue}**${scope}, earning **${t.annualRent}** a year in rent.${yields}`);
  }
  for (const [title, key] of [
    ["By type", "byAssetClass"],
    ["By city", "byCity"],
    ["By occupancy", "byOccupancy"],
  ] as const) {
    const lines = bucketLines(r[key]);
    if (lines.length) parts.push(`**${title}**`, lines.join("\n"));
  }
  const top = (list: Json[] | undefined, label: string, field: "value" | "annualRent") =>
    list?.length ? `${label}: ${list.map((p) => `${p.id} (${p.location}) at ${p[field]}`).join(", ")}.` : null;
  const extremes = [top(r.highestValue, "Highest value", "value"), top(r.lowestValue, "Lowest value", "value"), top(r.highestRent, "Highest rent", "annualRent")].filter(Boolean);
  if (extremes.length) parts.push(extremes.join(" "));
  if (Array.isArray(r.dataGaps) && r.dataGaps.length) {
    parts.push("Note: no purchase prices or dates are recorded, so appreciation and ROI can't be calculated.");
  }
  return parts.join("\n\n");
}

function formatSearch(r: Json): string {
  const props: Json[] = r.properties ?? [];
  if (props.length === 0) return "No properties in your portfolio match that.";
  const parts: string[] = [];
  if (r.rankedBy) {
    parts.push(`Ranked by ${r.rankedBy}${r.topIsTied ? " — **tie for first place**" : ""}:`);
  } else {
    parts.push(`Found **${plural(r.matchCount ?? props.length, "property", "properties")}**:`);
  }
  parts.push(props.map(propertyLine).join("\n"));
  const excluded: Json[] = r.excludedFromRanking ?? [];
  if (excluded.length) parts.push(`Not ranked: ${excluded.map((e) => `${e.propertyId} — ${e.reason}`).join("; ")}.`);
  return parts.join("\n\n");
}

/** Turns one tool result into readable text; falls back to a short notice for unknown shapes. */
export function formatToolResultForStub(toolName: string | undefined, content: string): string {
  let r: Json;
  try {
    r = JSON.parse(content) as Json;
  } catch {
    return `${LABEL}\n\nThe tool returned an unexpected result.`;
  }
  let body: string;
  if (typeof r.error === "string") body = `That lookup didn't work (${r.error}). Try rephrasing.`;
  else if (toolName === "portfolio_analytics") body = formatAnalytics(r);
  else if (toolName === "search_properties") body = formatSearch(r);
  else body = `The ${toolName ?? "tool"} step finished.`;
  return `${LABEL}\n\n${body}`;
}
