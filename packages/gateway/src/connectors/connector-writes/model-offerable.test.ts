import { describe, expect, test } from "bun:test";
import { offerableWritesEnabledBy, writesEnabledBy } from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import type { BeforeStateReader, ConnectorWriteRow } from "./types.ts";

const template = { target: "t", summary: "s", fields: [] };
const reader: BeforeStateReader = {
  tool: "x_get",
  argKeys: ["id"],
  args: (input) => ({ id: input["id"] }),
  select: () => [],
};
const row = (over: Partial<ConnectorWriteRow>): ConnectorWriteRow => ({
  toolId: "x_y",
  actionType: "x.y",
  transport: "write",
  wave: 2,
  ...over,
});

describe("isModelOfferableRow (M1)", () => {
  test("needs a preview template", () => {
    expect(isModelOfferableRow(row({ wave: 2 }))).toBe(false);
    expect(isModelOfferableRow(row({ wave: 2, preview: template }))).toBe(true);
    expect(isModelOfferableRow(row({ wave: 3, preview: template }))).toBe(true);
  });
  test("wave 4 needs a before reader as well", () => {
    expect(isModelOfferableRow(row({ wave: 4, preview: template }))).toBe(false);
    expect(isModelOfferableRow(row({ wave: 4, preview: template, before: reader }))).toBe(true);
    expect(isModelOfferableRow(row({ wave: 4, before: reader }))).toBe(false);
  });
  test("today nothing is offerable (no row has a before reader): stated, not hidden", () => {
    expect(CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow)).toEqual([]);
    expect(offerableWritesEnabledBy("argocd", 4)).toEqual([]);
    expect(writesEnabledBy("argocd", 4)).toHaveLength(2);
  });
});
