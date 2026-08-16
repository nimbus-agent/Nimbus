import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import {
  assertScanIsMeaningful,
  checkAgentEmitterImportConfinement,
  checkConnectorWriteConfinement,
  checkEgressChokepointConfinement,
  checkForwardShareConfinement,
  checkShareConsentBrokerConfinement,
  checkSharePublishConfinement,
  checkSpawnInvariant,
  checkVaultKeyAllowList,
  checkWrapServerSpecInvariant,
  collectDbRunCensus,
  DB_RUN_EXEC_ALLOW_LIST,
  type FileEntry,
  findDirectDbRunExec,
  RULE_ANCHORS,
  VAULT_KEY_ALLOW_LIST,
} from "./check-nimbus-invariants.ts";
import { REPO_ROOT, stripComments } from "./lib.ts";

describe("D10-wrap-spec — every ServerSpec literal reaches the sandbox (per SITE, not per file)", () => {
  const LM = "packages/gateway/src/connectors/lazy-mesh";
  const spec = '{ ...connectorSpawn("slack"), env: extensionProcessEnv({ TOKEN: t }) }';

  test("accepts a spec wrapped by the file-local `wrap` helper", () => {
    expect(
      checkWrapServerSpecInvariant([
        { relPath: `${LM}/connector-spawns.ts`, contents: `slack: wrap(${spec}, "slack", ctx),` },
      ]),
    ).toHaveLength(0);
  });

  test("accepts a spec wrapped by wrapServerSpec directly", () => {
    expect(
      checkWrapServerSpecInvariant([
        {
          relPath: `${LM}/mesh.ts`,
          contents: `filesystem: wrapServerSpec(${spec}, manifest, cwd),`,
        },
      ]),
    ).toHaveLength(0);
  });

  test("flags ONE unwrapped site in a file whose other sites are wrapped", () => {
    // The defect this replaces. The rule used to short-circuit on `wrapServerSpec(` appearing
    // ANYWHERE in the file, so a single site could drop the wrapper and stay green — and
    // `connector-spawns.ts` funnels 26 MCPClient spawns through one `wrap` helper, so its
    // `wrapServerSpec(` token survives any per-site removal. Reproduced against the real file:
    // unwrapping one site left 6 `wrapServerSpec(` tokens and the old rule reported clean.
    // Consequence of a miss is not cosmetic: that child runs with a live OAuth token in its env
    // and no landlock/seccomp/seatbelt profile.
    const violations = checkWrapServerSpecInvariant([
      {
        relPath: `${LM}/connector-spawns.ts`,
        contents: [
          `function wrap(s: ServerSpec, id: string, ctx: MeshSpawnContext): ServerSpec {`,
          `  return wrapServerSpec(s, manifestForFirstParty(id), ctx.sandboxCwd);`,
          `}`,
          `const a = { github: wrap(${spec}, "github", ctx) };`,
          `const b = { slack: ${spec} };`,
        ].join("\n"),
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(5);
  });

  test("flags a bare spec nested inside `new MCPClient({ servers: { … } })`", () => {
    // The enclosing call is `MCPClient`, not `wrap` — which is precisely the distinction the
    // rule reads. An object literal is not a call boundary, so the walk has to pass through
    // `{ servers: { slack: … } }` to find it.
    expect(
      checkWrapServerSpecInvariant([
        {
          relPath: `${LM}/connector-spawns.ts`,
          contents: `new MCPClient({ id, servers: { slack: ${spec} } });`,
        },
      ]),
    ).toHaveLength(1);
  });

  test("ignores files outside lazy-mesh and the declared exemptions", () => {
    expect(
      checkWrapServerSpecInvariant([
        { relPath: "packages/gateway/src/voice/service.ts", contents: `x: ${spec}` },
        { relPath: `${LM}/wrap-server-spec.ts`, contents: `x: ${spec}` },
        { relPath: `${LM}/slot.ts`, contents: `x: ${spec}` },
      ]),
    ).toHaveLength(0);
  });
});

describe("D10 — checkSpawnInvariant (under connectors/)", () => {
  test("flags `Bun.spawn` not via extensionProcessEnv", () => {
    const violations = checkSpawnInvariant([
      {
        relPath: "packages/gateway/src/connectors/lazy-mesh.ts",
        contents: 'const p = Bun.spawn(["x"], { env: { ...process.env } });',
      },
    ]);
    expect(violations).toHaveLength(1);
  });

  test("accepts spawn that calls extensionProcessEnv", () => {
    const violations = checkSpawnInvariant([
      {
        relPath: "packages/gateway/src/connectors/lazy-mesh.ts",
        contents: 'const p = Bun.spawn(["x"], { env: extensionProcessEnv() });',
      },
    ]);
    expect(violations).toHaveLength(0);
  });

  test("ignores spawn outside connectors/", () => {
    const violations = checkSpawnInvariant([
      {
        relPath: "packages/gateway/src/voice/service.ts",
        contents: 'const p = Bun.spawn(["whisper"], { env: { ...process.env } });',
      },
    ]);
    expect(violations).toHaveLength(0);
  });
});

describe("D11 — checkVaultKeyAllowList", () => {
  const ALLOW_LIST = [
    "packages/gateway/src/connectors/connector-vault.ts",
    "packages/gateway/src/auth/google-access-token.ts",
    "packages/gateway/src/auth/pkce.ts",
  ];

  test("flags vault-key construction outside allow-list", () => {
    const violations = checkVaultKeyAllowList(
      [
        {
          relPath: "packages/gateway/src/connectors/some-other.ts",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
          contents: "const k = `${service}.oauth`;",
        },
      ],
      ALLOW_LIST,
    );
    expect(violations).toHaveLength(1);
  });

  test("ignores construction in allow-listed files", () => {
    const violations = checkVaultKeyAllowList(
      [
        {
          relPath: "packages/gateway/src/connectors/connector-vault.ts",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
          contents: "export function k(s: string) { return `${s}.oauth`; }",
        },
      ],
      ALLOW_LIST,
    );
    expect(violations).toHaveLength(0);
  });

  test("ignores vault-key when previous line has audit-ignore-next-line D11-vault-key marker", () => {
    const violations = checkVaultKeyAllowList(
      [
        {
          relPath: "packages/gateway/src/connectors/some-other.ts",
          contents:
            "// audit-ignore-next-line D11-vault-key (manifest entry, not vault-key construction)\n" +
            'const entry = "slack.oauth";',
        },
      ],
      ALLOW_LIST,
    );
    expect(violations).toHaveLength(0);
  });

  test("still flags vault-key when no opt-out marker is on previous line", () => {
    const violations = checkVaultKeyAllowList(
      [
        {
          relPath: "packages/gateway/src/connectors/some-other.ts",
          contents: "// just a regular comment\n" + 'const entry = "slack.oauth";',
        },
      ],
      ALLOW_LIST,
    );
    expect(violations).toHaveLength(1);
  });
});

describe("D11 — VAULT_KEY_ALLOW_LIST is frozen at structural entries", () => {
  test("VAULT_KEY_ALLOW_LIST has exactly 9 entries", () => {
    expect(VAULT_KEY_ALLOW_LIST).toHaveLength(9);
  });
});

describe("D11 — manifest-derived VAULT_KEY_RE", () => {
  test("matches representative manifest entries", () => {
    const keys = Object.values(CONNECTOR_VAULT_SECRET_KEYS).flat();
    for (const sample of [
      "jira.api_token",
      "aws.access_key_id",
      "bitbucket.app_password",
      "datadog.app_key",
      "iac.enabled",
    ] as const) {
      expect(keys).toContain(sample);
      expect(`vault.set("${sample}", x)`).toMatch(/['"`][a-z0-9_]+\.[a-z0-9_]+['"`]/);
    }
  });

  test("does not match non-manifest literals", () => {
    const keys = Object.values(CONNECTOR_VAULT_SECRET_KEYS).flat();
    expect(keys).not.toContain("console.log");
    expect(keys).not.toContain("path.to.file");
  });
});

describe("D12 — collectDbRunCensus (diagnostic census, allowList = [])", () => {
  test("collects db.run() outside db/write.ts", () => {
    const census = collectDbRunCensus([
      {
        relPath: "packages/gateway/src/something/foo.ts",
        contents: "function bar() {\n  db.run('CREATE TABLE x ...');\n}",
      },
    ]);
    expect(census).toEqual([
      {
        file: "packages/gateway/src/something/foo.ts",
        line: 2,
        function: "bar",
        snippet: "db.run('CREATE TABLE x ...');",
      },
    ]);
  });

  test("also collects db.run() inside db/write.ts (census uses allowList = [])", () => {
    const census = collectDbRunCensus([
      {
        relPath: "packages/gateway/src/db/write.ts",
        contents: "db.run('SELECT 1');",
      },
    ]);
    expect(census).toHaveLength(1);
  });
});

describe("D12 — direct db.run / db.exec outside allow-list", () => {
  test("flags a synthetic file with a bare db.run call", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents: "function w(db: Database) { db.run('UPDATE t SET n = 1'); }",
      },
    ];
    const hits = findDirectDbRunExec(files);
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("packages/gateway/src/synthetic.ts");
  });

  test("flags a synthetic file with this.db.exec", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents: "class S { run() { this.db.exec('CREATE TABLE t (n INT)'); } }",
      },
    ];
    const hits = findDirectDbRunExec(files);
    expect(hits.length).toBe(1);
  });

  test("flags a synthetic file with ctx.db.run", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents: "function h(ctx: SyncCtx) { ctx.db.run('UPDATE t SET n = 1'); }",
      },
    ];
    const hits = findDirectDbRunExec(files);
    expect(hits.length).toBe(1);
  });

  test("does NOT flag dbRun / dbExec / dbStmtRun calls", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents: `
          dbRun(db, "UPDATE t SET n = 1");
          dbExec(db, "PRAGMA query_only = ON");
          dbStmtRun(stmt, 1, 2, 3);
        `,
      },
    ];
    const hits = findDirectDbRunExec(files);
    expect(hits.length).toBe(0);
  });

  test("does NOT flag calls in the allow-listed wrapper file", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/db/write.ts",
        contents: "function dbRun(db: Database, sql: string) { db.run(sql); }",
      },
    ];
    const hits = findDirectDbRunExec(files);
    expect(hits.length).toBe(0);
  });

  test("DB_RUN_EXEC_ALLOW_LIST contains exactly the wrapper file", () => {
    expect([...DB_RUN_EXEC_ALLOW_LIST]).toEqual(["packages/gateway/src/db/write.ts"]);
  });

  // The receiver name is the part that failed open. `\b` cannot match between the `w` and the `D`
  // of `rawDb`, so the old pattern's `db.` was unreachable for every alias — and two DELETEs on
  // the production `data.delete` path sat behind that gap, reported clean, for the life of the
  // rule. Each spelling below is a real one from the tree, not an invented shape.
  test.each([
    [
      "a dotted alias receiver",
      "input.index.rawDb.run(`DELETE FROM item WHERE service = ?`, [s]);",
    ],
    ["a bare alias receiver", "rawDb.run('DELETE FROM item');"],
    ["a capitalised suffix", "const n = myDB.exec('VACUUM');"],
  ])("flags %s", (_label, contents) => {
    expect(
      findDirectDbRunExec([{ relPath: "packages/gateway/src/synthetic.ts", contents }]),
    ).toHaveLength(1);
  });

  test("flags the prepared-statement form, including across a line break", () => {
    // `docs/SECURITY-INVARIANTS.md` has named `stmt.run(` an anti-pattern since I14 was written,
    // and `dbStmtRun` has existed to wrap it, but no rule ever looked for it. The line break is
    // the case that matters: the SQL is what pushes `.run(` onto its own line.
    const hits = findDirectDbRunExec([
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents: [
          "const rows = this.db",
          "  .query(`UPDATE sync_state SET depth = ? WHERE connector_id = ?`)",
          "  .run(depth, serviceId);",
        ].join("\n"),
      },
    ]);
    expect(hits).toHaveLength(1);
    // Reported at the `.query(` line, which is where a reader has to edit.
    expect(hits[0]?.line).toBe(2);
  });

  test("does NOT flag a read through the same statement shape", () => {
    // `.query(...).get(...)` / `.all(...)` are the overwhelmingly common form in this tree; a rule
    // that flagged them would be reverted within a day, which is its own kind of unenforced.
    const hits = findDirectDbRunExec([
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents:
          "const r = this.db.query(`SELECT depth FROM sync_state`).get(id);\nconst a = db.query(`SELECT 1`).all();",
      },
    ]);
    expect(hits).toHaveLength(0);
  });

  test("does NOT flag the receivers that dominate `.run(`/`.exec(` in this tree", () => {
    // Surveyed before widening: of 71 `.run(`/`.exec(` sites in production source, the great
    // majority are `RegExp.exec`, plus `AgentCoordinator.run` and `AsyncLocalStorage.run`. If the
    // widened receiver pattern caught any of them the rule would be noise, so this pins the
    // negative side explicitly rather than trusting that it stayed narrow.
    const hits = findDirectDbRunExec([
      {
        relPath: "packages/gateway/src/synthetic.ts",
        contents: [
          "const m = GITHUB_PR_URL_RE.exec(url);",
          "const results = await coordinator.run(tasks);",
          "return await agentRequestContext.run(store, fn);",
          "const outcome = await deps.run(s.tool, s.params);",
          "const parsed = /^(\\d+)$/i.exec(s);",
        ].join("\n"),
      },
    ]);
    expect(hits).toHaveLength(0);
  });

  test("the widened receiver pattern is linear, not quadratic", () => {
    // A correctness test cannot tell linear from catastrophic backtracking, and the widened
    // pattern puts a quantified prefix in front of a required literal — the exact shape that
    // goes quadratic on a long word-character run. This scans every line of every source file,
    // so a pathological line would hang the gate rather than fail it.
    const pathological = `${"a".repeat(40_000)} .run(`;
    const started = performance.now();
    findDirectDbRunExec([{ relPath: "packages/gateway/src/synthetic.ts", contents: pathological }]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("D20 — connector write-id confinement (warehouse/BI ∪ GitOps/ML)", () => {
  test("flags a write tool id referenced outside the allowed sites", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `dispatch("tableau_datasource_refresh")`,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("D20-connector-write");
  });

  test("flags a gitops write tool id literal outside the allowed set", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/engine/agent.ts",
        contents: `const x = "argocd_app_sync";`,
      },
    ]);
    expect(v.some((x) => x.rule === "D20-connector-write")).toBe(true);
  });

  test("does NOT flag the gitops-ml SSoT module", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/gitops-ml-write-tools.ts",
        contents: `w("argocd.app.sync", "argocd_app_sync", "argocd");`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("allows the SSoT, connector servers, and transport/dispatch sites", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/warehouse-write-tools.ts",
        contents: `"tableau_datasource_refresh"`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("requires answerFederatedInvoke to consult isWriteForbiddenToolId", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `export async function answerFederatedInvoke() { return; }`,
      },
    ]);
    expect(v.some((x) => x.rule === "D20-invoke-gate-predicate")).toBe(true);
  });

  test("does NOT flag invoke-gate.ts when it consults isWriteForbiddenToolId", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `if (ctx.isWriteForbiddenToolId?.(q.toolId) === true) audit(ctx, q, "write_forbidden");`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("ignores .test.ts files", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-handler.test.ts",
        contents: `dispatch("tableau_datasource_refresh")`,
      },
    ]);
    expect(v).toHaveLength(0);
  });
});

