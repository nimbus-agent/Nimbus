// Static invariant rule (D24 extension): the warehouse schema history is written only by its store
// (Phase 10, the Data Incident Brief's schema diff, schema V108). docs/SECURITY-INVARIANTS.md describes it.

import { stripComments } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// Rule `schema-history-confined`. A WRITE verb on `schema_history` may appear only in the store
// (`index/schema-history.ts`) and the V108 DDL file. The store's three mutators are named only where they
// belong: `recordSchemaObservation` in the store and `index/item-write-tracking.ts` (the upsert's
// transaction); `deleteSchemaHistoryForService` in the store, `index/item-store.ts`
// (`deleteAllItemsForService`) and `commands/data-delete.ts` (the two owner erasures);
// `pruneSchemaHistory` in the store and `index/schema-history-retention.ts`. Reads are unrestricted (the
// incident lane reads the table through `index/schema-diff.ts`), so no syncable, agent, RPC or other store
// can write a history row around the completeness rule, or erase one.
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says); the store's
// being the only writer, and the upsert transaction being the only caller of the recorder, is the real
// defense. `iterateGlob` skips every `-sql.ts` file, so the real scan never visits the DDL file; it stays in
// the allow-list only so a synthetic file set can carry it.
const SRC = "packages/gateway/src/";
const STORE = `${SRC}index/schema-history.ts`;
const DDL = `${SRC}index/schema-history-v108-sql.ts`;
const RULE = "schema-history-confined";

const WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?schema_history\b/gi;

const NAME_RULES: ReadonlyArray<{ re: RegExp; allowed: readonly string[] }> = [
  { re: /\brecordSchemaObservation\b/g, allowed: [STORE, `${SRC}index/item-write-tracking.ts`] },
  {
    re: /\bdeleteSchemaHistoryForService\b/g,
    allowed: [STORE, `${SRC}index/item-store.ts`, `${SRC}commands/data-delete.ts`],
  },
  {
    re: /\bpruneSchemaHistory\b/g,
    allowed: [STORE, `${SRC}index/schema-history-retention.ts`],
  },
];

export function checkSchemaHistoryConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(SRC)) continue;
    const commentFree = stripComments(f.contents);
    const add = (index: number | undefined): void => {
      const line = commentFree.slice(0, index).split("\n").length;
      out.push({
        rule: RULE,
        file: f.relPath,
        line,
        snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
      });
    };
    if (f.relPath !== STORE && f.relPath !== DDL) {
      for (const m of commentFree.matchAll(WRITE_RE)) add(m.index);
    }
    for (const r of NAME_RULES) {
      if (r.allowed.includes(f.relPath)) continue;
      for (const m of commentFree.matchAll(r.re)) add(m.index);
    }
  }
  return out;
}
