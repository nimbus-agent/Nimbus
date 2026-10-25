/**
 * Act-door routing sync (spec § 6.3): every PROPOSABLE_WRITE_TOOLS row is a write the INSTALLED
 * `@nimbus-dev/connectors` registers under that exact tool id, declaring `mutates` equal to the
 * action type, in the connector whose mesh server is `serviceOf(actionType)`. A connectors bump that
 * renames or re-scopes a proposable tool fails here, not at an owner's accept.
 */
import { describe, expect, test } from "bun:test";

import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { serviceOf } from "../engine/service-of.ts";
import { CONNECTOR_SERVICE_IDS } from "./connector-catalog.ts";
import { MESH_ONLY_SERVER_IDS } from "./lazy-mesh/tool-map.ts";
import { PROPOSABLE_WRITE_TOOLS } from "./proposable-actions.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "./testing/connector-write-registrations.ts";
import { resolveRegistrationMutates } from "./testing/registration-mutates.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "./user-mcp-store.ts";

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

/** The mesh server a registration belongs to: its origin connector directory, `-` → `_`. */
function serverOf(origin: string): string {
  return (origin.split("/")[1] ?? "").replaceAll("-", "_");
}

describe("act-door routing table vs the installed connectors package", () => {
  for (const [type, tool] of Object.entries(PROPOSABLE_WRITE_TOOLS)) {
    test(`${type} → ${tool}`, () => {
      const hits = SCAN.registrations.filter(
        (r) => r.id === tool && serverOf(r.origin) === serviceOf(type),
      );
      expect(hits, `no write registered as ${tool} on server ${serviceOf(type)}`).toHaveLength(1);
      expect(resolveRegistrationMutates(SOURCES, hits[0] as (typeof hits)[number])).toEqual({
        value: type,
      });
    });
  }

  test("guard: the span offsets index the comment-stripped text (the call reads back whole)", () => {
    const r = SCAN.registrations.find((x) => x.id === "slack_message_post");
    expect(r).toBeDefined();
    const src = SOURCES.find((s) => s.rel === r?.file);
    const call = stripComments(src?.text ?? "").slice(r?.span[0] ?? 0, (r?.span[1] ?? 0) + 1);
    expect(call.startsWith("(")).toBe(true);
    expect(call.endsWith(")")).toBe(true);
    expect(call).toContain('"slack_message_post"');
  });

  /*
   * `resolveServerTool` (lazy-mesh/tool-map.ts) answers an EXACT key before it builds
   * `<server>_<toolId>`. MCPClient lists every tool as `<server>_<tool>`, so a bare id `t` can be
   * captured by an exact match only through a server `srv` with `t === `${srv}_${x}`` and a tool
   * named `x` on it. Enumerate those (srv, x) pairs and prove none exists. Stated bound: the scan
   * enumerates WRITE registrations exactly, but read tools are registered through many per-connector
   * registrar shapes it does not model, so for those this checks the conservative over-approximation
   * "`x` appears nowhere in `srv`'s source as a whole quoted literal" — a name built from a template
   * would evade it.
   */
  describe("no bare routing id is itself a listed key of any server", () => {
    function collisionCandidates(bareId: string): Array<{ server: string; tool: string }> {
      // Every first-party mesh server, the mesh-only ones (obsidian) included.
      return [...CONNECTOR_SERVICE_IDS, ...MESH_ONLY_SERVER_IDS]
        .filter((srv) => bareId.startsWith(`${srv}_`))
        .map((srv) => ({
          server: srv,
          tool: bareId.slice(srv.length + 1),
        }));
    }
    function sourcesOfServer(server: string): string[] {
      return SOURCES.filter(
        (s) => s.rel.startsWith("connectors/") && serverOf(s.rel) === server,
      ).map((s) => stripComments(s.text));
    }
    function quotedLiteral(name: string): RegExp {
      return new RegExp(String.raw`(["'\x60])${name}\1`);
    }

    for (const tool of Object.values(PROPOSABLE_WRITE_TOOLS)) {
      test(tool, () => {
        // A user-MCP server (`mcp_*`) can be named anything matching the pattern, so no bare id
        // may live in that namespace at all.
        expect(USER_MCP_SERVICE_ID_PATTERN.test(tool) || tool.startsWith("mcp_")).toBe(false);
        for (const c of collisionCandidates(tool)) {
          const writes = SCAN.registrations.filter(
            (r) => r.id === c.tool && serverOf(r.origin) === c.server,
          );
          expect(writes, `${c.server} registers a write named ${c.tool}`).toEqual([]);
          const re = quotedLiteral(c.tool);
          const hit = sourcesOfServer(c.server).some((t) => re.test(t));
          expect(hit, `${c.server}'s source names a tool-like literal "${c.tool}"`).toBe(false);
        }
      });
    }

    test("guard: the candidate enumeration finds the server a bare id is spelled under", () => {
      expect(collisionCandidates("slack_message_post")).toEqual([
        { server: "slack", tool: "message_post" },
      ]);
      expect(collisionCandidates("obsidian_append_to_daily_note")).toEqual([
        { server: "obsidian", tool: "append_to_daily_note" },
      ]);
      expect(sourcesOfServer("obsidian").length).toBeGreaterThan(0);
      expect(
        quotedLiteral("obsidian_append_to_daily_note").test(sourcesOfServer("obsidian").join("\n")),
      ).toBe(true);
      expect(sourcesOfServer("slack").length).toBeGreaterThan(0);
      expect(quotedLiteral("slack_message_post").test(sourcesOfServer("slack").join("\n"))).toBe(
        true,
      );
    });
  });
});
