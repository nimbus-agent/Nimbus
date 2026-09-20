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

  test("a same-file call resolves through its own local const return", () => {
    const src = [
      "function buildMeta(row) {",
      "  const metadata = { status: row.status, incidentId: row.id };",
      "  if (row.urgency) metadata.urgency = row.urgency;",
      "  return metadata;",
      "}",
      'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: buildMeta(row) });',
    ].join("\n");
    const keys = [...(extractWriterEmissions("pd.ts", src)[0]?.metadataKeys ?? [])].sort();
    expect(keys).toEqual(["incidentId", "status"]);
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
});
