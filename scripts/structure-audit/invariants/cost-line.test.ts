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
    'export function replaceCostLines() { dbRun(db, "DELETE FROM cost_line WHERE source = ?"); dbRun(db, "INSERT INTO cost_line (a) VALUES (1)"); }\nexport function deleteCostImport() {}\nexport function deleteCostLinesBySource() {}\nexport function pruneCostLinesBefore() {}\n',
  ),
  file(
    `${SRC}index/cost-line-v109-sql.ts`,
    'export const X = ["CREATE TABLE IF NOT EXISTS cost_line (a)"];\n',
  ),
  file(`${SRC}finops/cost-import.ts`, "replaceCostLines(db, k, d, l); deleteCostImport(db, id);\n"),
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
          '// INSERT INTO cost_line\nconst q = "SELECT * FROM cost_line";\n',
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
});