describe("D21 (I27) extension — createShare call-site + consent-broker wiring confinement", () => {
  const ASSEMBLE = "packages/gateway/src/platform/assemble.ts";

  test("flags createShare named outside the gate + share-rpc sites", () => {
    const v = checkShareConsentBrokerConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `const r = await createShare(req, deps);`,
      },
      // assemble.ts must still be present (with the wiring) so its own check passes.
      { relPath: ASSEMBLE, contents: `shareConsent.request(input, ttl);` },
    ]);
    expect(v.some((x) => x.rule === "D21-createshare-callsite")).toBe(true);
  });

  test("allows createShare in share-gate.ts and share-rpc.ts (their home + the sole wiring file)", () => {
    const v = checkShareConsentBrokerConfinement([
      {
        relPath: "packages/gateway/src/share/share-gate.ts",
        contents: `export async function createShare() {}`,
      },
      {
        relPath: "packages/gateway/src/ipc/share-rpc.ts",
        contents: `const result = await createShare(req, deps);`,
      },
      { relPath: ASSEMBLE, contents: `requestApproval: () => shareConsent.request` },
    ]);
    expect(v).toHaveLength(0);
  });

  test("requires assemble.ts to wire shareConsent.request as the approval dep", () => {
    const v = checkShareConsentBrokerConfinement([
      { relPath: ASSEMBLE, contents: `ipcOpts.shareRpcCtx = { requestApproval: () => true };` },
    ]);
    expect(v.some((x) => x.rule === "D21-share-consent-broker")).toBe(true);
  });

  test("does NOT flag assemble.ts when it wires shareConsent.request", () => {
    const v = checkShareConsentBrokerConfinement([
      {
        relPath: ASSEMBLE,
        contents: `requestApproval: (...a) => shareConsent.request({ ...a }, ttl),`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("ignores .test.ts files (createShare may be named freely in tests)", () => {
    const v = checkShareConsentBrokerConfinement([
      {
        relPath: "packages/gateway/src/ipc/share-rpc.test.ts",
        contents: `await createShare(req, deps);`,
      },
      { relPath: ASSEMBLE, contents: `requestApproval: () => shareConsent.request` },
    ]);
    expect(v).toHaveLength(0);
  });

  test("D21: forwardShare called outside share-forward.ts + federation-rpc.ts is a violation", () => {
    const v = checkForwardShareConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-other.ts",
        contents: "await forwardShare(req, deps);",
      },
    ]);
    expect(v.map((x) => x.rule)).toContain("D21-forwardshare-callsite");
  });

  test("D21: forwardShare called from its home + wiring site is allowed", () => {
    const v = checkForwardShareConfinement([
      {
        relPath: "packages/gateway/src/share/share-forward.ts",
        contents: "export async function forwardShare() {}",
      },
      {
        relPath: "packages/gateway/src/ipc/federation-rpc.ts",
        contents: "await forwardShare(req, deps);",
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("D21: share.publish named in share-forward.ts is allowed (re-forward audit action)", () => {
    const v = checkSharePublishConfinement([
      {
        relPath: "packages/gateway/src/share/share-forward.ts",
        contents: 'actionType: "share.publish"',
      },
    ]);
    expect(v).toHaveLength(0);
  });
});

describe("D22 — egress chokepoint confinement", () => {
  test("flags connectors.dispatch outside engine/executor.ts", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/rogue/bypass.ts",
        contents: "await this.connectors.dispatch(action);\n",
      },
    ];
    const v = checkEgressChokepointConfinement(files);
    expect(v.some((x) => x.rule === "D22-connectors-dispatch")).toBe(true);
  });

  test("allows connectors.dispatch inside engine/executor.ts", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/engine/executor.ts",
        contents: "await this.connectors.dispatch(action);\n",
      },
    ];
    expect(checkEgressChokepointConfinement(files)).toHaveLength(0);
  });

  test("flags appendEgressEntry referenced outside egress/*", () => {
    const files: FileEntry[] = [
      { relPath: "packages/gateway/src/rogue/x.ts", contents: "appendEgressEntry(db, e);\n" },
    ];
    const v = checkEgressChokepointConfinement(files);
    expect(v.some((x) => x.rule === "D22-egress-append")).toBe(true);
  });

  test("allows appendEgressEntry inside egress/*", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/egress/egress-prune.ts",
        contents: "appendEgressEntry(db, e);\n",
      },
    ];
    expect(checkEgressChokepointConfinement(files)).toHaveLength(0);
  });

  test("(c) flags recordAgentBriefEgress named outside its definition and single caller", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/ipc/clip-rpc.ts",
        contents: "recordAgentBriefEgress(db, args);\n",
      },
    ];
    const v = checkEgressChokepointConfinement(files);
    expect(v.some((x) => x.rule === "D22-agent-brief-egress")).toBe(true);
  });

  test("(c) allows recordAgentBriefEgress in its definition file and in agents-rpc.ts", () => {
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/egress/agent-brief-egress.ts",
        contents: "export function recordAgentBriefEgress(db, args) {}\n",
      },
      {
        relPath: "packages/gateway/src/ipc/agents-rpc.ts",
        contents: "recordAgentBriefEgress(ctx.db, { method, params });\n",
      },
    ];
    expect(checkEgressChokepointConfinement(files)).toHaveLength(0);
  });

  test("(c) an IMPORT of recordAgentBriefEgress elsewhere is flagged too — the name is pinned, not just the call", () => {
    // The rule matches the bare identifier deliberately: a file that imports the appender has
    // already acquired the capability, whether or not the call sits on the same line.
    const files: FileEntry[] = [
      {
        relPath: "packages/gateway/src/ipc/rogue-rpc.ts",
        contents: 'import { recordAgentBriefEgress } from "../egress/agent-brief-egress.ts";\n',
      },
    ];
    const v = checkEgressChokepointConfinement(files);
    expect(v.some((x) => x.rule === "D22-agent-brief-egress")).toBe(true);
  });
});

