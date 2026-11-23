import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { REPO_ROOT, read } from "../../test/helpers/security-invariants.ts";

describe("I5 — LAN method allowlist is intrinsic to LanServer", () => {
  test("lan-server.ts calls checkLanMethodAllowed before forwarding to onMessage", async () => {
    const src = await read("packages/gateway/src/ipc/lan-server.ts");
    expect(src).toMatch(/checkLanMethodAllowed\(/);
  });

  test("FORBIDDEN_OVER_LAN includes the exfiltration namespaces", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    for (const ns of ["vault", "updater", "lan", "profile", "audit", "data"]) {
      expect(src).toMatch(new RegExp(`"${ns}"`));
    }
    expect(src).toMatch(/"connector\.addMcp"/);
  });

  test("FORBIDDEN_OVER_LAN blocks index.reembed* (T6 PR 3)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"index\.reembed"/);
    expect(src).toMatch(/"index\.reembedCancel"/);
  });

  test("FORBIDDEN_OVER_LAN blocks index.regraph (rewrites the graph a paired peer must not churn)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"index.regraph"/);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    expect(() =>
      checkLanMethodAllowed("index.regraph", { peerId: "peer:x", writeAllowed: true }),
    ).toThrow(/ERR_METHOD_NOT_ALLOWED/);
  });

  test("FORBIDDEN_OVER_LAN blocks index.rebody* (drives outbound third-party API traffic)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"index\.rebody"/);
    expect(src).toMatch(/"index\.rebodyCancel"/);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // Fully forbidden, not merely write-gated: unlike index.reembed (local CPU recompute),
    // rebody spends the owner's own third-party API quota/rate limits — a stronger reason, so
    // this must never be reachable by a paired peer regardless of grant-write.
    expect(() => checkLanMethodAllowed("index.rebody", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    expect(() => checkLanMethodAllowed("index.rebodyCancel", peer)).toThrow(
      /ERR_METHOD_NOT_ALLOWED/,
    );
  });

  test("I5: oncall.now is refused over LAN by the WHOLE-namespace `oncall` entry (MB3)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    // A later narrowing of the namespace entry to per-method entries must be a deliberate edit.
    expect(src).toMatch(/^\s*"oncall",\s*$/m);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    for (const writeAllowed of [true, false]) {
      for (const m of ["oncall.now", "oncall.handoff"]) {
        expect(() => checkLanMethodAllowed(m, { peerId: "peer:x", writeAllowed })).toThrow(
          /ERR_METHOD_NOT_ALLOWED/,
        );
      }
    }
  });

  test("I5: the briefing namespace is refused over LAN by a WHOLE-namespace `briefing` entry (MB5)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    // A later narrowing of the namespace entry to per-method entries must be a deliberate edit.
    expect(src).toMatch(/^\s*"briefing",\s*$/m);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    for (const m of [
      "briefing.latest",
      "briefing.list",
      "briefing.get",
      "briefing.status",
      "briefing.runNow",
    ]) {
      for (const writeAllowed of [true, false]) {
        expect(() => checkLanMethodAllowed(m, { peerId: "peer:x", writeAllowed })).toThrow(
          /ERR_METHOD_NOT_ALLOWED/,
        );
      }
    }
  });

  test("I5: the incident namespace is refused over LAN by a WHOLE-namespace `incident` entry (IC3)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    // A later narrowing of the namespace entry to per-method entries must be a deliberate edit.
    expect(src).toMatch(/^\s*"incident",\s*$/m);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    for (const m of ["incident.list", "incident.get", "incident.assemble", "incident.timeline"]) {
      for (const writeAllowed of [true, false]) {
        expect(() => checkLanMethodAllowed(m, { peerId: "peer:x", writeAllowed })).toThrow(
          /ERR_METHOD_NOT_ALLOWED/,
        );
      }
    }
    // negative controls: a namesake in another namespace is not caught by the entry
    for (const m of ["agents.incident", "federation.query"]) {
      expect(() =>
        checkLanMethodAllowed(m, { peerId: "peer:x", writeAllowed: false }),
      ).not.toThrow();
    }
  });

  /** The renderer-callable incident reads, in the Rust list's sorted order (IC10a + IC10b). */
  const INCIDENT_RENDERER_READS = [
    "incident.findings",
    "incident.get",
    "incident.list",
    "incident.proposals",
    "incident.timeline",
  ];

  test("I7 (IC10a, IC10b): exactly the five incident reads are renderer-callable; the allowlist is 141", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
    const end = rust.indexOf("];", start);
    const list = rust.slice(start, end);
    // by NAME: a one-for-one swap (assemble for timeline) would keep the count
    expect([...list.matchAll(/"(incident\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual(
      INCIDENT_RENDERER_READS,
    );
    // outside the list, only a NEGATIVE pin (`!is_method_allowed("incident.assemble")`) or a positive pin
    // of one of the five reads may name an incident method
    const rest = rust.slice(0, start) + rust.slice(end);
    for (const m of rest.matchAll(/"(incident\.[A-Za-z]+)"/g)) {
      const at = m.index ?? 0;
      const ctx = rest.slice(Math.max(0, at - 40), at);
      const negated = /!\s*is_method_allowed\($/.test(ctx);
      const positiveRead = INCIDENT_RENDERER_READS.includes(m[1] as string);
      // the Rust test's denial array lists one refused method per line
      const denialLine = /^\s*$/.test(
        rest.slice(rest.lastIndexOf(String.fromCharCode(10), at - 1) + 1, at),
      );
      expect(negated || positiveRead || denialLine).toBe(true);
    }
    expect(rust).toMatch(/^\s*"incident\.assemble",\s*$/m); // the Rust denial list names it
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*141\s*\)/);
    // the Rust denial list names the methods that must stay off the renderer
    for (const m of ["assemble", "advisory", "advisorySet", "remediate", "undo"]) {
      expect(rust).toMatch(new RegExp(String.raw`^\s*"incident\.${m}",\s*$`, "m"));
    }
  });

  test("I7 (IaC drift desktop view): exactly iac.driftLatest is renderer-callable; driftCheck stays CLI-only and the namespace off the LAN", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
    const end = rust.indexOf("];", start);
    const list = rust.slice(start, end);
    // by NAME: swapping `iac.driftLatest` for `iac.driftCheck` would keep the count
    expect([...list.matchAll(/"(iac\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual(["iac.driftLatest"]);
    expect(rust).toContain(
      'is_method_allowed("iac.driftLatest") && !is_method_allowed("iac.driftCheck")',
    );
    const rpc = await read("packages/gateway/src/ipc/iac-drift-rpc.ts");
    // the check is cli-only; the read also answers the desktop's declared kind
    expect(rpc).toContain('runnerOf(c, caller.kind, ["cli"], IAC_DRIFT_CLI_ONLY)');
    expect(rpc).toContain('runnerOf(c, caller.kind, ["cli", "ui"], IAC_DRIFT_OWNER_ONLY)');
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toMatch(/^\s*"iac",\s*$/m);
    // the page calls only the one read and builds no HTML from gateway text
    const page = await read("packages/ui/src/pages/Infrastructure.tsx");
    expect(page).not.toContain("dangerouslySetInnerHTML");
    expect(page).not.toContain("innerHTML");
    expect(page).not.toContain("iac.driftCheck");
    expect([...page.matchAll(/"(iac\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual(["iac.driftLatest"]);
  });

  test("I7 (S4 marketplace tile): exactly three registry reads are renderer-callable; install, add, refresh, remove and clone stay off", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
    const end = rust.indexOf("];", start);
    const list = rust.slice(start, end);
    // by NAME: swapping `registry.search` for `registry.install` would keep the count
    expect([...list.matchAll(/"(registry\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual([
      "registry.info",
      "registry.list",
      "registry.search",
    ]);
    expect(list).not.toMatch(/"extension\.install"/);
    expect(list).not.toMatch(/"extension\.approveRun"/);
    // the Rust denial list names each write-class registry method
    for (const m of ["add", "remove", "refresh", "install", "cloneSource"]) {
      expect(rust).toMatch(new RegExp(String.raw`^\s*"registry\.${m}",\s*$`, "m"));
    }
    // the registry namespace stays off the LAN (I5)
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toMatch(/^\s*"registry",\s*$/m);
  });

  test("I7/I5 (IC10a): each renderer-callable incident read still gates on the DECLARED kind first, the bridge declares ui, and the namespace is off the LAN", async () => {
    const rpc = await read("packages/gateway/src/ipc/incident-rpc.ts");
    for (const m of [...INCIDENT_RENDERER_READS, "incident.assemble"]) {
      const at = rpc.indexOf(`"${m}": `);
      expect(at).toBeGreaterThan(0);
      expect(rpc.slice(at, at + 140)).toContain("requireOwnerKind(caller.kind);");
    }
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/"method": "session\.declareKind",\s*"params": \{ "kind": "ui" \}/);
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toMatch(/^\s*"incident",\s*$/m);
  });

  test("I8 (IC10a, IC10b): the Incidents page renders gateway text only as React text or through Markdown, and calls only the five reads", async () => {
    const files = [
      "packages/ui/src/pages/Incidents.tsx",
      ...(await readdir(resolve(REPO_ROOT, "packages/ui/src/components/incidents"))).map(
        (f) => `packages/ui/src/components/incidents/${f}`,
      ),
    ];
    for (const f of files) {
      const src = await read(f);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toContain("innerHTML");
      expect(src).not.toContain("incident.assemble");
      for (const m of src.matchAll(/"(incident\.[A-Za-z]+)"/g)) {
        expect(INCIDENT_RENDERER_READS).toContain(m[1] as string);
      }
    }
  });

  test("I29/MB3: the JSM on-call step names its fixed host once and sends every request with redirect manual", async () => {
    const src = await read("packages/gateway/src/connectors/jsm-oncall.ts");
    const code = stripComments(src);
    expect([...code.matchAll(/https:\/\//g)]).toHaveLength(1);
    expect(code).toMatch(/JSM_OPS_ROOT\s*=\s*"https:\/\/api\.atlassian\.com\/jsm\/ops\/api"/);
    const fetches = [...code.matchAll(/\bfetch\(/g)];
    expect(fetches).toHaveLength(1);
    const call = code.slice(code.indexOf("fetch("), code.indexOf("fetch(") + 400);
    expect(call).toContain('redirect: "manual"');
    // The cloud id is validated before it enters a path.
    expect(code).toContain("isAtlassianCloudId(");
  });

  test("I29/IC2: the JSM alert pass has no fetch, no https literal and no redirect of its own and reuses the on-call request function", async () => {
    for (const file of ["jsm-alerts.ts", "jsm-alert-mapping.ts"]) {
      const code = stripComments(await read(`packages/gateway/src/connectors/${file}`));
      expect(code, file).not.toMatch(/\bfetch\(/);
      expect(code, file).not.toContain("https://");
      expect(code, file).not.toMatch(/redirect\s*:/);
    }
    const alerts = stripComments(await read("packages/gateway/src/connectors/jsm-alerts.ts"));
    expect(alerts).toMatch(
      /import\s*\{[^}]*\bjsmGet\b[^}]*\bresolveCloudId\b[^}]*\}\s*from\s*"\.\/jsm-oncall\.ts"/s,
    );
  });

  test("FORBIDDEN_OVER_LAN blocks extension.checkForUpdates + extension.update (T2 PR 3)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"extension\.checkForUpdates"/);
    expect(src).toMatch(/"extension\.update"/);
  });

  test("FORBIDDEN_OVER_LAN blocks share.create + share.prune + share.approvalRespond (Slice 8 / I27)", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // The outbound chokepoint, the local prune, and the LOCAL-owner approval answer are all
    // un-callable over the wire — a remote peer must never approve/trigger an outbound publish.
    expect(() => checkLanMethodAllowed("share.create", peer)).toThrow();
    expect(() => checkLanMethodAllowed("share.prune", peer)).toThrow();
    expect(() => checkLanMethodAllowed("share.approvalRespond", peer)).toThrow();
    // Read-only share methods remain admitted (gated downstream like federation reads).
    expect(() => checkLanMethodAllowed("share.verify", peer)).not.toThrow();
  });

  test("FORBIDDEN_OVER_LAN blocks the whole exec namespace (S2 slice 1 / I33)", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // exec.run is the arbitrary-code-execution surface itself. exec.approvalRespond matters just
    // as much: admitting it would let a paired peer APPROVE code running on the owner's machine,
    // which defeats the I33 gate without ever calling exec.run over the wire.
    expect(() => checkLanMethodAllowed("exec.run", peer)).toThrow();
    expect(() => checkLanMethodAllowed("exec.approvalRespond", peer)).toThrow();
    // Namespace-level, so a future exec.* verb is forbidden by default rather than by memory.
    expect(() => checkLanMethodAllowed("exec.anythingAddedLater", peer)).toThrow();
  });

  test("FORBIDDEN_OVER_LAN blocks the whole computer namespace (S2 slice 2 — computer-use gate)", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // computer.act drives the owner's machine. computer.approvalRespond matters just as much:
    // admitting it would let a paired peer APPROVE an actuation on the owner's machine, defeating
    // the computer-use gate without ever calling computer.act over the wire.
    expect(() => checkLanMethodAllowed("computer.act", peer)).toThrow();
    expect(() => checkLanMethodAllowed("computer.approvalRespond", peer)).toThrow();
    // Namespace-level, so a future computer.* verb is forbidden by default rather than by memory.
    expect(() => checkLanMethodAllowed("computer.anythingAddedLater", peer)).toThrow();
  });

  test("FORBIDDEN_OVER_LAN covers toolgen.invoke via the namespace entry", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // The namespace entry already exists; this asserts it REACHES a method added later,
    // by calling the function rather than grepping the source for "toolgen".
    expect(() => checkLanMethodAllowed("toolgen.invoke", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
  });

  test("FORBIDDEN_OVER_LAN blocks filesystem.ensureRoot (Stage 2a)", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // Blame-root registration is a local-only owner action; a remote peer must never be able
    // to add an indexing root on this machine.
    expect(() => checkLanMethodAllowed("filesystem.ensureRoot", peer)).toThrow(
      /ERR_METHOD_NOT_ALLOWED/,
    );
  });

  test("admits the team-vault wire methods but FORBIDS team-vault/HITL management over LAN (Slice 2)", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // The three answerable wire methods are admitted (gated downstream by I19 RBAC + quorum).
    for (const m of [
      "federation.invoke",
      "federation.quorumRespond",
      "federation.approvalRespond",
    ]) {
      expect(() => checkLanMethodAllowed(m, peer)).not.toThrow();
    }
    // Management/secret surfaces are local-only — never callable over the wire.
    for (const m of [
      "teamvault.put",
      "teamvault.delete",
      "teamvault.grant",
      "teamvault.revoke",
      "teamvault.list",
      "hitl.delegate",
      "hitl.revokeDelegation",
      "hitl.listDelegations",
      "hitl.pendingQueue",
    ]) {
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(/not callable over LAN/);
    }
  });

  test("FORBIDDEN_OVER_LAN blocks the clip namespace (I30 — pairing must stay owner-opened)", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // clip.pair opens the I30 pairing window and returns the one-time code in its response; a
    // paired LAN peer must never be able to call it and mint its own token without the owner
    // running `nimbus clip pair`. Checked on two methods to prove the namespace entry, not a
    // single-method coincidence.
    expect(() => checkLanMethodAllowed("clip.pair", peer)).toThrow(/not callable over LAN/);
    expect(() => checkLanMethodAllowed("clip.status", peer)).toThrow(/not callable over LAN/);
  });

  test("FORBIDDEN_OVER_LAN blocks the whole ask namespace (explain last carries the owner's question)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"ask"/);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // checkLanMethodAllowed is a DENYLIST: everything not named is ALLOWED. Without the "ask"
    // entry this method ships reachable by any paired peer, handing them the owner's question
    // text and the titles of the owner's indexed items (spec §3.2).
    expect(() => checkLanMethodAllowed("ask.explainLast", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
  });

  test("FORBIDDEN_OVER_LAN names both local-auth methods (a new connector.* method is LAN-reachable by default)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"connector\.detectLocalAuth"/);
    expect(src).toMatch(/"connector\.adoptLocalAuth"/);
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    expect(() => checkLanMethodAllowed("connector.adoptLocalAuth", peer)).toThrow(
      /ERR_METHOD_NOT_ALLOWED/,
    );
  });

  test("FORBIDDEN_OVER_LAN names the three connector write opt-in methods by name", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    for (const m of [
      "connector.writesEnable",
      "connector.writesDisable",
      "connector.writesStatus",
    ]) {
      expect(src).toContain(`"${m}"`);
      expect(() => checkLanMethodAllowed(m, peer), m).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    }
  });
});
