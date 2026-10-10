# Decision Log

Each entry: decision, why, trade-off. Labels: **[fact]** comes from the brief or data; **[assumption]** is my interpretation.

## D1. A single tool-calling agent, no multi-agent setup
Every capability works on one user's small, structured portfolio. A router agent plus specialist agents would add an extra LLM hop per turn (latency and cost) and more handoff failure points, with no gain in accuracy.
**Trade-off:** the single agent's prompt and tool list must stay small and well described. Revisit if the number of tools grows beyond about 10–12.

## D2. LangGraph.js for orchestration (approved)
The agent loop (model ↔ tools), the step cap, and error edges are explicit graph structure, which is easy to explain and to trace.
**Trade-off:** it is heavier than a plain loop or the Vercel AI SDK. Mitigation: use a small custom graph rather than the prebuilt black-box agent.

## D3. PostgreSQL + Prisma, and SQL retrieval rather than vector search
The data is tabular and the questions are exact filters and aggregates: type, city, value thresholds. Embeddings would make answers that need to be precise less precise. Postgres also stores conversations, runs, tool calls and pending actions for the admin dashboard.
**Trade-off:** free-text questions about unstructured documents (leases, for example) would need RAG later. There are none in scope.

## D4. Money stored as BigInt whole rupees, numbers in domain code
Postgres `int4` overflows at about ₹214 Cr, which one large office could exceed. Domain code uses JS numbers after a safe-integer check, which is exact up to about ₹9×10¹⁴ Cr.
**Trade-off:** BigInt ↔ number conversion is needed at the repository boundary.

## D5. The LLM never does arithmetic, including unit conversion
Tools take money as `{amount, unit: INR|THOUSAND|LAKH|CRORE}` and the backend converts. All totals, shares, yields, rankings and scenario deltas come from `src/domain/analytics.ts` and `scenario.ts`. The model writes the explanation around those numbers.
**Why:** LLMs often miscount the zeros in "₹12.5 Cr". Deterministic code is testable; prompts are not.

## D6. Property type normalisation [fact + assumption]
- [fact] `Commercial Office` (P002, P007, P008) and `Office` (P011) describe the same kind of asset.
- Both map to `OFFICE`, and the raw label is kept for display and audit.
- [assumption] **COMMERCIAL = RETAIL + OFFICE.** This is standard industry usage, but the brief doesn't define it, so answers say so when they use it.
- Bare "Commercial" as a property type is rejected as ambiguous rather than guessed.

## D7. Location parsing [fact + assumption]
- [fact] `location` is free text, "Locality, City".
- [fact] P006 is `Alibaug, Maharashtra`, which has a state where the city should be.
- [assumption] When the last segment is a known state, the locality is used as the city, so P006's city is Alibaug. "Properties in Mumbai" therefore excludes it, which is correct geographically.
- "Delhi NCR" (U003's city) expands to the NCR cities so that region queries work.
- City matching is exact after aliasing (Bangalore → Bengaluru, Gurgaon → Gurugram). Locality matching is by substring ("Bandra" matches "Bandra West").

## D8. Missing data is reported, never guessed [fact]
- `purchase_price_inr` is blank for 12/12 rows. DATASET.md says "mostly", but the PDF and the CSV both have it blank throughout.
- There are no dates anywhere.
- Analytics return a `dataGaps` list, and the agent must not estimate appreciation or ROI.
- Seed inconsistencies, such as rent recorded on a vacant property, are **reported** in the seed log and never silently corrected. The seed data has none.

## D9. Yield and ranking conventions
- Gross yield = annual rent ÷ current estimated value. It is the only yield possible without cost data.
- Two portfolio yields are reported:
  - across all properties
  - across income-producing properties only, because vacant and self-occupied properties pull the overall figure down
- Zero-rent properties are excluded from rent and yield rankings and listed with the reason.
- Ties share a rank. A limit never splits a tie: U004's P010 and P011 are both exactly 7.50%.
- "Performing better" is ambiguous. The agent states which metric it used, and gives both rent and yield when they disagree (U001 retail: P001 has the higher rent, P003 the higher yield).

## D10. Ownership % and status applied even though they are uniform in the seed data
Totals use value × ownership%, and only `ACTIVE` rows are counted. It costs nothing and stays correct for data added through chat.

## D11. Propose → confirm for every write
- The agent can only create a `PendingAction`, which is validated, diffed and checked for duplicates.
- The change is applied only when **all** of these hold:
  - the action belongs to this user and this conversation
  - it is still PENDING and has not expired (15 min)
  - confirmation comes in a **later turn** than the proposal
  - the user's latest message is an unambiguous yes (deterministic check), **or** the user tapped Confirm, a code path with no LLM involved
- The write and the status change share one transaction. A compare-and-set on the status prevents applying twice, and updates use optimistic locking on `version`.
- A new proposal cancels the previous one.

**Trade-off:** one extra turn for every write. That is the right cost for changes to financial records.

## D12. Near-duplicate detection on create
The brief's own example ("5,000 sq ft retail in Bandra worth ₹12 Cr") matches the existing P001 (5,200 sq ft, Bandra West, ₹12 Cr). A create with the same class and city, an overlapping locality, and area or value within 15% is held back. The agent must ask whether this is an update or a separate property, and can retry with `allowDuplicate` only after the user says it is new.

## D13. User scoping through persistence interfaces
- Every store method takes `userId` and puts it in the WHERE clause.
- A property owned by another user is indistinguishable from one that doesn't exist (`null` / "not found"), so nothing about other users is revealed.
- Tool schemas will not have a `userId` parameter. It comes from the signed session.
- Filter and scenario schemas are `.strict()`, so the model cannot add fields such as `userId`.

## D14. In-memory store implementation alongside Prisma
It lets the confirmation and authorization logic be unit-tested without a database, and later allows offline agent evaluations.
**Trade-off:** two implementations must keep the same semantics. Integration tests against Postgres are planned to check this.

## D15. Pinned stable dependency versions
Prisma 6.19 rather than the 8.0 RC tagged `latest`, TypeScript 5.9 rather than 7.0 (the new native compiler), and Vitest 4. Toolchain churn is the riskiest use of a 1–2 day timebox.
