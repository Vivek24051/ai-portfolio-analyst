// Readable replies for the DEV STUB (no LLM). Fixed templates over the tool's own output:
// every figure is copied verbatim from the tool result, nothing is computed or invented, so the
// numeric-faithfulness check still holds. A real model would phrase answers itself.

type Json = Record<string, any>;

const LABEL = "[dev stub — template reply, no LLM]";

/** Questions about gains over time. The data has no purchase dates, so these get an honest "can't". */
export const APPRECIATION_QUESTION =
  /apprecia|\broi\b|return on (my )?invest|capital gain|since (i |we )?(bought|purchas)|purchase price|(gain(ed)?|profit) since/i;

/** What the stub knows about the turn besides the tool output: the question and the call's arguments. */
export interface StubFormatHint {
  question?: string;
  args?: Json;
}

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

const SUBSET_LABELS: Record<string, string> = { RETAIL: "Retail", OFFICE: "Office", RESIDENTIAL: "Residential" };

function subsetLabel(args: Json | undefined): string {
  const f = args?.filter ?? {};
  if (f.sector === "COMMERCIAL") return "Commercial (retail + office)";
  if (f.sector === "RESIDENTIAL") return "Residential";
  const classes: string[] = f.assetClasses ?? [];
  return classes.length ? classes.map((c) => SUBSET_LABELS[c] ?? c).join(" + ") : "That part of your portfolio";
}

/** "How much of my portfolio is retail?": the slice, the whole and the share, all from one tool result. */
function formatShare(r: Json, args: Json | undefined): string {
  const t = r.totals;
  const whole = r.wholePortfolio;
  const label = subsetLabel(args);
  if (!t.properties) {
    return `You have no ${label.toLowerCase()} properties, so they are **${r.shareOfWholePortfolioValue}** of your **${whole.totalValue}** portfolio.`;
  }
  const lines = [
    `**${label} is ${r.shareOfWholePortfolioValue} of your portfolio by value**: **${t.totalValue}** out of a total **${whole.totalValue}**, ` +
      `across **${t.properties} of your ${plural(whole.properties, "property", "properties")}**.`,
  ];
  if (t.annualRent) {
    const y = t.grossYieldAllProperties ? ` (gross yield ${t.grossYieldAllProperties})` : "";
    lines.push(`${t.properties === 1 ? "It earns" : "Together they earn"} **${t.annualRent}** a year in rent${y}.`);
  }
  return lines.join(" ");
}

