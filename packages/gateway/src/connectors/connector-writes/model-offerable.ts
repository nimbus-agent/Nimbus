// packages/gateway/src/connectors/connector-writes/model-offerable.ts
import type { ConnectorWriteRow } from "./types.ts";

/**
 * M1: whether the MODEL may be offered this write now. The row must have a typed preview template
 * AND (be in wave 2-3, or have a `before` reader). No row has a `before` reader yet, so wave-4 rows
 * are not offerable today. The door, `status` and the enable prompt all use this one function.
 */
export function isModelOfferableRow(row: ConnectorWriteRow): boolean {
  return row.preview !== undefined && (row.wave < 4 || row.before !== undefined);
}
