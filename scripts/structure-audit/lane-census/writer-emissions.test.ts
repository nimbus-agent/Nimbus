import { describe, expect, test } from "bun:test";
import { extractWriterEmissions, WRITER_EXCLUDE, WRITER_INCLUDE } from "./writer-emissions.ts";

describe("extractWriterEmissions", () => {
  test("reads a row literal with an inline metadata object", () => {
    const src = [
      "ctx.upsertItem({",
      '  service: "github_actions",',
      '  type: "ci_run",',
      "  metadata: { workflowName: name, conclusion, headSha },",
      "});",
    ].join("\n");
    const out = extractWriterEmissions("x-sync.ts", src);
    expect(out[0]?.service).toBe("github_actions");
    expect(out[0]?.itemType).toBe("ci_run");
    expect([...(out[0]?.metadataKeys ?? [])].sort()).toEqual([
      "conclusion",
      "headSha",
      "workflowName",
    ]);
  });

  test("resolves metadata assigned to a local const", () => {
    const src = [
      "const meta = { jobName: j, result: r };",
      'ctx.upsertItem({ service: "jenkins", type: "ci_run", metadata: meta });',
    ].join("\n");
    expect([...(extractWriterEmissions("j.ts", src)[0]?.metadataKeys ?? [])].sort()).toEqual([
      "jobName",
      "result",
    ]);
  });

  test("the demo corpus is excluded by path", () => {
    expect(WRITER_EXCLUDE.some((p) => "packages/gateway/src/demo/corpus/acme.ts".includes(p))).toBe(
      true,
    );
  });

  test("resolves service/type from module-level consts, as-const or not", () => {
    const src = [
      'const SERVICE_ID = "pagerduty";',
      'const TYPE_ID = "incident" as const;',
      "ctx.upsertItem({ service: SERVICE_ID, type: TYPE_ID, metadata: {} });",
    ].join("\n");
    const out = extractWriterEmissions("p.ts", src);
    expect(out).toEqual([
      { service: "pagerduty", itemType: "incident", metadataKeys: [], file: "p.ts", line: 3 },
    ]);
  });

  test("a ternary type emits both branches", () => {
    const src =
      'ctx.upsertItem({ service: "google_drive", type: isFolder ? "folder" : "file", metadata: {} });';
    const values = extractWriterEmissions("d.ts", src)
      .map((e) => e.itemType)
      .sort();
    expect(values).toEqual(["file", "folder"]);
  });

  test("a property-access value cannot be resolved and is recorded, not dropped", () => {
    const src =
      "const built = { service: input.service, type: input.type, metadata: input.metadata ?? {} };";
    const out = extractWriterEmissions("item-builder.ts", src);
    expect(out).toHaveLength(1);
    expect(out[0]?.service).toBe("__UNRESOLVED__");
    expect(out[0]?.itemType).toBe("__UNRESOLVED__");
  });

  test("a same-file call resolves through its own local const return, including a later dot-assigned key", () => {
    const src = [
      "function buildMeta(row) {",
      "  const metadata = { status: row.status, incidentId: row.id };",
      "  if (row.urgency) metadata.urgency = row.urgency;",
      "  return metadata;",
      "}",
      'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: buildMeta(row) });',
    ].join("\n");
    const keys = [...(extractWriterEmissions("pd.ts", src)[0]?.metadataKeys ?? [])].sort();
    expect(keys).toEqual(["incidentId", "status", "urgency"]);
  });

  test("a conditional bracket-assigned key after the base literal is captured (pagerduty's real shape)", () => {
    const src = [
      "function buildPagerdutyMetadata(row) {",
      "  const metadata = { status: row.status, incidentId: row.id };",
      "  if (Number.isFinite(openedAtMs)) metadata['opened_at_ms'] = openedAtMs;",
      '  if (serviceId !== undefined) metadata["pagerduty_service_id"] = serviceId;',
      "  return metadata;",
      "}",
      'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: buildPagerdutyMetadata(row) });',
    ].join("\n");
    const keys = [...(extractWriterEmissions("pd2.ts", src)[0]?.metadataKeys ?? [])].sort();
    expect(keys).toEqual(["incidentId", "opened_at_ms", "pagerduty_service_id", "status"]);
  });

  test("a bracket-assigned key after a top-level local const (no call hop) is captured", () => {
    const src = [
      "function build() {",
      '  const metadata = { name: "x" };',
      "  if (cond) {",
      '    metadata["summary"] = "y";',
      "  }",
      '  return { service: "mlflow", type: "ml_model", metadata };',
      "}",
    ].join("\n");
    const keys = [...(extractWriterEmissions("mlflow.ts", src)[0]?.metadataKeys ?? [])].sort();
    expect(keys).toEqual(["name", "summary"]);
  });

  // The metadata expression here MUST be a bare identifier, not an inline `{ a: 1 }`:
  // `resolveMetadataKeys` returns early on an object literal and never reaches
  // `resolveTopLevelIdentifierMetadataKeys`, which is where the scope handling this test exists to
  // pin actually lives. Written with a literal, this test passes whatever that code does.
  test("a bracket-assigned key in an unrelated scope is NOT attributed to a same-named metadata var elsewhere", () => {
    const src = [
      "function build() {",
      "  const meta = { a: 1 };",
      '  return { service: "x", type: "y", metadata: meta };',
      "}",
      "function unrelated() {",
      "  const meta = fetchApiThing();",
      "  meta.threadId = 1;",
      "}",
    ].join("\n");
    expect(extractWriterEmissions("unrelated.ts", src)[0]?.metadataKeys).toEqual(["a"]);
  });

  test("a quoted metadata key is captured", () => {
    const src = 'ctx.upsertItem({ service: "x", type: "y", metadata: { "sync_status": s } });';
    expect(extractWriterEmissions("q.ts", src)[0]?.metadataKeys).toEqual(["sync_status"]);
  });

  test("an interface declaration is not mistaken for a value write", () => {
    const src = ["interface Foo {", "  service: string;", "  type: string;", "}"].join("\n");
    expect(extractWriterEmissions("types.ts", src)).toHaveLength(0);
  });

  test("a destructuring pattern is not mistaken for a value write", () => {
    const src = "const { service, type } = input;";
    expect(extractWriterEmissions("destructure.ts", src)).toHaveLength(0);
  });

  test("returns nothing for a file with neither key", () => {
    expect(extractWriterEmissions("empty.ts", "export const x = 1;")).toHaveLength(0);
  });

  test("WRITER_INCLUDE names the connectors package and the deployment annotation path", () => {
    expect(WRITER_INCLUDE).toContain("packages/gateway/src/connectors/");
    expect(WRITER_INCLUDE).toContain("packages/gateway/src/deployment/annotate.ts");
  });

  // A `\_`-pair run followed by trailing garbage after the real closing delimiter makes the
  // whole-string match fail only at the very end — the classic backtracking-blowup shape for an
  // alternation whose two branches overlap (both used to accept a bare backslash). Before the fix,
  // `matchStringLiteral`/`matchTernaryOfLiterals` could re-split a run like this exponentially many
  // ways before giving up; disjoint alternatives make the failure linear instead. Asserted on the
  // resolved value (behaviour), not elapsed time — a hang here fails via bun's own test timeout
  // rather than a wall-clock assertion that would itself be flaky on a slow runner.
  test("a malformed quoted-string value does not hang on catastrophic regex backtracking", () => {
    const escapedRun = "\\_".repeat(5_000);
    const src = `ctx.upsertItem({ service: "${escapedRun}"x, type: "y" });`;
    const out = extractWriterEmissions("redos-quote.ts", src);
    expect(out[0]?.service).toBe("__UNRESOLVED__");
  });

  test("a malformed template-literal value does not hang on catastrophic regex backtracking", () => {
    const escapedRun = "\\_".repeat(5_000);
    const src = "ctx.upsertItem({ service: `" + escapedRun + '`x, type: "y" });';
    const out = extractWriterEmissions("redos-template.ts", src);
    expect(out[0]?.service).toBe("__UNRESOLVED__");
  });

  test("a malformed ternary branch does not hang on catastrophic regex backtracking", () => {
    const escapedRun = "\\_".repeat(5_000);
    const src = `ctx.upsertItem({ service: "x", type: flag ? "${escapedRun}"z : "b" });`;
    const out = extractWriterEmissions("redos-ternary.ts", src);
    expect(out[0]?.itemType).toBe("__UNRESOLVED__");
  });

  test("a malformed quoted property KEY does not hang on catastrophic regex backtracking", () => {
    // Same overlapping-alternation shape as the three above, but in `parseTopLevelProps`'s
    // quoted-KEY regex (`"key": value`) rather than a value resolver — the key/value splitter
    // parses the same untrusted-shaped object-literal source text. The malformed key never
    // resolves to a `service` prop, so the object is silently skipped (no `service`/`type` pair
    // found) rather than crashing or hanging.
    const escapedRun = "\\_".repeat(5_000);
    const src = `ctx.upsertItem({ "${escapedRun}"x: "v", type: "y" });`;
    const out = extractWriterEmissions("redos-quoted-key.ts", src);
    expect(out).toHaveLength(0);
  });
});