/** Appreciation / ROI: say plainly that it can't be calculated and why; current value is context only. */
function formatAppreciation(r: Json): string {
  const gaps: string[] = Array.isArray(r.dataGaps) ? r.dataGaps : [];
  const parts = [
    "**I can't calculate your portfolio's appreciation or ROI.** The data it needs isn't recorded, and I won't estimate it:",
    gaps.length ? gaps.map((g) => `- ${g}`).join("\n") : "- No purchase prices or purchase dates are recorded.",
  ];
  if (r.totals) {
    parts.push(`For context only (this is today's estimate, not a gain): your ${plural(r.totals.properties, "property is", "properties are")} currently valued at **${r.totals.totalValue}**.`);
  }
  return parts.join("\n\n");
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

const RANK_FIELDS: Record<string, { field: string; label: string; suffix: string }> = {
  rent: { field: "annualRent", label: "annual rent", suffix: " a year" },
  yield: { field: "grossYield", label: "gross yield", suffix: "" },
  value: { field: "value", label: "value", suffix: "" },
};

/** One-sentence answer on top of a ranking ("P001 earns more annual rent: ₹72 L a year, vs ₹60 L a year for P003."). */
function rankingHeadline(r: Json, props: Json[]): string | null {
  const m = RANK_FIELDS[String(r.rankedBy).split(" ")[0]!];
  if (!m) return null;
  const lowest = String(r.rankedBy).includes("lowest");
  const fig = (p: Json) => `${p[m.field]}${m.suffix}`;
  const [a, b] = props;
  if (!a) return null;
  if (r.topIsTied) {
    const tied = props.filter((p) => p.rank === a.rank).map((p) => `**${p.id}**`);
    return `${tied.join(" and ")} tie for the ${lowest ? "lowest" : "highest"} ${m.label}: **${fig(a)}** each.`;
  }
  if (props.length === 2 && b) {
    const verb = m.field === "annualRent" ? (lowest ? "earns less annual rent" : "earns more annual rent") : `has the ${lowest ? "lower" : "higher"} ${m.label}`;
    return `**${a.id}** ${verb}: **${fig(a)}**, vs ${fig(b)} for ${b.id}.`;
  }
  return `**${a.id}** has the ${lowest ? "lowest" : "highest"} ${m.label}: **${fig(a)}**.`;
}

function formatSearch(r: Json): string {
  const props: Json[] = r.properties ?? [];
  if (props.length === 0) return "No properties in your portfolio match that.";
  const parts: string[] = [];
  if (r.rankedBy) {
    const headline = rankingHeadline(r, props);
    if (headline) parts.push(headline);
    parts.push(`Ranked by ${r.rankedBy}${r.topIsTied ? " — **tie for first place**" : ""}:`);
  } else {
    parts.push(`Found **${plural(r.matchCount ?? props.length, "property", "properties")}**:`);
  }
  parts.push(props.map(propertyLine).join("\n"));
  const excluded: Json[] = r.excludedFromRanking ?? [];
  if (excluded.length) parts.push(`Not ranked: ${excluded.map((e) => `${e.propertyId} — ${e.reason}`).join("; ")}.`);
  return parts.join("\n\n");
}

const unchanged = (delta: string | null | undefined) => !delta || delta === "₹0" || delta === "0 pp";

/** What-if: per-property before → after, then the portfolio totals, always labelled hypothetical. */
function formatScenario(r: Json): string | null {
  if (!r.hypothetical || !r.baseline?.totals || !r.scenario?.totals) return null;
  const parts = ["**Hypothetical — nothing is saved; your real portfolio is unchanged.**"];
  const lines: string[] = (r.propertyChanges ?? []).map(
    (c: Json) =>
      `- ${c.propertyId} ${c.field === "annualRent" ? "annual rent" : "value"}: ${c.before} → **${c.after}**${c.field === "annualRent" ? " a year" : ""} (${c.change})`,
  );
  for (const d of (r.changes ?? []) as string[]) if (d.startsWith("Excluded") || d.startsWith("Added")) lines.push(`- ${d}`);
  if (lines.length) parts.push(lines.join("\n"));

  const b = r.baseline.totals;
  const s = r.scenario.totals;
  const row = (label: string, before: string, after: string, delta: string | null) =>
    `- ${label}: ${before} → **${after}** (${unchanged(delta) ? "unchanged" : delta})`;
  parts.push(
    "**Portfolio effect**",
    [
      row("Annual rent", b.annualRent, s.annualRent, r.deltas?.annualRent),
      row("Total value", b.totalValue, s.totalValue, r.deltas?.totalValue),
      ...(b.grossYieldAllProperties && s.grossYieldAllProperties ? [row("Gross yield", b.grossYieldAllProperties, s.grossYieldAllProperties, r.deltas?.grossYield)] : []),
    ].join("\n"),
  );
  parts.push("To make a real change, ask me to update the property; I'll show the change and wait for your confirmation.");
  return parts.join("\n\n");
}

/** A staged change (not saved): the diff exactly as the backend produced it, then how to confirm. */
function formatProposal(r: Json, args: Json | undefined): string | null {
  const id = args?.propertyId ?? r.propertyId;
  switch (r.status) {
    case "proposed":
      return [
        "**Proposed change — not saved yet.**",
        (r.diff ?? []).map((d: Json) => `- ${r.propertyId ?? "New property"} · ${d.label}: ${d.before ?? "—"} → **${d.after}**`).join("\n"),
        "Reply **yes** to save it or **cancel** to discard it (or use the buttons below). Nothing changes until you confirm, and the proposal expires if left unconfirmed.",
      ].join("\n\n");
    case "not_found":
      // Same wording whether the id is unknown or another user's: nothing about it is revealed.
      return `I couldn't find ${id ?? "that property"} in your portfolio, so nothing was changed.`;
    case "invalid":
    case "needs_info":
      return `I couldn't propose that change: ${[...(r.errors ?? []), ...(r.missing ?? []).map((m: string) => `missing ${m}`)].join("; ")}. Nothing was changed.`;
    default:
      return null;
  }
}

function formatConfirmation(r: Json): string {
  if (r.status === "confirmed" && r.property) return `**Saved.** ${r.property.id} is updated:\n\n${propertyLine(r.property)}`;
  return `Nothing was saved: ${r.message ?? r.status}`;
}

function formatCancellation(r: Json): string {
  return r.status === "cancelled" ? "Cancelled — nothing was changed." : "There was no pending change to cancel, so nothing was changed.";
}

/** Turns one tool result into readable text; falls back to a short notice for unknown shapes. */
export function formatToolResultForStub(toolName: string | undefined, content: string, hint: StubFormatHint = {}): string {
  let r: Json;
  try {
    r = JSON.parse(content) as Json;
  } catch {
    return `${LABEL}\n\nThe tool returned an unexpected result.`;
  }
  let body: string;
  // Scenario messages only echo the ids the user typed ("not found in this portfolio"), so they are safe to show.
  if (r.error === "invalid_scenario" && typeof r.message === "string") body = `I couldn't run that what-if: ${r.message}.`;
  else if (typeof r.error === "string") body = `That lookup didn't work (${r.error}). Try rephrasing.`;
  else if (toolName === "portfolio_analytics" && APPRECIATION_QUESTION.test(hint.question ?? "")) body = formatAppreciation(r);
  else if (toolName === "portfolio_analytics" && r.wholePortfolio && r.totals) body = formatShare(r, hint.args);
  else if (toolName === "portfolio_analytics") body = formatAnalytics(r);
  else if (toolName === "search_properties") body = formatSearch(r);
  else if (toolName === "propose_property_update" && formatProposal(r, hint.args)) body = formatProposal(r, hint.args)!;
  else if (toolName === "confirm_pending_action") body = formatConfirmation(r);
  else if (toolName === "cancel_pending_action") body = formatCancellation(r);
  else body = (toolName === "run_scenario" ? formatScenario(r) : null) ?? `The ${toolName ?? "tool"} step finished.`;
  return `${LABEL}\n\n${body}`;
}
