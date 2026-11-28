import { describe, expect, test } from "bun:test";

import { iterateSourceFiles } from "../lib.ts";
import type { FileEntry } from "./_shared.ts";
import { checkCostLineConfinement } from "./cost-line.ts";

const SRC = "packages/gateway/src/";
const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
const STORE = `${SRC}finops/cost-line-store.ts`;
const RULE = "cost-line-confined";
const GOOD: FileEntry[] = [
  file(
    STORE,
    'export function replaceCostLines() { dbRun(db, "DELETE FROM cost_line WHERE source = ?"); dbRun(db, "INSERT INTO cost_line (a) VALUES (1)"); }\nexport function deleteCostImport() {}\nexport function deleteCostLinesBySource() {}\nexport function pruneCostLinesBefore() {}\nexport function repriceCostLines() {}\nexport function recordCostImport() { dbRun(db, "INSERT INTO cost_import (a) VALUES (1)"); }\n',
  ),
  file(
    `${SRC}index/cost-line-v109-sql.ts`,
    'export const X = ["CREATE TABLE IF NOT EXISTS cost_line (a)"];\n',
  ),
  file(
    `${SRC}finops/cost-import.ts`,
    "replaceCostLines(db, k, d, l); deleteCostImport(db, id); recordCostImport(db, r);\n",
  ),
  file(
    `${SRC}finops/cost-sync-intake.ts`,
    "export function ingestSyncedCostLines() { return replaceCostLines(db, k, d, l); }\nexport function repriceSyncedCostLines() { return repriceCostLines(db, s, r); }\n",
  ),
  file(
    `${SRC}sync/cost-sync-capabilities.ts`,
    "ingestSyncedCostLines(db, serviceId, t, l, now); repriceSyncedCostLines(db, serviceId, r);\n",
  ),
  file(`${SRC}index/item-store.ts`, "deleteCostLinesBySource(db, service);\n"),
  file(`${SRC}commands/data-delete.ts`, "deleteCostLinesBySource(db, service);\n"),
  file(`${SRC}finops/cost-retention.ts`, "pruneCostLinesBefore(db, day);\n"),
  file(
    `${SRC}finops/cost-views.ts`,
    'const q = "SELECT * FROM cost_line"; // DELETE FROM cost_line\n',
  ),
  file(
    `${SRC}finops/cost-line-store.test.ts`,
    'db.run("INSERT INTO cost_line VALUES (1)"); replaceCostLines(); pruneCostLinesBefore();\n',
  ),
];
const rules = (files: FileEntry[]): string[] => checkCostLineConfinement(files).map((v) => v.rule);
const withBad = (path: string, contents: string): FileEntry[] => [...GOOD, file(path, contents)];

