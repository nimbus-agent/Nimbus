import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderConnectorWriteManifest } from "../../../../../scripts/gen-connector-write-manifest.ts";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { CHATOPS_POST_TOOL_IDS } from "../../chatops/transport/connector-post.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../../tribal/tribal-write-gate.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { CONNECTOR_WRITE_MANIFEST } from "./manifest.generated.ts";

const MANIFEST_PATH = join(import.meta.dir, "manifest.generated.ts");
const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const gateConfined = (id: string): boolean =>
  CHATOPS_POST_TOOL_IDS.has(id) || TRIBAL_KB_WRITE_TOOL_IDS.has(id);
const manifestIds = new Set(CONNECTOR_WRITE_MANIFEST.map((e) => e.toolId));
const rowIds = new Set(CONNECTOR_WRITE_ROWS.map((r) => r.toolId));

describe("connector write manifest", () => {
  test("the committed manifest is what the generator produces from the installed package", () => {
    const committed = readFileSync(MANIFEST_PATH, "utf8").replaceAll("\r\n", "\n");
    expect(
      committed === renderConnectorWriteManifest(scan),
      "stale manifest: run `bun run gen:connector-write-manifest` and commit the result",
    ).toBe(true);
  });

  test("no gate-confined id is spelled in the generated file", () => {
    const text = readFileSync(MANIFEST_PATH, "utf8");
    const spelled = [...CHATOPS_POST_TOOL_IDS, ...TRIBAL_KB_WRITE_TOOL_IDS].filter((id) =>
      text.includes(id),
    );
    expect(spelled).toEqual([]);
  });

  test("every registered write has a row", () => {
    const missing = [...manifestIds].filter((id) => !rowIds.has(id));
    expect(
      missing,
      "classify it in packages/gateway/src/connectors/connector-writes/<group>.ts",
    ).toEqual([]);
  });

  test("every row not marked registeredAs read names a registered write", () => {
    const stray = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.registeredAs === undefined && !manifestIds.has(r.toolId),
    ).map((r) => r.toolId);
    expect(stray).toEqual([]);
  });

  test("every registeredAs-read row is still registered as a read", () => {
    const registered = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.registeredAs !== undefined && manifestIds.has(r.toolId),
    ).map((r) => r.toolId);
    expect(registered, "upstream now registers it as a write: drop registeredAs").toEqual([]);
  });

  test("a literal mutates agrees with the row", () => {
    const rowById = new Map(CONNECTOR_WRITE_ROWS.map((r) => [r.toolId, r]));
    const code = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));
    const problems: string[] = [];
    let compared = 0;
    for (const r of scan.registrations) {
      if (gateConfined(r.id)) continue;
      const row = rowById.get(r.id);
      if (row === undefined) {
        problems.push(`${r.id}: no row`);
        continue;
      }
      const call = (code.get(r.file) ?? "").slice(r.span[0], r.span[1] + 1);
      const m = /\bmutates:\s*"([^"]*)"/.exec(call);
      if (m?.[1] === undefined || m[1].includes("${")) continue;
      compared++;
      if (m[1] !== row.actionType) problems.push(`${r.id}: ${m[1]} != ${row.actionType}`);
    }
    expect(problems).toEqual([]);
    // 0.3.0 has 70 literal `mutates` on rowed writes; a span or regex that stopped matching would
    // compare none and pass, so the comparison count is pinned too.
    expect(compared).toBeGreaterThanOrEqual(60);
  });

  test("every template key names an input key the connector declares", () => {
    const regByTool = new Map(scan.registrations.map((r) => [r.id, r]));
    const code = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));
    const templateKeys = (r: (typeof CONNECTOR_WRITE_ROWS)[number], extra: string[] = []) => {
      const t = r.preview;
      if (t === undefined) return [];
      const keys = new Set<string>([...t.fields.map((f) => f.key), ...extra]);
      for (const text of [t.target, t.summary]) {
        for (const m of text.matchAll(/\{([A-Za-z0-9_]+)\}/g))
          if (m[1] !== undefined) keys.add(m[1]);
      }
      return [...keys];
    };
    const problemsFor = (r: (typeof CONNECTOR_WRITE_ROWS)[number], extra: string[] = []) => {
      const reg = regByTool.get(r.toolId);
      if (reg === undefined) return [`${r.toolId}: not registered`];
      // Slice by the registration's own span: `id:` / `name:` appear for other tools in the file.
      const fileCode = code.get(reg.file) ?? "";
      // A tool registered through a local helper (Monte Carlo, Bigeye) declares its input schema in
      // the helper's body, which the forwarding call's span does not contain; for those the file is
      // the narrowest region available. Every other tool is checked against its own call only.
      const call = reg.tags.includes("forwarder")
        ? fileCode
        : fileCode.slice(reg.span[0], reg.span[1] + 1);
      return templateKeys(r, extra)
        .filter((k) => !call.includes(`${k}:`))
        .map((k) => `${r.toolId}: ${k}`);
    };
    const templated = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.preview !== undefined && r.registeredAs === undefined,
    );
    expect(templated.length).toBeGreaterThanOrEqual(18);
    expect(templated.flatMap((r) => problemsFor(r))).toEqual([]);
    // Negative control: a made-up key must be reported, so the check can fail.
    const tableau = templated.find((r) => r.toolId === "tableau_datasource_refresh");
    if (tableau === undefined) throw new Error("tableau_datasource_refresh row missing");
    expect(problemsFor(tableau, ["nonexistentKey"])).toEqual([
      "tableau_datasource_refresh: nonexistentKey",
    ]);
  });

  test("the manifest's size is plausible", () => {
    expect(CONNECTOR_WRITE_MANIFEST.length).toBeGreaterThanOrEqual(80);
  });
});
