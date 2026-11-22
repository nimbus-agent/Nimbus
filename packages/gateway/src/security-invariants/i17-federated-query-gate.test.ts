import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO_ROOT, read } from "../../test/helpers/security-invariants.ts";

describe("I17 — federated answering is intrinsic to the query gate", () => {
  test("only query-gate.ts imports the item-list read path under federation/", async () => {
    const dir = "packages/gateway/src/federation";
    const files = (await readdir(resolve(REPO_ROOT, dir))).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(files).toContain("query-gate.ts"); // guard: the gate file exists
    for (const f of files) {
      const src = await read(`${dir}/${f}`);
      const importsItemRead = /from\s+["'][^"']*item-list-query/.test(src);
      if (f === "query-gate.ts") {
        expect(importsItemRead).toBe(true);
      } else {
        expect(importsItemRead).toBe(false);
      }
    }
  });

  test("only read-only federation answers (query/expertise/policy/auditExport) are admitted over LAN; management/asker methods + the team namespace are forbidden", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    for (const m of [
      "federation.namespace.publish",
      "federation.namespace.grant",
      "federation.namespace.revoke",
      "federation.pair",
      "federation.peers",
      "federation.discover",
      // local-only owner/asker methods — never answerable over the wire (Slice 1 over-the-wire)
      "federation.consentRespond",
      "federation.ask",
      "federation.askExpertise",
    ]) {
      expect(src).toContain(`"${m}"`); // present in FORBIDDEN_OVER_LAN
    }
    // The whole `team` namespace (team.auditMerged — the local-only asker that fans out
    // federation.auditExport) is forbidden over LAN; only the answerer side is admitted.
    expect(src).toContain('"team"');
  });

  test("I17/R1 — the over-the-wire answerer forces peerId from the authenticated session (not the request body)", async () => {
    const src = await read("packages/gateway/src/federation/federation-server.ts");
    // onMessage must override any body-supplied peerId with the NaCl-authenticated peer.peerId.
    expect(src).toMatch(/peerId:\s*peer\.peerId/);
  });
});