describe("D22(d) — agent emitter import confinement", () => {
  const flagged = (files: FileEntry[]): boolean =>
    checkAgentEmitterImportConfinement(files).some((x) => x.rule === "D22-agent-emitter-import");

  test("flags a STATIC emitter import outside agents-rpc.ts", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/ipc/http-server.ts",
          contents: 'import { emitWhyBrief } from "../agents/why.ts";\n',
        },
      ]),
    ).toBe(true);
  });

  test("flags a DYNAMIC emitter import outside agents-rpc.ts", () => {
    // Without this arm the rule is defeated by a one-character change from `import x from` to
    // `await import(`, which would be a bypass hiding in plain sight.
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/ipc/http-server.ts",
          contents: 'const m = await import("../agents/why.ts");\n',
        },
      ]),
    ).toBe(true);
  });

  test("flags a require() emitter import outside agents-rpc.ts", () => {
    // Not theoretical: Bun resolves `require("../agents/why.ts")` from a TypeScript module and
    // returns the live emitter — verified by running it. A rule matching only the two `import`
    // spellings would have left this door open while reporting green.
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/ipc/http-server.ts",
          contents: 'const m = require("../agents/why.ts");\n',
        },
      ]),
    ).toBe(true);
  });

  test("require() of an agents/_lib path is still allowed", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/federation/peer-fanout.ts",
          contents: 'const m = require("../agents/_lib/findings.ts");\n',
        },
      ]),
    ).toBe(false);
  });

  // An emitter nested one directory deep. `[\w-]` cannot cross a `/`, so the earlier flat pattern
  // matched `../agents/why.ts` and missed `../agents/briefs/summary.ts` — every emitter would
  // leave this rule's sight the day someone grouped them into folders. All three resolution forms
  // are covered, because two of them being fixed is how the next blind spot starts.
  test.each([
    ["static", 'import { emitSummaryBrief } from "../agents/briefs/summary.ts";\n'],
    ["dynamic", 'const m = await import("../agents/briefs/summary.ts");\n'],
    ["require", 'const m = require("../agents/briefs/summary.ts");\n'],
  ])("flags a %s emitter import from a SUBDIRECTORY of agents/", (_form, contents) => {
    expect(flagged([{ relPath: "packages/gateway/src/ipc/http-server.ts", contents }])).toBe(true);
  });

  test("a nested agents/_lib path is still allowed", () => {
    // The `_lib/` lookahead sits immediately after `/agents/`, so nesting must not smuggle a
    // shared helper back into scope — nor push one out of the exclusion.
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/federation/peer-fanout.ts",
          contents: 'import { x } from "../agents/_lib/findings/shape.ts";\n',
        },
      ]),
    ).toBe(false);
  });

  test("the subdirectory pattern is linear, not quadratic", () => {
    // `[\w-]*(?:\/[\w-]+)*` is a quantifier next to a quantifier. It is safe because each
    // iteration must consume a literal `/` that `[\w-]` cannot match, but "it is safe because"
    // is an argument, and an argument is not a measurement.
    const pathological = `import x from "../agents/${"a".repeat(20_000)}`;
    const started = performance.now();
    flagged([{ relPath: "packages/gateway/src/ipc/http-server.ts", contents: pathological }]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("allows every emitter import in agents-rpc.ts — the one door", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/ipc/agents-rpc.ts",
          contents:
            'import { emitWhyBrief } from "../agents/why.ts";\nimport { runWhyPeek } from "../agents/why-peek.ts";\n',
        },
      ]),
    ).toBe(false);
  });

  test("allows agents/_lib imports from anywhere — types and shared helpers, not emitters", () => {
    // federation/peer-fanout.ts imports _lib/findings.ts (a type) and
    // ipc/index-demo-symbol-rpc.ts imports _lib/demo-symbol.ts (a helper). Both are legitimate and
    // must stay legitimate, or the rule would force a pointless re-plumbing of unrelated code.
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/federation/peer-fanout.ts",
          contents: 'import type { GapNote } from "../agents/_lib/findings.ts";\n',
        },
        {
          relPath: "packages/gateway/src/ipc/index-demo-symbol-rpc.ts",
          contents: 'import { pickDemoSymbol } from "../agents/_lib/demo-symbol.ts";\n',
        },
      ]),
    ).toBe(false);
  });

  test("allows an emitter importing a sibling emitter — internal, not a second entry point", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/agents/why.ts",
          contents: 'import { emitGhostBrief } from "./ghost.ts";\n',
        },
      ]),
    ).toBe(false);
  });

  test("ignores test files, matching every sibling rule", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/ipc/some.test.ts",
          contents: 'import { emitWhyBrief } from "../agents/why.ts";\n',
        },
      ]),
    ).toBe(false);
  });

  test("a commented-out import does not trip it — comments are stripped first", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/ipc/http-server.ts",
          contents: '// import { emitWhyBrief } from "../agents/why.ts";\n',
        },
      ]),
    ).toBe(false);
  });
});

