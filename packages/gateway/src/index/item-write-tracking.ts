import type { Database } from "bun:sqlite";

import { recordSchemaObservation } from "./schema-history.ts";
import { schemaObservationOf } from "./schema-history-source.ts";

/**
 * The extra records an item upsert keeps in the SAME transaction as the item write (`upsertIndexedItem`):
 * the item's change history (supplied by the caller as `recordHistory`, so the `item_history` writer stays
 * named in `item-store.ts` only, static D46(b)) and, for a tracked warehouse table, the observation of its
 * column set (`schema_history`, D24 `schema-history-confined`). A crash or a failing insert in either leaves
 * no changed item without its record, and an untracked item with no history pays nothing extra.
 */
export function runTrackedItemWrite(
  db: Database,
  p: {
    readonly service: string;
    readonly type: string;
    /** The metadata JSON exactly as it is stored. */
    readonly metadata: string;
    readonly syncedAt: number;
    readonly writeItem: () => void;
    readonly recordHistory: (() => void) | undefined;
  },
): void {
  const schema = schemaObservationOf(p.service, p.type, p.metadata);
  if (p.recordHistory === undefined && schema === undefined) {
    p.writeItem();
    return;
  }
  db.transaction(() => {
    p.writeItem();
    p.recordHistory?.();
    if (schema !== undefined) recordSchemaObservation(db, schema, p.syncedAt);
  })();
}
