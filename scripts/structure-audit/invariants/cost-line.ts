// Static invariant rule (D24 extension): the cost lines are written only by their store (Phase 7, the Cost
// Pack, schema V109). docs/SECURITY-INVARIANTS.md describes it.

import { stripComments } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// Rule `cost-line-confined`. A WRITE verb (`DROP TABLE IF EXISTS` included) on `cost_line` or its import
// ledger `cost_import` may appear only in the store (`finops/cost-line-store.ts`) and the V109 DDL file. The
// store's five mutators are named only where they belong: `replaceCostLines`, `deleteCostImport` and
// `recordCostImport` in the store and `finops/cost-import.ts` (the owner's import, which reconciles a file's
// totals before it replaces a tuple's days and records the import); `deleteCostLinesBySource` in
// the store, `index/item-store.ts` (`deleteAllItemsForService`, which `connector remove` reaches through
// `LocalIndex.removeConnectorIndexData`) and `commands/data-delete.ts` (the two owner erasures);
// `pruneCostLinesBefore` in the store and `finops/cost-retention.ts`. Reads are unrestricted, so
// no syncable, agent, RPC or other store can write a line around the import's reconciliation, or erase one.
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says); the store's
// being the only writer is the real defense. `iterateGlob` skips every `-sql.ts` file, so the real scan
// never visits the DDL file; it stays in the allow-list only so a synthetic file set can carry it.
const SRC = "packages/gateway/src/";
const STORE = `${SRC}finops/cost-line-store.ts`;
const DDL = `${SRC}index/cost-line-v109-sql.ts`;
const IMPORT = `${SRC}finops/cost-import.ts`;
const RULE = "cost-line-confined";

const WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?(?:cost_line|cost_import)\b/gi;

const NAME_RULES: ReadonlyArray<{ re: RegExp; allowed: readonly string[] }> = [
  { re: /\breplaceCostLines\b/g, allowed: [STORE, IMPORT] },
  { re: /\bdeleteCostImport\b/g, allowed: [STORE, IMPORT] },
  { re: /\brecordCostImport\b/g, allowed: [STORE, IMPORT] },
  {
    re: /\bdeleteCostLinesBySource\b/g,
    allowed: [STORE, `${SRC}index/item-store.ts`, `${SRC}commands/data-delete.ts`],
  },
  { re: /\bpruneCostLinesBefore\b/g, allowed: [STORE, `${SRC}finops/cost-retention.ts`] },
];

function scanFile(f: FileEntry, out: Violation[]): void {
  const commentFree = stripComments(f.contents);
  const add = (index: number | undefined): void => {
    const line = commentFree.slice(0, index).split("\n").length;
    const snippet = (f.contents.split("\n")[line - 1] ?? "").trim();
    out.push({ rule: RULE, file: f.relPath, line, snippet });
  };
  if (f.relPath !== STORE && f.relPath !== DDL) {
    for (const m of commentFree.matchAll(WRITE_RE)) add(m.index);
  }
  for (const r of NAME_RULES.filter((n) => !n.allowed.includes(f.relPath))) {
    for (const m of commentFree.matchAll(r.re)) add(m.index);
  }
}

const inScope = (f: FileEntry): boolean =>
  f.relPath.startsWith(SRC) &&
  !f.relPath.endsWith(".test.ts") &&
  !f.relPath.endsWith(".test-helpers.ts");

export function checkCostLineConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files.filter(inScope)) scanFile(f, out);
  return out;
}
