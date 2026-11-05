// packages/gateway/src/connectors/connector-writes/model-offerable.ts
import type { ConnectorWriteRow } from "./types.ts";

/**
 * M1: whether the MODEL may be offered this write now. The row must have a typed preview template
 * AND (be in wave 2-3, or have a `before` reader: spec § 5.4 makes the current state mandatory on a
 * wave-4 prompt). Since B1 the offerable rows are the 12 wave-2 message and comment rows; only
 * wave-2 comment rows have a `before` reader, so no wave-4 row is offerable yet. The door, `status`
 * and the enable prompt all use this one function.
 */
export function isModelOfferableRow(row: ConnectorWriteRow): boolean {
  return row.preview !== undefined && (row.wave < 4 || row.before !== undefined);
}
