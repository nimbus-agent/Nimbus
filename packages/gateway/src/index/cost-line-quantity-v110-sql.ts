/**
 * V110 - `cost_line` consumed quantity and the `priced` flag (Phase 7, the Cost Pack, slice 8).
 *
 * `consumed_quantity` / `consumed_unit` are FOCUS's ConsumedQuantity / ConsumedUnit: how much was used (GitLab
 * compute minutes, GitHub's `quantity`, OpenAI's `quantity`). They are MEASURES, so they are not in the grain
 * hash. `priced` is 0 for a line a source could not price (a CI source with no owner-configured rate): such a
 * line has `billed_cost` 0 and `effective_cost` NULL, and the views name its quantity as unpriced instead of
 * adding it to any money total (the store refuses a `priced` 0 line with a cost).
 *
 * Backfill: none. A line from before V110 is priced and has no quantity, which the column defaults give. The
 * three `ALTER`s are each guarded by a column probe in the step (`migrations/column-steps.ts`), so the step is
 * re-runnable. Written ONLY by `finops/cost-line-store.ts` (static D24 rule `cost-line-confined`).
 */
export const COST_LINE_QUANTITY_V110_DESCRIPTION =
  "cost line consumed quantity and priced flag (Phase 7, the Cost Pack)";

export const COST_LINE_QUANTITY_V110_COLUMNS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "consumed_quantity", sql: "ALTER TABLE cost_line ADD COLUMN consumed_quantity REAL" },
  {
    name: "consumed_unit",
    sql: "ALTER TABLE cost_line ADD COLUMN consumed_unit TEXT CHECK (consumed_unit IS NULL OR length(consumed_unit) BETWEEN 1 AND 32)",
  },
  {
    name: "priced",
    sql: "ALTER TABLE cost_line ADD COLUMN priced INTEGER NOT NULL DEFAULT 1 CHECK (priced IN (0, 1))",
  },
];
