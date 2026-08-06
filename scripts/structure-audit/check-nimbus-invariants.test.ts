import { describe, expect, test } from "bun:test";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import {
  checkAgentEmitterImportConfinement,
  checkConnectorWriteConfinement,
  checkEgressChokepointConfinement,
  checkForwardShareConfinement,
  checkShareConsentBrokerConfinement,
  checkSharePublishConfinement,
  checkSpawnInvariant,
  checkVaultKeyAllowList,
  collectDbRunCensus,
  DB_RUN_EXEC_ALLOW_LIST,
  type FileEntry,
  findDirectDbRunExec,
  VAULT_KEY_ALLOW_LIST,
} from "./check-nimbus-invariants.ts";

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