describe("D24 - cost_line is written only by its store (schema V109)", () => {
  test("the good set is clean", () => {
    expect(checkCostLineConfinement(GOOD)).toEqual([]);
  });

  // Red proof: each write shape, from a place that is not the store, is refused.
  for (const [name, sql] of [
    ["INSERT", 'dbRun(db, "INSERT INTO cost_line (a) VALUES (1)")'],
    ["DELETE", 'dbRun(db, "DELETE FROM cost_line")'],
    ["UPDATE", 'dbRun(db, "UPDATE cost_line SET billed_cost = 0")'],
    ["UPDATE OR REPLACE", 'dbRun(db, "UPDATE OR REPLACE cost_line SET billed_cost = 0")'],
    ["INSERT OR REPLACE", 'dbRun(db, "INSERT OR REPLACE INTO cost_line (a) VALUES (1)")'],
    ["REPLACE INTO", 'dbRun(db, "REPLACE INTO cost_line (a) VALUES (1)")'],
    ["DROP", 'dbRun(db, "DROP TABLE cost_line")'],
    ["DROP IF EXISTS", 'dbRun(db, "DROP TABLE IF EXISTS cost_line")'],
    ["DROP IF EXISTS, schema-qualified", 'dbRun(db, "DROP TABLE IF EXISTS main.cost_line")'],
    ["an INSERT into the import ledger", 'dbRun(db, "INSERT INTO cost_import (a) VALUES (1)")'],
    ["a DELETE from the import ledger", 'dbRun(db, "DELETE FROM cost_import")'],
    ["a DROP of the import ledger", 'dbRun(db, "DROP TABLE IF EXISTS cost_import")'],
    ["ALTER", 'dbRun(db, "ALTER TABLE cost_line ADD COLUMN x")'],
    ["a quoted name", "dbRun(db, 'INSERT INTO \"cost_line\" (a) VALUES (1)')"],
    ["a bracketed name", "dbRun(db, 'INSERT INTO [cost_line] (a) VALUES (1)')"],
    ["a backticked name", "dbRun(db, 'INSERT INTO `cost_line` (a) VALUES (1)')"],
    ["a multi-line statement", "dbRun(db, `INSERT\n  INTO\n  cost_line (a) VALUES (1)`)"],
    ["a schema-qualified DELETE", 'dbRun(db, "DELETE FROM main.cost_line")'],
    ["a spaced schema qualifier", 'dbRun(db, "DELETE FROM main . cost_line")'],
  ] as const) {
    test(`a connector with ${name} is refused`, () => {
      expect(rules(withBad(`${SRC}connectors/evil-sync.ts`, `${sql};\n`))).toEqual([RULE]);
    });
  }

  test("the import and the retention module may not write the table directly", () => {
    for (const path of [`${SRC}finops/cost-import.ts`, `${SRC}finops/cost-retention.ts`]) {
      const files = [...GOOD.filter((f) => f.relPath !== path)];
      files.push(file(path, 'dbRun(db, "DELETE FROM cost_line");\n'));
      expect(rules(files), path).toEqual([RULE]);
    }
  });

  test("naming a mutator outside its allowed files is refused", () => {
    expect(
      rules(withBad(`${SRC}connectors/evil-sync.ts`, "replaceCostLines(db, k, d, l);\n")),
    ).toEqual([RULE]);
    expect(rules(withBad(`${SRC}ipc/x-rpc.ts`, 'deleteCostImport(db, "i");\n'))).toEqual([RULE]);
    expect(rules(withBad(`${SRC}ipc/x-rpc.ts`, 'deleteCostLinesBySource(db, "s");\n'))).toEqual([
      RULE,
    ]);
    expect(rules(withBad(`${SRC}ipc/x-rpc.ts`, 'pruneCostLinesBefore(db, "d");\n'))).toEqual([
      RULE,
    ]);
    expect(rules(withBad(`${SRC}ipc/x-rpc.ts`, "recordCostImport(db, r);\n"))).toEqual([RULE]);
    // each mutator is allowed in ITS files only
    const swapped = [...GOOD.filter((f) => f.relPath !== `${SRC}commands/data-delete.ts`)];
    swapped.push(file(`${SRC}commands/data-delete.ts`, "replaceCostLines(db, k, d, l);\n"));
    expect(rules(swapped)).toEqual([RULE]);
  });

  test("a comment and a read are not violations", () => {
    expect(
      rules(
        withBad(
          `${SRC}connectors/ok-sync.ts`,
          '// INSERT INTO cost_line\nconst q = "SELECT * FROM cost_line";\nconst r = "SELECT 1 FROM cost_import";\nconst s = "INSERT INTO cost_imports (a) VALUES (1)";\n',
        ),
      ),
    ).toEqual([]);
  });

  test("the real repository satisfies the rule", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkCostLineConfinement(files)).toEqual([]);
    // the scan must actually see the store, or the rule passes over nothing
    expect(files.some((f) => f.relPath === STORE)).toBe(true);
  });

  test("slice 5: a syncable reaches cost lines only through the bound capability", () => {
    for (const [path, body] of [
      [`${SRC}connectors/github-billing-cost-sync.ts`, "replaceCostLines(db, k, d, l);"],
      [
        `${SRC}connectors/github-billing-cost-sync.ts`,
        "ingestSyncedCostLines(db, 'focus', t, l, 0);",
      ],
      [`${SRC}sync/sync-capabilities.ts`, "replaceCostLines(deps.db, k, d, l);"],
      [`${SRC}sync/sync-capabilities.ts`, "ingestSyncedCostLines(deps.db, s, t, l, 0);"],
      // Slice 8: the re-price is a mutator; only the store, the intake and the capabilities name it.
      [`${SRC}sync/cost-sync-capabilities.ts`, "repriceCostLines(db, s, r);"],
      [`${SRC}connectors/gitlab-cost-sync.ts`, "repriceCostLines(db, 'focus', r);"],
      [`${SRC}connectors/gitlab-cost-sync.ts`, "repriceSyncedCostLines(db, 'focus', r);"],
      [`${SRC}connectors/gitlab-cost-sync.ts`, 'db.run("UPDATE cost_line SET billed_cost = 0");'],
      [`${SRC}finops/cost-sync-intake.ts`, "recordCostImport(db, r);"],
    ] as const) {
      const files = [...GOOD.filter((f) => f.relPath !== path), file(path, `${body}\n`)];
      expect(rules(files), `${path}: ${body}`).toContain(RULE);
    }
    const ok = withBad(
      `${SRC}connectors/github-billing-cost-sync.ts`,
      "ctx.replaceCostLinesForMonth(t, l);\n",
    );
    expect(rules(ok)).toEqual([]);
  });
});
