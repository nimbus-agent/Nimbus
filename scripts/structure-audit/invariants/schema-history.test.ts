import { describe, expect, test } from "bun:test";

import { iterateSourceFiles } from "../lib.ts";
import type { FileEntry } from "./_shared.ts";
import { checkSchemaHistoryConfinement } from "./schema-history.ts";

const SRC = "packages/gateway/src/";
const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
const STORE = `${SRC}index/schema-history.ts`;
const RULE = "schema-history-confined";
const GOOD: FileEntry[] = [
  file(
    STORE,
    'export function recordSchemaObservation() { dbRun(db, "INSERT INTO schema_history (a) VALUES (1)"); dbRun(db, "DELETE FROM schema_history WHERE service = ?"); }\nexport function deleteSchemaHistoryForService() {}\nexport function pruneSchemaHistory() {}\n',
  ),
  file(
    `${SRC}index/schema-history-v108-sql.ts`,
    'export const X = ["CREATE TABLE IF NOT EXISTS schema_history (a)"];\n',
  ),
  file(`${SRC}index/item-write-tracking.ts`, "recordSchemaObservation(db, obs, 1);\n"),
  file(`${SRC}index/item-store.ts`, "deleteSchemaHistoryForService(db, service);\n"),
  file(`${SRC}commands/data-delete.ts`, "deleteSchemaHistoryForService(db, service);\n"),
  file(`${SRC}index/schema-history-retention.ts`, "pruneSchemaHistory(db, o);\n"),
  file(
    `${SRC}index/schema-diff.ts`,
    'const q = "SELECT * FROM schema_history"; // INSERT INTO schema_history\n',
  ),
  file(
    `${SRC}index/schema-history.test.ts`,
    'db.run("INSERT INTO schema_history VALUES (1)"); recordSchemaObservation(); pruneSchemaHistory(); deleteSchemaHistoryForService();\n',
  ),
];
const rules = (files: FileEntry[]): string[] =>
  checkSchemaHistoryConfinement(files).map((v) => v.rule);
const withBad = (path: string, contents: string): FileEntry[] => [...GOOD, file(path, contents)];

describe("D24 - schema_history is written only by its store (schema V108)", () => {
  test("the good set is clean", () => {
    expect(checkSchemaHistoryConfinement(GOOD)).toEqual([]);
  });

  // Red proof: each write shape, from a place that is not the store, is refused.
  for (const [name, sql] of [
    ["INSERT", 'dbRun(db, "INSERT INTO schema_history (a) VALUES (1)")'],
    ["DELETE", 'dbRun(db, "DELETE FROM schema_history")'],
    ["UPDATE", 'dbRun(db, "UPDATE schema_history SET complete = 1")'],
    ["UPDATE OR REPLACE", 'dbRun(db, "UPDATE OR REPLACE schema_history SET complete = 1")'],
    ["INSERT OR REPLACE", 'dbRun(db, "INSERT OR REPLACE INTO schema_history (a) VALUES (1)")'],
    ["REPLACE INTO", 'dbRun(db, "REPLACE INTO schema_history (a) VALUES (1)")'],
    ["DROP", 'dbRun(db, "DROP TABLE schema_history")'],
    ["ALTER", 'dbRun(db, "ALTER TABLE schema_history ADD COLUMN x")'],
    ["a quoted name", "dbRun(db, 'INSERT INTO \"schema_history\" (a) VALUES (1)')"],
    ["a bracketed name", "dbRun(db, 'INSERT INTO [schema_history] (a) VALUES (1)')"],
    ["a backticked name", "dbRun(db, 'INSERT INTO `schema_history` (a) VALUES (1)')"],
    ["a multi-line statement", "dbRun(db, `INSERT\n  INTO\n  schema_history (a) VALUES (1)`)"],
    ["a schema-qualified DELETE", 'dbRun(db, "DELETE FROM main.schema_history")'],
    ["a spaced schema qualifier", 'dbRun(db, "DELETE FROM main . schema_history")'],
  ] as const) {
    test(`a connector with ${name} is refused`, () => {
      expect(rules(withBad(`${SRC}connectors/evil-sync.ts`, `${sql};\n`))).toEqual([RULE]);
    });
  }

  test("the reader module and the retention module may not write", () => {
    for (const path of [`${SRC}index/schema-diff.ts`, `${SRC}index/schema-history-retention.ts`]) {
      const files = [...GOOD.filter((f) => f.relPath !== path)];
      files.push(file(path, 'dbRun(db, "DELETE FROM schema_history");\n'));
      expect(rules(files), path).toEqual([RULE]);
    }
  });

  test("naming a mutator outside its allowed files is refused", () => {
    expect(
      rules(withBad(`${SRC}connectors/evil-sync.ts`, "recordSchemaObservation(db, o, 1);\n")),
    ).toEqual([RULE]);
    expect(
      rules(withBad(`${SRC}ipc/x-rpc.ts`, 'deleteSchemaHistoryForService(db, "s");\n')),
    ).toEqual([RULE]);
    expect(rules(withBad(`${SRC}ipc/x-rpc.ts`, "pruneSchemaHistory(db, o);\n"))).toEqual([RULE]);
    // each mutator is allowed in ITS files only
    const swapped = [...GOOD.filter((f) => f.relPath !== `${SRC}commands/data-delete.ts`)];
    swapped.push(file(`${SRC}commands/data-delete.ts`, "recordSchemaObservation(db, o, 1);\n"));
    expect(rules(swapped)).toEqual([RULE]);
  });

  test("a comment and a read are not violations", () => {
    expect(
      rules(
        withBad(
          `${SRC}connectors/ok-sync.ts`,
          '// INSERT INTO schema_history\nconst q = "SELECT * FROM schema_history";\n',
        ),
      ),
    ).toEqual([]);
  });

  test("the real repository satisfies the rule", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkSchemaHistoryConfinement(files)).toEqual([]);
    // the scan must actually see the store, or the rule passes over nothing
    expect(files.some((f) => f.relPath === STORE)).toBe(true);
  });
});
