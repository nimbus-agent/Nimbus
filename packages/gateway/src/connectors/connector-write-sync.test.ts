/**
 * I26 sync guard: every write tool the INSTALLED `@nimbus-dev/connectors` registers must be refused
 * at the federated invoke gate.
 *
 * `isConnectorWriteToolId` is a hand-maintained list, and a connectors release can add a write the
 * list does not name — which is exactly how four mutating tools went unclassified when connectors
 * 0.2.2 moved them to the write registrar. This derives the writes from the package's own source
 * (as text: the gateway never imports the package beyond `setConnectorMode`) and fails on any the
 * predicate does not cover. The derivation itself is fail-closed: a registration shape it cannot
 * follow is a violation, never a silent skip — import shapes included (namespace and dynamic
 * imports are followed, default exports and unfollowable module-object uses refused). Its stated
 * blind spots — an object a registrar was handed off into and then read by a non-literal computed
 * key or by reflection, and a mutating tool registered as a READ — are spelled out in
 * `./testing/connector-write-registrations.ts`.
 *
 * There is no exception list. The four comms writes whose literals static D17 / D19 keep out of the
 * gateway-side set are classified through the sets their gates export — and they are derived here
 * like every other write, so dropping one from its gate's set fails this guard.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { isReadOnlyToolId } from "../share/read-tool-registry.ts";
import {
  CONNECTOR_WRITES,
  isConnectorWriteToolId,
  MIGRATED_WRITE_TOOL_IDS,
} from "./connector-write-registry.ts";
import { SHAPE_FIXTURES } from "./testing/connector-write-fixtures.ts";
import {
  installedConnectorsPackageRoot,
  type RegistrationTag,
  ROOT_REGISTRAR_FACTORY,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
  type WriteToolRegistration,
  type WriteToolScan,
} from "./testing/connector-write-registrations.ts";

/** The shapes connectors 0.2.1 registers through. A bump that drops one should be looked at. */
const PINNED_SHAPES: readonly RegistrationTag[] = ["literal", "forwarder", "template", "kit-alias"];

const ROOT = installedConnectorsPackageRoot();
const SCAN = scanWriteToolRegistrations(readConnectorPackageSources(ROOT));

/** Derived writes a federated peer could name without the I26 predicate refusing them. */
function unclassifiedWrites(scan: WriteToolScan): WriteToolRegistration[] {
  return scan.registrations.filter((r) => !isConnectorWriteToolId(r.id));
}

function where(r: WriteToolRegistration): string {
  return `${r.id}  (${r.file}:${String(r.line)})`;
}

describe("I26 sync guard — the installed connectors package", () => {
  test("every write tool it registers is refused at the federated invoke gate", () => {
    expect(
      unclassifiedWrites(SCAN).map(where).sort(),
      "a connector registers a write the I26 predicate does not name — add it to " +
        "MIGRATED_WRITE_TOOL_IDS in connectors/connector-write-tool-ids.ts",
    ).toEqual([]);
  });

  test("and each is refused in the `<server>_<tool>` form a federated session executes, too", () => {
    // `@mastra/mcp` keys a session's tools by server, and the federated runner looks the requested
    // id up verbatim, so the namespaced key is what a peer would have to send.
    // test/integration/connectors/write-tool-namespacing.integration.test.ts pins that on real
    // connector processes.
    const passed = SCAN.registrations
      .map((r) => `${(r.origin.split("/")[1] ?? "").replaceAll("-", "_")}_${r.id}`)
      .filter((namespaced) => !isConnectorWriteToolId(namespaced));
    expect(passed).toEqual([]);
  });

  test("the scan followed every registration — no shape it could not resolve", () => {
    expect(SCAN.violations.map((v) => `${v.file}:${String(v.line)} ${v.reason}`)).toEqual([]);
  });

  test("no write tool is read-only to share replay, the other door a caller names tools through", () => {
    // `share.replay` runs the tool ids an untrusted share file names, gated only by the positive
    // read-verb classifier — so a write whose name ended in a read verb would run unapproved.
    const writes = new Set([
      ...SCAN.registrations.map((r) => r.id),
      ...MIGRATED_WRITE_TOOL_IDS,
      ...CONNECTOR_WRITES.map((w) => w.toolId),
    ]);
    expect([...writes].filter((id) => isReadOnlyToolId(id))).toEqual([]);
  });
});

describe("I26 sync guard — guarding the guard", () => {
  test("premise: the consent kit still defines the registrar constructor the scan roots at", () => {
    const kit = stripComments(readFileSync(join(ROOT, "shared", "consent-kit.ts"), "utf8"));
    expect(kit).toMatch(new RegExp(String.raw`export function ${ROOT_REGISTRAR_FACTORY}\s*\(`));
  });

  test("it derived a plausible number of registrations, each exactly once", () => {
    // 0.2.1 registers 87, 0.2.2 registers 91; an empty or collapsing derivation passes forever.
    expect(SCAN.registrations.length).toBeGreaterThanOrEqual(80);
    expect(new Set(SCAN.registrations.map((r) => r.id)).size).toBe(SCAN.registrations.length);
  });

  test("it saw every registration shape the pinned package uses", () => {
    const seen = new Set(SCAN.registrations.flatMap((r) => r.tags));
    for (const shape of PINNED_SHAPES) expect(seen.has(shape), shape).toBe(true);
  });

  test("every connector whose manifest declares a write has a derived registration", () => {
    // The manifest's `hitlRequired` is upstream's own authoritative "this connector mutates" flag,
    // and upstream's consent audit refuses a manifest that declares a write without registering
    // one — so a declared connector with nothing derived means the scan lost recall.
    const origins = new Set(SCAN.registrations.map((r) => r.origin.split("/")[1]));
    const declared: string[] = [];
    for (const id of readdirSync(join(ROOT, "connectors"))) {
      let hitl: unknown;
      try {
        const manifest: unknown = JSON.parse(
          readFileSync(join(ROOT, "connectors", id, "nimbus.extension.json"), "utf8"),
        );
        hitl = (manifest as Record<string, unknown>)["hitlRequired"];
      } catch {
        hitl = ["write"]; // unreadable: fail safe, as upstream's launcher does
      }
      if (Array.isArray(hitl) && hitl.some((h) => h === "write" || h === "delete")) {
        declared.push(id);
      }
    }
    expect(declared.length).toBeGreaterThanOrEqual(30);
    expect(declared.filter((id) => !origins.has(id))).toEqual([]);
  });

  test("an unclassified write is reported in every shape the scan follows", () => {
    // The guard's own failure condition, proven per shape: each fixture registers only `fx_*`
    // ids no predicate names, so each must come back unclassified — through the same function the
    // real-package test above uses.
    for (const fixture of SHAPE_FIXTURES) {
      const scan = scanWriteToolRegistrations(fixture.sources);
      expect(scan.violations, fixture.shape).toEqual([]);
      expect(
        unclassifiedWrites(scan)
          .map((r) => r.id)
          .sort(),
        fixture.shape,
      ).toEqual([...fixture.ids].sort());
    }
  });
});
