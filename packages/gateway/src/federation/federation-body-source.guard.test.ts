import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * I17 sits on query-gate.ts. V48 must not widen what a federated peer receives:
 * the gate reads body_preview and slices to SNIPPET_MAX before anything leaves
 * the machine, and both halves are load-bearing.
 */
test("the federated query gate reads body_preview and still slices to SNIPPET_MAX", () => {
  const src = readFileSync(join(import.meta.dir, "query-gate.ts"), "utf8");
  expect(src).toContain("body_preview");
  expect(src).toContain("SNIPPET_MAX");
  expect(src).toContain('(r.body_preview ?? "").slice(0, SNIPPET_MAX)');
  expect(src.match(/\br\.body\b(?!_preview)/g)).toBeNull();
});