describe("the scan floor (every rule below it reports clean on an empty scan)", () => {
  // Every check in this file has the same shape: scan `files`, report what is out of place.
  // That shape reports "clean" when `files` is empty or has lost the subtree it polices, and
  // this auditor runs BEFORE the test suite precisely so it fails first. Proven, not assumed:
  // pointing `iterateSourceFiles`'s package glob at a directory that does not exist left 179
  // files scanned (the mcp-connectors glob still matched) and the pre-fix auditor exited 0
  // with zero errors, all fourteen D-rules silently no-op.
  const entry = (relPath: string): FileEntry => ({ relPath, contents: "" });

  test("passes when every policed file is in the scanned set", () => {
    expect(assertScanIsMeaningful(RULE_ANCHORS.map(entry))).toEqual([]);
  });

  test("reports every anchor when the scan is empty", () => {
    expect(assertScanIsMeaningful([])).toEqual([...RULE_ANCHORS]);
  });

  test("a large scan that lost the gateway subtree still fails", () => {
    // The case a raw `files.length > 0` floor cannot catch, and the reason the floor is the
    // anchors rather than a count: 500 real files, none of them the ones the rules confine.
    const connectorsOnly = Array.from({ length: 500 }, (_, i) =>
      entry(`packages/mcp-connectors/c${String(i)}/src/index.ts`),
    );
    expect(assertScanIsMeaningful(connectorsOnly)).toEqual([...RULE_ANCHORS]);
  });

  test("names exactly the anchor that went missing, not all of them", () => {
    const allButExecutor = RULE_ANCHORS.filter(
      (a) => a !== "packages/gateway/src/engine/executor.ts",
    ).map(entry);
    expect(assertScanIsMeaningful(allButExecutor)).toEqual([
      "packages/gateway/src/engine/executor.ts",
    ]);
  });

  test("every anchor is a file that actually exists", async () => {
    // The floor is only as honest as its list: an anchor naming a file that was deleted or
    // renamed would fail the audit forever and get "fixed" by deleting the anchor, which is
    // how a floor quietly becomes shorter than the rule set it protects.
    const missing: string[] = [];
    for (const anchor of RULE_ANCHORS) {
      // Split before joining: the `/` in an anchor is not a path separator choice, it is the
      // scan-key format — `iterateSourceFiles` normalizes every relPath to `/` so the floor
      // can compare against it by string. This is the one place that key becomes a real
      // filesystem path, so it is the place to hand the components to `join`.
      if (!(await Bun.file(join(REPO_ROOT, ...anchor.split("/"))).exists())) missing.push(anchor);
    }
    expect(missing).toEqual([]);
  });

  test("run() consults the floor, and exits, before the first rule block", async () => {
    // The five assertions above prove the function; this one proves it is WIRED. Without it,
    // deleting the call from `run()` leaves all of them green — the auditor would go back to
    // exiting 0 on a scan that enforces nothing, which is the exact defect this floor exists
    // to prevent, so the test for it must not be the kind that cannot fail.
    const src = stripComments(
      await Bun.file(
        join(REPO_ROOT, "scripts", "structure-audit", "check-nimbus-invariants.ts"),
      ).text(),
    );
    // Slice from `run()` so the export declaration of the same name, which sits above it,
    // cannot satisfy the call-site match.
    const runAt = src.indexOf("async function run(");
    expect(runAt).toBeGreaterThan(-1);
    const runBody = src.slice(runAt);

    const floorAt = runBody.indexOf("assertScanIsMeaningful(files)");
    const bailAt = runBody.indexOf("process.exit(2)");
    // Every rule block in `run()` opens with this mode test; the first one is where enforcement
    // begins, so the floor and its bail-out both have to land ahead of it.
    const firstRuleAt = runBody.indexOf("if (mode ===");

    expect(floorAt).toBeGreaterThan(-1);
    expect(bailAt).toBeGreaterThan(-1);
    expect(firstRuleAt).toBeGreaterThan(-1);
    expect(floorAt).toBeLessThan(bailAt);
    expect(bailAt).toBeLessThan(firstRuleAt);
  });
});
