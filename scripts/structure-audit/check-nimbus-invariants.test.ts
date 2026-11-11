import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { CO_OWNED_ENTITY_TYPES } from "../../packages/gateway/src/graph/relationship-graph.ts";
import {
  assertScanIsMeaningful,
  checkActDoorConfinement,
  checkActuationConfinement,
  checkAgentEmitterImportConfinement,
  checkAgentProvenanceWriters,
  checkBeforeStateRead,
  checkBoundCapabilities,
  checkBoundWrites,
  checkBrokeredFetchLiteralConfinement,
  checkCaptureGateCallers,
  checkCaptureGateImporters,
  checkCaptureTableConfinement,
  checkChatopsReplySurfaceInvariant,
  checkChatopsUnwrappedPost,
  checkConfigReaderConfinement,
  checkConfirmComparison,
  checkConnectorSpawnIsHidden,
  checkConnectorWriteConfinement,
  checkDriverImportConfinement,
  checkEgressChokepointConfinement,
  checkEmbeddingAppenderConfinement,
  checkEmbeddingConstructorConfinement,
  checkEvalConfinement,
  checkExtensionRoleConfinement,
  checkFlatUpsertGraphEntityCoOwnedTypes,
  checkFleetClientKindConfinement,
  checkForwardShareConfinement,
  checkGeneratedManifestConfinement,
  checkIacDiscard,
  checkListenerRegistryConfinement,
  checkMediaGrantStoreConfinement,
  checkMigrationConfinement,
  checkModelWriteDoor,
  checkPackLayerWriters,
  checkPushClientKindConfinement,
  checkRegistryAppenderConfinement,
  checkRemoteVlmConfinement,
  checkRunConfinedConfinement,
  checkRunGrantTableConfinement,
  checkRunGrantWriters,
  checkSavedToolAccessorConfinement,
  checkShareConsentBrokerConfinement,
  checkSharePublishConfinement,
  checkSpawnInvariant,
  checkSqliteRuntimeInit,
  checkStandingApprovals,
  checkSyncContextNoRawHandles,
  checkToolgenVaultKeyConfinement,
  checkTribalKbWriteInvariant,
  checkTrustTableConfinement,
  checkVaultKeyAllowList,
  checkWrapServerSpecInvariant,
  collectDbRunCensus,
  DB_RUN_EXEC_ALLOW_LIST,
  type FileEntry,
  findDirectDbRunExec,
  PLATFORM_VAULT_KEYS,
  RULE_ANCHORS,
  VAULT_KEY_ALLOW_LIST,
} from "./check-nimbus-invariants.ts";
import { iterateSourceFiles, REPO_ROOT, stripComments } from "./lib.ts";

describe("D10-wrap-spec — every ServerSpec literal reaches the sandbox (per SITE, not per file)", () => {
  const LM = "packages/gateway/src/connectors/lazy-mesh";
  const spec = '{ ...connectorSpawn("slack"), env: extensionProcessEnv({ TOKEN: t }) }';

  /** The real shape of the file-local alias: a one-line delegation to the wrapper. */
  const DELEGATION =
    "function wrap(s: ServerSpec, id: string, ctx: MeshSpawnContext): ServerSpec {\n" +
    "  return wrapServerSpec(s, manifestForFirstParty(id), ctx.sandboxCwd);\n" +
    "}\n";

  test("accepts a spec wrapped by the file-local `wrap` helper", () => {
    expect(
      checkWrapServerSpecInvariant([
        {
          relPath: `${LM}/connector-spawns.ts`,
          contents: `${DELEGATION}const a = { slack: wrap(${spec}, "slack", ctx) };`,
        },
      ]),
    ).toHaveLength(0);
  });

  test("REJECTS a `wrap` that does not delegate to wrapServerSpec", () => {
    // The alias is earned, not granted by name. Accepting the identifier `wrap` anywhere under
    // lazy-mesh would mean the rule checks how a call is SPELLED, not that the spec reaches the
    // sandbox — so `function wrap(s: ServerSpec) { return s; }` in a new file would make every
    // site in it compliant, past both this rule and the runtime test that delegates to it.
    expect(
      checkWrapServerSpecInvariant([
        {
          relPath: `${LM}/connector-spawns.ts`,
          contents: `function wrap(s: ServerSpec): ServerSpec {\n  return s;\n}\nconst a = { slack: wrap(${spec}, "slack", ctx) };`,
        },
      ]),
    ).toHaveLength(1);
  });

  test("REJECTS the alias in a file that never defines it", () => {
    // An imported or globally-available `wrap` is not the file-local delegation this exempts.
    expect(
      checkWrapServerSpecInvariant([
        { relPath: `${LM}/connector-spawns.ts`, contents: `const a = { slack: wrap(${spec}) };` },
      ]),
    ).toHaveLength(1);
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
        contents: `${DELEGATION}const a = { github: wrap(${spec}, "github", ctx) };\nconst b = { slack: ${spec} };`,
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
  test("VAULT_KEY_ALLOW_LIST has exactly 13 entries", () => {
    // 9 → 10: slice 2b adds ONLY `llm/vendor-vault-keys.ts`, which owns the vendor keyspace. The
    // `<vendor>.api_key` when resolving the credential per call. 10 → 11: the toolgen credential
    // store (`toolgen-credentials.ts`) composes the DYNAMIC `toolgen.<toolId>.<hostSlug>` keyspace
    // (D29(c)'s stated bound — a text scan cannot see it, capability confinement is the real
    // defense, and this entry documents the keyspace). 11 → 12: `toolgen-keypair.ts` (I40) holds
    // the STATIC `toolgen.signing.privkey` / `toolgen.signing.pubkey` literals — unlike
    // `toolgen-credentials.ts`'s dynamic per-host keys directly above, the audit's literal scan
    // genuinely sees these, so this entry is real enforcement rather than keyspace documentation.
    // The count is frozen ON PURPOSE — a file gaining permission to construct a vault key is a
    // decision, so it must be made deliberately in a commit that also explains it, never absorbed
    // silently. 12 → 13: `extensions/extension-credentials.ts` composes an extension's own DYNAMIC
    // `ext.<serviceId>.<name>` keyspace (V72 run-grant credentials) — documentation of a keyspace
    // the literal scan cannot see, the same footing as `toolgen-credentials.ts`.
    expect(VAULT_KEY_ALLOW_LIST).toHaveLength(13);
  });
});

describe("platform keyspace — slice 2b cloud vendors", () => {
  test("the four vendor api_key entries are registered", () => {
    // Registration is what keeps the keyspace documented in ONE place. A key an adapter reads
    // but that is absent here is a key nobody can audit.
    //
    // `openai.api_key` is DELIBERATELY REUSED from the embedding runtime rather than minted as a
    // second OpenAI key: same credential, same vendor, and a second key for one vendor invites
    // drift. It is also the sharpest available test of the per-vendor opt-in — an existing
    // embeddings user already has this key present, and `[llm.remote.openai] enabled = false`
    // must still produce zero chat calls.
    // Spread to a widened `string[]`: `PLATFORM_VAULT_KEYS` is `as const`, so `toContain` would
    // otherwise demand one of its own literal members and reject a plain `string`.
    const keys: string[] = [...PLATFORM_VAULT_KEYS];
    for (const k of ["anthropic.api_key", "openai.api_key", "gemini.api_key", "xai.api_key"]) {
      expect(keys).toContain(k);
    }
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

describe("D19 — tribal KB write-id confinement", () => {
  // D20's sibling rule shipped with a full describe block and this one shipped with none, so
  // until now nothing proved D19 could fail at all. An allow-list guard that never fires is
  // indistinguishable from one that is working.
  test("flags a KB write tool id referenced outside the write-gate", () => {
    const v = checkTribalKbWriteInvariant([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `dispatch("notion_kb_append")`,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("D19-tribal-kb-write");
    expect(v[0]?.line).toBe(1);
  });

  test("flags the confluence id too", () => {
    const v = checkTribalKbWriteInvariant([
      {
        relPath: "packages/gateway/src/tribal/somewhere-else.ts",
        contents: `const id = "confluence_kb_append";`,
      },
    ]);
    expect(v).toHaveLength(1);
  });

  test("allows the write-gate itself", () => {
    const v = checkTribalKbWriteInvariant([
      {
        relPath: "packages/gateway/src/tribal/tribal-write-gate.ts",
        contents: `const ids = ["notion_kb_append", "confluence_kb_append"];`,
      },
    ]);
    expect(v).toEqual([]);
  });

  test("ignores a mention inside a comment", () => {
    const v = checkTribalKbWriteInvariant([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `// notion_kb_append is gated elsewhere
const x = 1;`,
      },
    ]);
    expect(v).toEqual([]);
  });

  test("skips test files", () => {
    const v = checkTribalKbWriteInvariant([
      {
        relPath: "packages/gateway/src/ipc/some-handler.test.ts",
        contents: `dispatch("notion_kb_append")`,
      },
    ]);
    expect(v).toEqual([]);
  });

  test("reports the offending line number, not just the file", () => {
    const v = checkTribalKbWriteInvariant([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `const a = 1;
const b = 2;
dispatch("notion_kb_append")`,
      },
    ]);
    expect(v[0]?.line).toBe(3);
  });
});

describe("D20 — connector write-id confinement (every row in connectors/connector-writes)", () => {
  test("a migrated write id outside the allowed sites is a D20 violation", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: `const id = "jira_issue_create";`,
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D20-connector-write"]);
  });

  test("a namespaced <server>_<tool> write id outside the allowed sites is a D20 violation", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: `const id = "jira_jira_issue_create";`,
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D20-connector-write"]);
  });

  test("a longer id that merely ends in a write id's letters is not flagged", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/agents/x.ts",
        contents: `const id = "xjira_issue_create";`,
      },
    ]);
    expect(v).toEqual([]);
  });

  test("proposable-actions.ts may name write ids", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/proposable-actions.ts",
        contents: `const id = "jira_issue_create";`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("connector-code-execution-tool-ids.ts may name write ids", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/connector-code-execution-tool-ids.ts",
        contents: `const id = "argocd_app_sync";`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("a file under connector-writes/ may name write ids", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/connector-writes/anything.ts",
        contents: `const id = "jira_issue_create";`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("the deleted warehouse-write-tools.ts path is now flagged", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/warehouse-write-tools.ts",
        contents: `const id = "tableau_datasource_refresh";`,
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D20-connector-write"]);
  });

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

  test("does NOT flag the gitops-ml row file", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/connector-writes/gitops-ml.ts",
        contents: `row("argocd_app_sync", "argocd.app.sync", "write", 4);`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("allows the SSoT, connector servers, and transport/dispatch sites", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/connector-writes/warehouse-bi.ts",
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

  test("requires answerFederatedInvoke to consult isCodeExecutionForbiddenToolId too", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `if (ctx.isWriteForbiddenToolId?.(q.toolId) === true) audit(ctx, q, "write_forbidden");`,
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D20-invoke-gate-code-execution"]);
  });

  test("a mention in a comment does not count as consulting it", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `if (ctx.isWriteForbiddenToolId?.(q.toolId) === true) return;\n// isCodeExecutionForbiddenToolId(q.toolId): TODO`,
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D20-invoke-gate-code-execution"]);
  });

  test("declaring the ctx fields is not consulting them — the gate must CALL both", () => {
    // The real InvokeGateCtx declares both fields, so a name-only check passed with the calls gone.
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `export interface InvokeGateCtx {
  readonly isWriteForbiddenToolId?: (toolId: string) => boolean;
  readonly isCodeExecutionForbiddenToolId: (toolId: string) => boolean;
}
export async function answerFederatedInvoke(ctx: InvokeGateCtx) { return ctx; }`,
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual([
      "D20-invoke-gate-predicate",
      "D20-invoke-gate-code-execution",
    ]);
  });

  test("does NOT flag invoke-gate.ts when it consults both predicates", () => {
    const v = checkConnectorWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `if (ctx.isWriteForbiddenToolId?.(q.toolId) === true) audit(ctx, q, "write_forbidden");
if (ctx.isCodeExecutionForbiddenToolId(q.toolId)) audit(ctx, q, "code_execution_forbidden");`,
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

describe("D22(h) \u2014 the registry appender and fetch are confined", () => {
  const file = (relPath: string, contents: string) => [{ relPath, contents }];

  test("the allowed files pass", () => {
    expect(
      checkRegistryAppenderConfinement([
        ...file(
          "packages/gateway/src/egress/registry-egress.ts",
          "export function recordRegistryEgress() {}\n",
        ),
        ...file(
          "packages/gateway/src/extensions/registry/registry-fetch.ts",
          "recordRegistryEgress(db, a);\nawait fetch(u);\n",
        ),
      ]),
    ).toEqual([]);
  });

  test("a recordRegistryEgress call in another gateway file fails", () => {
    const v = checkRegistryAppenderConfinement(
      file("packages/gateway/src/agents/rogue.ts", "recordRegistryEgress(db, a);\n"),
    );
    expect(v.map((x) => x.rule)).toEqual(["registry-appender-confined"]);
  });

  test("a fetch( in extensions/install-from-local.ts fails", () => {
    const v = checkRegistryAppenderConfinement(
      file(
        "packages/gateway/src/extensions/install-from-local.ts",
        "const r = await fetch(url);\n",
      ),
    );
    expect(v.map((x) => x.rule)).toEqual(["registry-fetch-confined"]);
  });

  test("a commented-out call, a test file and fetchFn( do not trip it", () => {
    expect(
      checkRegistryAppenderConfinement([
        ...file(
          "packages/gateway/src/extensions/a.ts",
          "// fetch(url)\nawait deps.fetchFn(url);\n",
        ),
        ...file(
          "packages/gateway/src/extensions/a.test.ts",
          "fetch(url);\nrecordRegistryEgress();\n",
        ),
      ]),
    ).toEqual([]);
  });

  test("the former legacy fetcher files have no exemption left", () => {
    // `publisher-keys.ts`, `registry-client.ts` and `sync.ts` were temporarily exempt while the
    // unwired publisher-key fetcher existed; it is deleted, so a fetch there is a violation again.
    for (const f of ["publisher-keys", "registry-client", "sync"]) {
      expect(
        checkRegistryAppenderConfinement(
          file(`packages/gateway/src/extensions/${f}.ts`, "await fetch(url);\n"),
        ).map((x) => x.rule),
      ).toEqual(["registry-fetch-confined"]);
    }
  });
});

describe("D22(f) — the embedding appender is confined", () => {
  const file = (relPath: string, contents: string) => [{ relPath, contents }];

  test("flags wrapLedgeredEmbedder called outside the allowed sites", () => {
    const v = checkEmbeddingAppenderConfinement(
      file("packages/gateway/src/agents/rogue.ts", "wrapLedgeredEmbedder(db, e);\n"),
    );
    expect(v.map((x) => x.rule)).toEqual(["embedding-appender-confined"]);
  });

  test("the three construction sites and the definition are allowed", () => {
    const allowed = [
      "packages/gateway/src/embedding/create-routing-runtime.ts",
      "packages/gateway/src/embedding/create-embedding-runtime.ts",
      "packages/gateway/src/ipc/index-reembed-rpc.ts",
      "packages/gateway/src/egress/embedding-egress.ts",
    ];
    for (const relPath of allowed) {
      expect(
        checkEmbeddingAppenderConfinement(file(relPath, "wrapLedgeredEmbedder(db, e);\n")),
      ).toEqual([]);
    }
  });

  // No "split across lines" test here, unlike D25's checkConnectorSpawnIsHidden. D25's regex is
  // /\bBun\s*\.\s*spawn\b/ -- the `\s*` legitimately spans a newline inserted between `Bun` and
  // `.spawn`, so a naive per-line loop misses `Bun\n  .spawn(...)` and only a whole-source scan
  // catches it; that is a real property to test. D22_EMBED_WRAP_RE is the bare identifier
  // /\bwrapLedgeredEmbedder\b/: a JS/TS identifier token cannot itself contain a newline, so
  // `wrapLedgeredEmbedder` always sits fully on one line even when the CALL that follows it is
  // split (`wrapLedgeredEmbedder\n  (db, e)`) -- a naive per-line loop matches that line just as
  // well as a whole-source scan does. There is no input on which the two implementations
  // disagree, so no test can discriminate them; a test asserting they do would look like coverage
  // of a gap it does not actually cover. The whole-source scan is kept anyway, for consistency
  // with D25 and D22(e) and in case this regex ever grows a `\s*` of its own.
});

describe("D22(f) second allow-list — the embedding CONSTRUCTOR is confined", () => {
  const file = (relPath: string, contents: string) => [{ relPath, contents }];

  // The gap this closes: a bare `createOpenAIEmbedder(...)` call, with no mention of
  // `wrapLedgeredEmbedder` anywhere in the file, spells nothing `checkEmbeddingAppenderConfinement`
  // matches -- that rule only sees a file that ALREADY calls the decorator. A fourth construction
  // site written without it is exactly the I29 regression both rules exist to prevent.
  test("flags createOpenAIEmbedder constructed outside the allowed sites, even with no wrapLedgeredEmbedder mention", () => {
    const v = checkEmbeddingConstructorConfinement(
      file("packages/gateway/src/agents/rogue.ts", "const e = createOpenAIEmbedder({ apiKey });\n"),
    );
    expect(v.map((x) => x.rule)).toEqual(["embedding-constructor-confined"]);
  });

  // The definition site is exempt outright -- there is no wrapping to check on a declaration.
  test("the definition site is allowed unconditionally", () => {
    expect(
      checkEmbeddingConstructorConfinement(
        file(
          "packages/gateway/src/embedding/openai-embedder.ts",
          "export async function createOpenAIEmbedder(options) {}\n",
        ),
      ),
    ).toEqual([]);
  });

  // The three real construction sites pass ONLY when the call is actually nested inside a
  // wrapLedgeredEmbedder(...) argument list -- proving association, not mere file membership.
  test("the three construction sites pass when the call is wrapped", () => {
    const sites = [
      "packages/gateway/src/embedding/create-routing-runtime.ts",
      "packages/gateway/src/embedding/create-embedding-runtime.ts",
      "packages/gateway/src/ipc/index-reembed-rpc.ts",
    ];
    for (const relPath of sites) {
      expect(
        checkEmbeddingConstructorConfinement(
          file(relPath, "wrapLedgeredEmbedder(db, await createOpenAIEmbedder({ apiKey }));\n"),
        ),
      ).toEqual([]);
    }
  });

  // The regression this rule now closes: being on the allow-list used to skip the whole file, so
  // a SECOND, bare construction beside a real wrapped one was invisible. Same file, same allowed
  // path, one wrapped call and one bare call -- only the bare one should be flagged.
  test("an unwrapped createOpenAIEmbedder call inside an approved file is still flagged", () => {
    for (const relPath of [
      "packages/gateway/src/embedding/create-routing-runtime.ts",
      "packages/gateway/src/embedding/create-embedding-runtime.ts",
      "packages/gateway/src/ipc/index-reembed-rpc.ts",
    ]) {
      const contents = [
        "wrapLedgeredEmbedder(db, await createOpenAIEmbedder({ apiKey }));",
        "const rogue = await createOpenAIEmbedder({ apiKey: other });",
      ].join("\n");
      const v = checkEmbeddingConstructorConfinement(file(relPath, contents));
      expect(v.map((x) => x.rule)).toEqual(["embedding-constructor-confined"]);
      expect(v[0]?.snippet).toContain("rogue");
    }
  });

  // A `${...}` substitution is executable code, and the embed request it issues is a real,
  // unledgered outbound call no matter what the template does with the stringified result -- so a
  // construction hidden in one is exactly the egress this rule exists to catch.
  // `stripStringLiterals` used to blank substitution bodies along with the surrounding template
  // text, which made this a one-line way to walk past the guard. Reported by CodeRabbit on #1384.
  test("an unwrapped createOpenAIEmbedder inside a template substitution is flagged", () => {
    const v = checkEmbeddingConstructorConfinement(
      file(
        "packages/gateway/src/agents/rogue.ts",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
        "const log = `vec=${await createOpenAIEmbedder({ apiKey }).embed(texts)}`;",
      ),
    );
    expect(v.map((x) => x.rule)).toEqual(["embedding-constructor-confined"]);
  });

  test("an unwrapped construction inside a substitution in an APPROVED file is still flagged", () => {
    const contents = [
      "wrapLedgeredEmbedder(db, await createOpenAIEmbedder({ apiKey }));",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
      "const rogue = `vec=${await createOpenAIEmbedder({ apiKey: other }).embed(t)}`;",
    ].join("\n");
    const v = checkEmbeddingConstructorConfinement(
      file("packages/gateway/src/embedding/create-routing-runtime.ts", contents),
    );
    expect(v.map((x) => x.rule)).toEqual(["embedding-constructor-confined"]);
    expect(v[0]?.snippet).toContain("rogue");
  });

  // The counterpart bound: a construction WRAPPED inside a substitution is still association, not
  // co-occurrence -- the paren match has to survive the substitution being preserved.
  test("a wrapped construction inside a substitution passes", () => {
    expect(
      checkEmbeddingConstructorConfinement(
        file(
          "packages/gateway/src/embedding/create-routing-runtime.ts",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
          "const e = `${wrapLedgeredEmbedder(db, await createOpenAIEmbedder({ apiKey }))}`;",
        ),
      ),
    ).toEqual([]);
  });

  // Template PROSE must still be inert: the rule must not start matching a call-shaped sentence
  // that merely sits in a message string.
  test("the constructor named in template prose is NOT flagged", () => {
    expect(
      checkEmbeddingConstructorConfinement(
        file(
          "packages/gateway/src/agents/rogue.ts",
          "throw new Error(`call createOpenAIEmbedder( only via the wrapper`);",
        ),
      ),
    ).toEqual([]);
  });
});

describe("graph-entity-flat-coowned — flat upsertGraphEntity pinned away from co-owned types", () => {
  const flagged = (files: FileEntry[]): boolean =>
    checkFlatUpsertGraphEntityCoOwnedTypes(files).some(
      (x) => x.rule === "graph-entity-flat-coowned",
    );

  // The real shape, from graph-populator.ts before Task 3 converted it: multi-line, `type:` on the
  // line after the call opens. A same-line regex would miss this — the only shape in the tree —
  // and pass vacuously, so this is the primary case, not an edge case.
  // Driven off CO_OWNED_ENTITY_TYPES rather than a literal list: the rule builds its regex from
  // that constant, so a type added there must gain a case here automatically or this suite would
  // keep passing while covering one fewer type than the rule polices.
  test.each([...CO_OWNED_ENTITY_TYPES])(
    "flags a MULTI-LINE flat call with co-owned type %s",
    (type) => {
      const v = checkFlatUpsertGraphEntityCoOwnedTypes([
        {
          relPath: "packages/gateway/src/graph/graph-populator.ts",
          contents: `  const entityId = upsertGraphEntity(db, {\n    type: "${type}",\n    externalId: row.id,\n    label: row.title,\n  });\n`,
        },
      ]);
      expect(v.some((x) => x.rule === "graph-entity-flat-coowned")).toBe(true);
      expect(v[0]?.file).toBe("packages/gateway/src/graph/graph-populator.ts");
    },
  );

  test("a same-line flat call with a co-owned type is also flagged", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/graph/graph-populator.ts",
          contents: 'upsertGraphEntity(db, { type: "source_file", externalId: e, label: l });\n',
        },
      ]),
    ).toBe(true);
  });

  // REGRESSION. `upsertGraphEntity<string>(...)` in a PRODUCTION file must be flagged. The
  // explicit type argument instantiates `T` as `string`, and `NonCoOwnedType<string>` collapses
  // back to `string` because a non-union never distributes — so the compiler guard accepts this
  // shape. Before the matcher grew its optional `<...>` segment the regex missed it too, which
  // meant one added type argument defeated BOTH layers. Verified against a real probe file: it
  // passed `audit:invariants` and `typecheck` before the fix, and fails the audit after it.
  test("a flat call with an EXPLICIT type argument is flagged in a production file", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/graph/graph-populator.ts",
          contents:
            '  const id = upsertGraphEntity<string>(db, {\n    type: "person",\n    externalId: e,\n  });\n',
        },
      ]),
    ).toBe(true);
  });

  // The same shape in a `.test.ts` file stays allowed: the exemption is by FILE PATH, and the
  // fixture-only callers Tasks 1 and 3 established all live in test files. This pins that the
  // widened matcher did not turn those legitimate fixtures into violations.
  test("a flat call with an explicit type argument is still allowed in a test file", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/agents/negotiate.test.ts",
          contents:
            '  const id = upsertGraphEntity<string>(db, {\n    type: "person",\n    externalId: e,\n  });\n',
        },
      ]),
    ).toBe(false);
  });

  test("a flat call with a NON-co-owned type (pr) is allowed", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/graph/graph-populator.ts",
          contents:
            '  const prEntityId = upsertGraphEntity(db, {\n    type: "pr",\n    externalId: e,\n  });\n',
        },
      ]),
    ).toBe(false);
  });

  test("upsertGraphEntityNamespaced with a co-owned type is allowed — different identifier", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/graph/graph-populator.ts",
          contents:
            '  const personEntityId = upsertGraphEntityNamespaced(db, {\n    type: "person",\n    writer: "symbols",\n  });\n',
        },
      ]),
    ).toBe(false);
  });

  test("relationship-graph.ts itself, where upsertGraphEntity is defined, is allowed", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/graph/relationship-graph.ts",
          contents:
            'export function upsertGraphEntity(db, row) {\n  // type: "source_file" appears only in doc comments here\n}\n',
        },
      ]),
    ).toBe(false);
  });

  test("does not span into a SUBSEQUENT call — a legit call followed by a co-owned one attributes to the right site", () => {
    // A non-co-owned call, then (well past the 120-char window) a co-owned one. If the bound were
    // unbounded or too generous, the first call's window could reach the second call's `type:` and
    // either double-count or mis-attribute the line.
    const filler = "    // filler to push the next call past the match window\n".repeat(5);
    const contents =
      '  const prId = upsertGraphEntity(db, {\n    type: "pr",\n    externalId: e,\n    label: l,\n  });\n' +
      filler +
      '  const personId = upsertGraphEntity(db, {\n    type: "person",\n    externalId: e2,\n  });\n';
    const v = checkFlatUpsertGraphEntityCoOwnedTypes([
      { relPath: "packages/gateway/src/graph/graph-populator.ts", contents },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("graph-entity-flat-coowned");
    // Attributed to the SECOND call's own opening line (`m.index` is the call-site match start,
    // not the `type:` line), not the first call.
    const line = v[0]?.line ?? -1;
    expect(contents.split("\n")[line - 1]).toContain("personId");
  });

  test("ignores test files — fixture-only co-owned writes keep the flat call by design", () => {
    // Established by Tasks 1/3: packages/gateway/src/agents/negotiate.test.ts calls
    // upsertGraphEntity<string>(db, { type: "person", ... }) with no metadata, purely to
    // materialise a node so a relation has an endpoint. Converting it would write a namespace
    // ("ownership"/"symbols") that describes neither the fixture nor anything it does.
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/agents/negotiate.test.ts",
          contents:
            '  const ghost = upsertGraphEntity<string>(db, {\n    type: "person",\n    externalId: "git:jane@example.com",\n  });\n',
        },
      ]),
    ).toBe(false);
  });

  test("a commented-out flat co-owned call does not trip it — comments are stripped first", () => {
    expect(
      flagged([
        {
          relPath: "packages/gateway/src/graph/graph-populator.ts",
          contents: '  // upsertGraphEntity(db, { type: "source_file", externalId: e });\n',
        },
      ]),
    ).toBe(false);
  });

  // Asserts the ACTUAL bound — `[\s\S]{0,120}?` — not how fast the scan ran. A wall-clock
  // assertion cannot tell a bounded window from an unbounded-but-fast one, and is flaky on a
  // loaded CI runner. Both halves are needed: the far case alone would pass against a rule that
  // matched nothing at all.
  test("the match window is bounded at 120 characters, in both directions", () => {
    // The window opens right after the `(`, so `db, {` already spends 5 of the 120.
    const PREFIX = "db, {".length;
    const site = (gap: number): string =>
      `upsertGraphEntity(db, {${" ".repeat(gap)}type: "person", externalId: e });\n`;
    const scan = (gap: number): boolean =>
      flagged([{ relPath: "packages/gateway/src/graph/graph-populator.ts", contents: site(gap) }]);
    // Inside the window: flagged. Real call sites sit 10–12 characters in.
    expect(scan(10)).toBe(true);
    expect(scan(120 - PREFIX)).toBe(true);
    // One character past it: NOT flagged. A known, deliberate bound, asserted so it is inherited
    // rather than rediscovered — and the reason 120 is measured against real call sites rather
    // than guessed. `20_000` is the old pathological input, now asserted on its RESULT.
    expect(scan(120 - PREFIX + 1)).toBe(false);
    expect(scan(20_000)).toBe(false);
  });
});

describe("the scan floor (every rule below it reports clean on an empty scan)", () => {
  // Every check in this file has the same shape: scan `files`, report what is out of place.
  // That shape reports "clean" when `files` is empty or has lost the subtree it polices, and
  // this auditor runs BEFORE the test suite precisely so it fails first. Proven, not assumed:
  // pointing `iterateSourceFiles`'s package glob at a directory that does not exist left 179
  // files scanned (its second glob, over the since-deleted `packages/mcp-connectors`, still
  // matched) and the pre-fix auditor exited 0 with zero errors, all fourteen D-rules silently
  // no-op.
  const entry = (relPath: string): FileEntry => ({ relPath, contents: "" });

  test("passes when every policed file is in the scanned set", () => {
    expect(assertScanIsMeaningful(RULE_ANCHORS.map(entry))).toEqual([]);
  });

  test("reports every anchor when the scan is empty", () => {
    expect(assertScanIsMeaningful([])).toEqual([...RULE_ANCHORS]);
  });

  test("a large scan that lost the gateway subtree still fails", () => {
    // The case a raw `files.length > 0` floor cannot catch, and the reason the floor is the
    // anchors rather than a count: 500 real files, none of them the ones the rules confine. Every
    // anchor is a gateway file, so a scan that kept the other packages' sources is this shape.
    const cliOnly = Array.from({ length: 500 }, (_, i) =>
      entry(`packages/cli/src/commands/c${String(i)}.ts`),
    );
    expect(assertScanIsMeaningful(cliOnly)).toEqual([...RULE_ANCHORS]);
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

describe("D23 — runConfined confinement (I33)", () => {
  const GATE = "packages/gateway/src/exec/exec-gate.ts";
  const RUN = "packages/gateway/src/exec/exec-run.ts";

  test("flags a runConfined call outside the exec gate", () => {
    const v = checkRunConfinedConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-rpc.ts",
        contents: `const r = await runConfined(runner, cmd, args, opts);`,
      },
    ]);
    expect(v.some((x) => x.rule === "D23-runconfined-callsite")).toBe(true);
  });

  test("allows the gate and the definition file", () => {
    const v = checkRunConfinedConfinement([
      { relPath: GATE, contents: `const result = await runConfined(deps.runner, cmd, args, {});` },
      { relPath: RUN, contents: `export function runConfined(runner, cmd, args, opts) {}` },
    ]);
    expect(v).toHaveLength(0);
  });

  test("ignores .test.ts files", () => {
    const v = checkRunConfinedConfinement([
      {
        relPath: "packages/gateway/src/exec/exec-run.test.ts",
        contents: `const p = runConfined(fakeRunner(child), "bun", [], BASE);`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("does not flag a mere mention in a comment", () => {
    const v = checkRunConfinedConfinement([
      {
        relPath: "packages/gateway/src/engine/executor.ts",
        contents: `// see runConfined(...) for the confined-spawn path\nconst x = 1;`,
      },
    ]);
    expect(v).toHaveLength(0);
  });
});

describe("D24 — a syncable cannot reach a raw vault or db handle", () => {
  const syncable = (contents: string) => [
    { relPath: "packages/gateway/src/connectors/evil-sync.ts", contents },
  ];

  test("flags ctx.vault in a syncable", () => {
    const v = checkSyncContextNoRawHandles(syncable('const t = ctx.vault.get("slack.token");\n'));
    expect(v.map((x) => x.rule)).toEqual(["sync-context-no-raw-handles"]);
  });

  test("flags ctx.db in a syncable", () => {
    expect(checkSyncContextNoRawHandles(syncable("ctx.db.query('SELECT 1');\n"))).toHaveLength(1);
  });

  test("a capability call is clean", () => {
    expect(checkSyncContextNoRawHandles(syncable('await ctx.getSecret("api_token");\n'))).toEqual(
      [],
    );
  });

  test("lazy-mesh is out of scope — it holds a real vault by design", () => {
    const v = checkSyncContextNoRawHandles([
      {
        relPath: "packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts",
        contents: 'const t = ctx.vault.get("figma.team_id");\n',
      },
    ]);
    expect(v).toEqual([]);
  });

  test("the capability factory itself is exempt — it is what holds the handles", () => {
    const v = checkSyncContextNoRawHandles([
      {
        relPath: "packages/gateway/src/sync/sync-capabilities.ts",
        contents: "readConnectorSecret(deps.vault, serviceId, keyName);\nctx.db;\n",
      },
    ]);
    expect(v).toEqual([]);
  });

  test("no syncable in the real repository reaches a handle", async () => {
    // The fixtures above prove the rule can fire; this proves the repository satisfies it.
    const files: { relPath: string; contents: string }[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkSyncContextNoRawHandles(files)).toEqual([]);
  });
});

describe("D25 — a connector cannot spawn without windowsHide", () => {
  const syncable = (contents: string) => [
    { relPath: "packages/gateway/src/connectors/evil-sync.ts", contents },
  ];

  test("flags a plain Bun.spawn in a connector", () => {
    const v = checkConnectorSpawnIsHidden(syncable('Bun.spawn(["aws", "s3", "ls"]);\n'));
    expect(v.map((x) => x.rule)).toEqual(["connector-spawn-must-be-hidden"]);
    expect(v[0]?.line).toBe(1);
  });

  test("flags a Bun.spawn SPLIT ACROSS LINES", () => {
    // The rule scanned line by line at first. `Bun` on one line and `.spawn` on the next is
    // valid TypeScript that matches NEITHER line, so an unhidden spawn slipped through while
    // the audit stayed green — the failure mode a guard must not have.
    const v = checkConnectorSpawnIsHidden(syncable('const p = Bun\n  .spawn(["aws"]);\n'));
    expect(v).toHaveLength(1);
    // Reported against the line the match STARTS on, derived from the offset.
    expect(v[0]?.line).toBe(1);
  });

  test("reports the correct line for a spawn further down the file", () => {
    const src = `${"const a = 1;\n".repeat(9)}Bun.spawn(["aws"]);\n`;
    expect(checkConnectorSpawnIsHidden(syncable(src))[0]?.line).toBe(10);
  });

  test("a commented-out Bun.spawn is not flagged", () => {
    // `stripComments` runs first, which is also what keeps this file's own explanatory
    // comments about `Bun.spawn` from tripping the rule.
    expect(
      checkConnectorSpawnIsHidden(
        syncable('// Bun.spawn is forbidden here\nspawnCapture(["aws"]);\n'),
      ),
    ).toEqual([]);
  });

  test("spawnCapture is clean", () => {
    expect(checkConnectorSpawnIsHidden(syncable('await spawnCapture(["aws"]);\n'))).toEqual([]);
  });

  test("the two injected-seam files stay exempt, and lazy-mesh is out of scope", () => {
    const files = [
      {
        relPath: "packages/gateway/src/connectors/blame-index-sync.ts",
        contents: "Bun.spawn(x);\n",
      },
      {
        relPath: "packages/gateway/src/connectors/filesystem-v2-sync.ts",
        contents: "Bun.spawn(x);\n",
      },
      {
        relPath: "packages/gateway/src/connectors/lazy-mesh/runner.ts",
        contents: "Bun.spawn(x);\n",
      },
      { relPath: "packages/gateway/src/connectors/evil-sync.test.ts", contents: "Bun.spawn(x);\n" },
    ];
    expect(checkConnectorSpawnIsHidden(files)).toEqual([]);
  });
});

describe("D17-chatops-unwrapped-post — buildConnectorPost may only appear as an argument to buildLedgeredChatPosts", () => {
  test("D17 rejects a buildConnectorPost call that is not an argument to buildLedgeredChatPosts", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents: "const post = buildConnectorPost(runTool, fn);\n",
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D17-chatops-unwrapped-post"]);
  });

  test("D17 accepts the inline form", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents:
          "const posts = buildLedgeredChatPosts(db, buildConnectorPost(runTool, fn), salt);\n",
      },
    ]);
    expect(v).toEqual([]);
  });

  // THE TEST THAT MATTERS. A file-level "does this file contain a wrapped call?" early-return
  // skips the whole file when BOTH forms are present -- and the one file that legitimately
  // contains a wrapped call is `chatops-boot.ts`, i.e. exactly the file where an added unwrapped
  // call would be invisible. Counting the two tokens does not fix it either: a wrapped call whose
  // argument is something else keeps the counts equal while the bypass survives.
  // A `(` inside a REGEX body survives `stripStringLiterals` (its documented known limitation),
  // so the wrapper's paren depth never closes. The span must then be DROPPED, not stretched to
  // end-of-statement -- stretching it would swallow the later raw call and pass it as wrapped,
  // which is a silent false negative in the one guard meant to catch an unledgered post.
  test("D17 does not let an unclosed span (regex paren) launder a later raw call", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents:
          "const posts = buildLedgeredChatPosts(db, /[(]/, buildConnectorPost(a, b), salt), " +
          "sneaky = buildConnectorPost(c, d);\n",
      },
    ]);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.rule).toBe("D17-chatops-unwrapped-post");
  });

  test("D17 catches an unwrapped call in a file that ALSO has a wrapped one", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents:
          "const posts = buildLedgeredChatPosts(db, buildConnectorPost(runTool, fn), salt);\n" +
          "const sneaky = buildConnectorPost(runTool, fn);\n",
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.line).toBe(2);
  });

  test("D17 catches a wrapper call whose argument is NOT buildConnectorPost", () => {
    // Proves per-file token COUNTING is defeated here: both tokens appear once (1 wrapper, 1
    // post), so a count-based check would see balanced totals and pass this. It does not exercise
    // the within-statement positional-pairing logic above -- both calls here are separate
    // `;`-terminated statements, so plain per-statement scoping already catches the second one on
    // its own. A single statement that interleaves a wrapper and an unwrapped call in a passing
    // order is the brief's explicitly accepted residual bound (a lexical guard, not a parser) and
    // is deliberately not tested here.
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents:
          "const posts = buildLedgeredChatPosts(db, somethingElse, salt);\n" +
          "const post = buildConnectorPost(runTool, fn);\n",
      },
    ]);
    expect(v.length).toBe(1);
  });

  // Regression: ordinal/positional pairing (the Nth post pairs with the Nth wrapper) let a
  // comma-separated declaration with TWO wrapped calls plus ONE raw call through — the raw call's
  // ordinal happened to line up with the SECOND wrapper, which had already closed its own
  // parenthesis span earlier in the statement, so the raw call "paired" with a wrapper it sat
  // entirely outside of. Direct containment must reject the raw call regardless of where it falls
  // relative to an unrelated, already-closed wrapper call earlier in the same statement.
  test("D17 rejects a raw call that ordinally lines up with an unrelated, already-closed wrapper (two wrapped + one raw in one statement)", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents:
          "const a = buildLedgeredChatPosts(db, buildConnectorPost(runTool, fn), salt1)," +
          " c = buildLedgeredChatPosts(db, somethingElse, salt2)," +
          " sneaky = buildConnectorPost(runTool, fn);\n",
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D17-chatops-unwrapped-post"]);
  });

  // Regression: a `;` INSIDE a string-literal argument must not fragment one statement into two.
  // Before stripStringLiterals was composed in, `stripComments` alone left the `;def"` fragment
  // live, so `.split(";")` cut this single correctly-wrapped call into two segments -- the wrapper
  // token landed in the first segment and the buildConnectorPost( call landed in the second with
  // no wrapper visible there, a false positive on code that is correct.
  test("D17 does not fragment a statement on a semicolon inside a string literal", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: "packages/gateway/src/chatops/chatops-boot.ts",
        contents:
          'const posts = buildLedgeredChatPosts(db, "abc;def", buildConnectorPost(runTool, fn), salt);\n',
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe("D17 (Phase 9.7 D0c) — the confirmation modal opener", () => {
  const boot = "packages/gateway/src/chatops/chatops-boot.ts";

  test("D17 rejects the slack_views_open literal outside the transport", () => {
    const v = checkChatopsReplySurfaceInvariant([
      { relPath: boot, contents: 'await runTool("slack", "slack_views_open", { view });\n' },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D17-chatops-reply-surface"]);
  });

  test("D17 allows the slack_views_open literal inside the transport", () => {
    const v = checkChatopsReplySurfaceInvariant([
      {
        relPath: "packages/gateway/src/chatops/transport/connector-post.ts",
        contents: 'const SLACK_VIEWS_OPEN = "slack_views_open";\n',
      },
    ]);
    expect(v).toEqual([]);
  });

  test("D17 rejects a buildConnectorViewsOpen call bound to a name", () => {
    const v = checkChatopsUnwrappedPost([
      { relPath: boot, contents: "const open = buildConnectorViewsOpen(runTool);\n" },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D17-chatops-unwrapped-post"]);
  });

  test("D17 accepts buildConnectorViewsOpen inline in buildLedgeredConfirmModal", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: boot,
        contents:
          "const posts = buildLedgeredChatPosts(db, buildConnectorPost(runTool, fn), salt);\n" +
          "const modal = buildLedgeredConfirmModal(db, buildConnectorViewsOpen(runTool), salt);\n",
      },
    ]);
    expect(v).toEqual([]);
  });

  test("D17 rejects a modal opener wrapped by the chat-post ledger (the wrong wrapper)", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: boot,
        contents:
          "const posts = buildLedgeredChatPosts(db, buildConnectorViewsOpen(runTool), salt);\n",
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D17-chatops-unwrapped-post"]);
  });

  test("D17 rejects a chat post wrapped by the modal ledger (the wrong wrapper)", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: boot,
        contents:
          "const modal = buildLedgeredConfirmModal(db, buildConnectorPost(runTool, fn), salt);\n",
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["D17-chatops-unwrapped-post"]);
  });

  test("D17 catches an unwrapped modal opener in a file that also has a wrapped one", () => {
    const v = checkChatopsUnwrappedPost([
      {
        relPath: boot,
        contents:
          "const modal = buildLedgeredConfirmModal(db, buildConnectorViewsOpen(runTool), salt);\n" +
          "const sneaky = buildConnectorViewsOpen(runTool);\n",
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.line).toBe(2);
  });
});

describe("D26 — computer-use actuation confinement", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("D26(a) flags performActuation called outside the gate", () => {
    const v = checkActuationConfinement([
      file("packages/gateway/src/agents/rogue.ts", "await performActuation(lane, req);"),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-actuation-callsite");
  });

  test("D26(a) allows the gate and the definition file", () => {
    expect(
      checkActuationConfinement([
        file("packages/gateway/src/computer-use/cu-gate.ts", "await performActuation(lane, req);"),
        file(
          "packages/gateway/src/computer-use/cu-actuate.ts",
          "export async function performActuation(",
        ),
      ]),
    ).toEqual([]);
  });

  test("D26(a) flags an ALIASED import used to bypass the call-text scan", () => {
    // Review finding: `import { performActuation as invoke }` followed by `invoke(lane, req)`
    // contains no `performActuation(` call-shaped text anywhere -- a call-text-only scan stays
    // silent while a second, unauthorized path to the host exists. Closed at the import: the
    // symbol may not even ENTER SCOPE outside the gate, under any local name.
    const v = checkActuationConfinement([
      file(
        "packages/gateway/src/agents/rogue.ts",
        [
          'import { performActuation as invoke } from "../computer-use/cu-actuate.ts";',
          "await invoke(lane, req);",
        ].join("\n"),
      ),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-actuation-import");
    expect(v[0]?.snippet).toContain("performActuation as invoke");
  });

  test("D26(a) still flags a direct INVOCATION inside cu-actuate.ts itself, not just its declaration", () => {
    // Review finding: the earlier shape allow-listed the WHOLE `cu-actuate.ts` file, so a second,
    // illegitimate direct call added anywhere in that file (below the real declaration) went
    // undetected. Only the declaration line is exempt now — a call-shaped line elsewhere in the
    // same file must still be flagged.
    const v = checkActuationConfinement([
      file(
        "packages/gateway/src/computer-use/cu-actuate.ts",
        [
          "export async function performActuation(",
          "  lane,",
          "  req,",
          ") {",
          "  return null;",
          "}",
          "",
          "// a second, illegitimate direct call bypassing the gate entirely",
          "await performActuation(lane, req);",
        ].join("\n"),
      ),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-actuation-callsite");
    expect(v[0]?.snippet).toContain("await performActuation(lane, req);");
  });

  test("D26(b) flags a driver import outside cu-lanes/", () => {
    // (a) alone does NOT carry this: a new file could construct its own BrowserContext and call
    // page.click() directly, bypassing the gate entirely. Same gap D22(d) closes for emitters.
    const v = checkDriverImportConfinement([
      file("packages/gateway/src/agents/rogue.ts", `import { chromium } from "playwright-core";`),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-driver-import");
  });

  test("D26(b) catches the DYNAMIC import form too", () => {
    const v = checkDriverImportConfinement([
      file("packages/gateway/src/agents/rogue.ts", `const p = await import("playwright-core");`),
    ]);
    expect(v.length).toBe(1);
  });

  test("D26(b) allows the lane driver", () => {
    expect(
      checkDriverImportConfinement([
        file(
          "packages/gateway/src/computer-use/cu-lanes/browser.ts",
          `import { chromium } from "playwright-core";`,
        ),
      ]),
    ).toEqual([]);
  });

  test("D26(b) covers automation libraries beyond the ONE this repo tried and rejected", () => {
    // The rule matched `playwright`/`playwright-core` only. Narrowing a guard to the single library
    // someone happened to evaluate means it has to be re-widened the day anyone adds another.
    for (const lib of [
      "puppeteer",
      "puppeteer-core",
      "chrome-remote-interface",
      "chrome-launcher",
    ]) {
      const v = checkDriverImportConfinement([
        file("packages/gateway/src/agents/rogue.ts", `import x from "${lib}";`),
      ]);
      expect(v.length).toBe(1);
      expect(v[0]?.rule).toBe("D26-driver-import");
    }
  });

  test("D26(b) catches a RAW CDP client, which the library-only check missed entirely", () => {
    // The gap this closes, and it was a real one: the shipped driver is raw CDP over a WebSocket
    // with no dependency at all, so a file opening its own socket and clicking passed the old rule
    // SILENTLY -- disclosed in SECURITY-INVARIANTS.md rather than enforced. A CDP client cannot do
    // anything without NAMING a protocol method, whatever transport it reaches the browser over.
    for (const call of [
      `ws.send(JSON.stringify({ id: 1, method: "Input.dispatchMouseEvent" }));`,
      `await send("Page.navigate", { url });`,
      `conn.send('Runtime.evaluate', { expression });`,
      `const r = await cdp.send(\`Fetch.continueRequest\`, {});`,
    ]) {
      const v = checkDriverImportConfinement([file("packages/gateway/src/agents/rogue.ts", call)]);
      expect(v.length).toBe(1);
      expect(v[0]?.rule).toBe("D26-driver-import");
    }
  });

  test("D26(b) does NOT flag ordinary dotted strings that merely look protocol-shaped", () => {
    // Measured, not assumed: this pattern has zero matches across packages/gateway/src,
    // packages/cli/src and scripts/ outside cu-lanes/. These are the near misses.
    expect(
      checkDriverImportConfinement([
        file(
          "packages/gateway/src/ipc/x.ts",
          [
            `const m = "computer.sessionOpen";`,
            `const n = "agents.negotiate";`,
            `const o = "browser.request";`,
            `const q = "Page";`,
            `log.info("DOM.");`,
          ].join("\n"),
        ),
      ]),
    ).toEqual([]);
  });

  test("D26(b) exempts the lane directory for the CDP form too", () => {
    expect(
      checkDriverImportConfinement([
        file(
          "packages/gateway/src/computer-use/cu-lanes/cdp-session.ts",
          `conn.send("Target.attachToTarget", { targetId, flatten: true });`,
        ),
      ]),
    ).toEqual([]);
  });

  test("D26(c) flags openBrowserLane named outside its definition and the wiring site", () => {
    // The capability arrives as a FUNCTION VALUE, not as protocol text, so neither (a) nor (b) can
    // see it: any file that can import the lane constructor gets a live BrowserLane and can click
    // with no envelope, classification, consent or audit row.
    const v = checkDriverImportConfinement([
      file(
        "packages/gateway/src/agents/rogue.ts",
        `import { openBrowserLane } from "../computer-use/cu-lanes/browser.ts";`,
      ),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-lane-constructor");
  });

  test("D26(c) allows the definition file and the single production wiring site", () => {
    expect(
      checkDriverImportConfinement([
        file(
          "packages/gateway/src/computer-use/cu-lanes/browser.ts",
          `export async function openBrowserLane(opts) {}`,
        ),
        file(
          "packages/gateway/src/platform/assemble.ts",
          `import { openBrowserLane } from "../computer-use/cu-lanes/browser.ts";`,
        ),
      ]),
    ).toEqual([]);
  });

  test("D26(c) flags openTerminalLane named outside its definition and the wiring site", () => {
    // Same reasoning as the browser constructor, and the reason (c) had to be generalised rather
    // than left browser-only: a file that can import `openTerminalLane` gets a live shell and can
    // write to its stdin with no buffer, no consent and no audit row — while (a) sees no
    // `performActuation(` and (b) has no pattern for it at all, because the terminal lane's
    // capability is a plain child process rather than a named protocol.
    const v = checkDriverImportConfinement([
      file(
        "packages/gateway/src/agents/rogue.ts",
        `import { openTerminalLane } from "../computer-use/cu-lanes/terminal.ts";`,
      ),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-lane-constructor");
  });

  test("D26(c) allows the terminal definition file and the same single wiring site", () => {
    expect(
      checkDriverImportConfinement([
        file(
          "packages/gateway/src/computer-use/cu-lanes/terminal.ts",
          `export async function openTerminalLane(opts) {}`,
        ),
        file(
          "packages/gateway/src/platform/assemble.ts",
          `import { openTerminalLane } from "../computer-use/cu-lanes/terminal.ts";`,
        ),
      ]),
    ).toEqual([]);
  });

  test("D26(c) does NOT let one lane's allow-list cover the other", () => {
    // The allow-lists are per-constructor: `cu-lanes/browser.ts` is not a licence to name the
    // TERMINAL constructor, and vice versa. A single shared allow-list would have made every file
    // under `cu-lanes/` able to reach every other lane's driver.
    const v = checkDriverImportConfinement([
      file(
        "packages/gateway/src/computer-use/cu-lanes/browser.ts",
        `import { openTerminalLane } from "./terminal.ts";`,
      ),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D26-lane-constructor");
  });
});

describe("D27(a) remote VLM constructor confinement", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const wiring = "packages/gateway/src/multimodal/build-media-pass-deps.ts";
  const definition = "packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts";

  test("passes at the wiring site when the call is inside a wrapLedgeredVlm argument list", () => {
    expect(
      checkRemoteVlmConfinement([
        file(wiring, "const p = wrapLedgeredVlm(db, createRemoteVlm({ vendor, apiKey }));"),
      ]),
    ).toEqual([]);
  });

  /** Ledgered is not gated, and unwrapped is not ledgered -- this catches the second failure. */
  test("FAILS at the wiring site when the construction is not wrapped", () => {
    expect(
      checkRemoteVlmConfinement([file(wiring, "const p = createRemoteVlm({ vendor, apiKey });")]),
    ).toHaveLength(1);
  });

  /**
   * Paren-matched per occurrence, not file-level: a second unwrapped construction planted beside a
   * legitimate wrapped one in an already-approved file was invisible to the file-level form of
   * this check, which is the exact hole D22(g) was widened to close.
   */
  test("FAILS on an unwrapped call sitting beside a wrapped one in the SAME file", () => {
    expect(
      checkRemoteVlmConfinement([
        file(
          wiring,
          "const a = wrapLedgeredVlm(db, createRemoteVlm({ vendor }));\nconst b = createRemoteVlm({ vendor });",
        ),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS anywhere else, wrapped or not -- a new site demands a deliberate allow-list edit", () => {
    expect(
      checkRemoteVlmConfinement([
        file(
          "packages/gateway/src/engine/agent.ts",
          "const p = wrapLedgeredVlm(db, createRemoteVlm({ vendor }));",
        ),
      ]),
    ).toHaveLength(1);
  });

  test("exempts the factory's own definition -- there is nothing to wrap there", () => {
    expect(
      checkRemoteVlmConfinement([file(definition, "export function createRemoteVlm(opts) {}")]),
    ).toEqual([]);
  });

  test("a mention inside a comment or a string literal does not trip it", () => {
    expect(
      checkRemoteVlmConfinement([
        file(
          "packages/gateway/src/engine/agent.ts",
          '// createRemoteVlm( is discussed here\nconst s = "createRemoteVlm(";',
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D27(b) media_grant table confinement", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const store = "packages/gateway/src/multimodal/media-grant-store.ts";
  const sql = "packages/gateway/src/index/media-grant-v59-sql.ts";

  test("allows the store and the V59 SQL module", () => {
    expect(
      checkMediaGrantStoreConfinement([
        file(store, "SELECT id FROM media_grant WHERE revoked_at IS NULL"),
        file(sql, "CREATE TABLE IF NOT EXISTS media_grant ("),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a read", "SELECT 1 FROM media_grant"],
    ["a write", "INSERT INTO media_grant (id) VALUES (?)"],
    ["an update", "UPDATE media_grant SET revoked_at = ?"],
  ])("FAILS on %s from anywhere else", (_n, sqlText) => {
    expect(
      checkMediaGrantStoreConfinement([
        file("packages/gateway/src/ipc/server/dispatchers.ts", sqlText),
      ]),
    ).toHaveLength(1);
  });

  /**
   * All three are valid SQLite identifier-quoting forms and all three are something a person
   * types by hand -- not a "dynamically assembled identifier": that is a materially different,
   * and much narrower, residual than a bare-identifier regex actually leaves.
   */
  test.each([
    ["double-quoted", 'SELECT 1 FROM "media_grant"'],
    ["backtick-quoted", "SELECT 1 FROM `media_grant`"],
    ["bracket-quoted", "SELECT 1 FROM [media_grant]"],
  ])("FAILS on the %s SQLite form from anywhere else", (_n, sqlText) => {
    expect(
      checkMediaGrantStoreConfinement([
        file("packages/gateway/src/ipc/server/dispatchers.ts", sqlText),
      ]),
    ).toHaveLength(1);
  });

  /**
   * Widening the trailing match to swallow an optional closing quote must not also widen it to
   * swallow a longer identifier sharing this prefix -- `\b` alone does not guard that once a quote
   * character can sit in the boundary position, since `\b` never fires between two non-word
   * characters.
   */
  test("does NOT trip on a longer table name sharing the same prefix", () => {
    expect(
      checkMediaGrantStoreConfinement([
        file("packages/gateway/src/ipc/server/dispatchers.ts", "SELECT 1 FROM media_grant_history"),
      ]),
    ).toEqual([]);
  });

  /** Proves stripComments is actually exercised for THIS rule, not merely shared and untested here. */
  test("a mention inside a comment does not trip it", () => {
    expect(
      checkMediaGrantStoreConfinement([
        file(
          "packages/gateway/src/ipc/server/dispatchers.ts",
          "// see FROM media_grant in the store for the active-row filter",
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D32(a) — the capture table is named only by its store and its DDL", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const store = "packages/gateway/src/mcp-sink/capture-store.ts";
  const sql = "packages/gateway/src/index/capture-v67-sql.ts";

  test("allows the store and the V67 SQL module", () => {
    expect(
      checkCaptureTableConfinement([
        file(store, "SELECT * FROM capture WHERE id = ?"),
        file(sql, "CREATE TABLE IF NOT EXISTS capture ("),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a read", "SELECT 1 FROM capture"],
    ["a write", "INSERT INTO capture (id) VALUES (?)"],
    ["an update", "UPDATE capture SET state = 'x'"],
    ["a quoted name", 'SELECT 1 FROM "capture"'],
    ["a backtick name", "SELECT 1 FROM `capture`"],
    ["a bracket name", "SELECT 1 FROM [capture]"],
    ["a comma join", "SELECT 1 FROM item, capture"],
    ["an UPDATE OR clause", "UPDATE OR IGNORE capture SET x = 1"],
    ["an INSERT OR REPLACE", "INSERT OR REPLACE INTO capture (id) VALUES (1)"],
    ["a schema-qualified name", "SELECT 1 FROM main.capture"],
    ["a quoted schema-qualified name", 'SELECT 1 FROM "main"."capture"'],
    ["a foreign key", "FOREIGN KEY (a) REFERENCES capture(id)"],
    ["an index target", "CREATE INDEX idx_capture_state ON capture (state)"],
    ["an IF NOT EXISTS index target", "CREATE UNIQUE INDEX IF NOT EXISTS i ON main.capture(id)"],
    ["a trigger target", "CREATE TRIGGER t AFTER UPDATE OF state, item_id ON capture BEGIN"],
  ])("FAILS on %s from anywhere else", (_n, sqlText) => {
    expect(
      checkCaptureTableConfinement([file("packages/gateway/src/ipc/capture-rpc.ts", sqlText)]),
    ).toHaveLength(1);
  });

  test("does not match look-alike identifiers or comments", () => {
    expect(
      checkCaptureTableConfinement([
        file(
          "packages/gateway/src/x.ts",
          "SELECT 1 FROM capture_log; // FROM capture\nconst tribalCapture = 1;",
        ),
        file("packages/gateway/src/y.ts", "CREATE INDEX i ON capture_log(id)"),
        file("packages/gateway/src/z.ts", 'log("index rebuilt on capture of the sync state")'),
      ]),
    ).toEqual([]);
  });

  test("ignores test files", () => {
    expect(
      checkCaptureTableConfinement([file("packages/gateway/src/x.test.ts", "FROM capture")]),
    ).toEqual([]);
  });
});

describe("D32(d) — agent-row writers are reachable only through capture-native.ts", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the definitions, capture-native and the gate", () => {
    expect(
      checkAgentProvenanceWriters([
        file(
          "packages/gateway/src/decisions/decision-store.ts",
          "export function insertAgentDecision() {}\nexport function deleteAgentDecision() {}",
        ),
        file(
          "packages/gateway/src/glossary/glossary-store.ts",
          "export function upsertAgentTerm() {}\nexport function deleteAgentTerm() {}",
        ),
        file(
          "packages/gateway/src/mcp-sink/capture-native.ts",
          "insertAgentDecision(db, d); upsertAgentTerm(db, t); export function writeCaptureNative() {}",
        ),
        file(
          "packages/gateway/src/mcp-sink/capture-gate.ts",
          "writeCaptureNative(db, p); revokeCaptureNative(db, r, false);",
        ),
        file("packages/gateway/src/x.test.ts", "insertAgentDecision(db, d)"),
      ]),
    ).toEqual([]);
  });

  test.each([
    [
      "a writer called from the decisions pass",
      "packages/gateway/src/decisions/decision-extract.ts",
      "insertAgentDecision(db, d);",
    ],
    [
      "a writer aliased on import",
      "packages/gateway/src/agents/x.ts",
      'import { upsertAgentTerm as up } from "../glossary/glossary-store.ts";',
    ],
    [
      "capture-native called around the gate",
      "packages/gateway/src/ipc/capture-rpc.ts",
      "writeCaptureNative(db, p);",
    ],
    [
      "a revoke inverse called elsewhere",
      "packages/gateway/src/platform/assemble.ts",
      "revokeCaptureNative(db, r, true);",
    ],
  ])("FAILS on %s", (_n, relPath, src) => {
    expect(checkAgentProvenanceWriters([file(relPath, src)])).toHaveLength(1);
  });

  test("flags a namespace-import call and a re-export; ignores code outside gateway src", () => {
    expect(
      checkAgentProvenanceWriters([
        file("packages/gateway/src/agents/y.ts", "gs.upsertAgentTerm(db, t);"),
      ]),
    ).toHaveLength(1);
    expect(
      checkAgentProvenanceWriters([
        file(
          "packages/gateway/src/agents/z.ts",
          'export { deleteAgentTerm } from "../glossary/glossary-store.ts";',
        ),
      ]),
    ).toHaveLength(1);
    expect(
      checkAgentProvenanceWriters([file("packages/cli/src/x.ts", "gs.upsertAgentTerm(db, t);")]),
    ).toEqual([]);
  });

  test("ignores a mention in a comment or a string", () => {
    expect(
      checkAgentProvenanceWriters([
        file(
          "packages/gateway/src/x.ts",
          '// insertAgentDecision is capture-only\nconst s = "upsertAgentTerm";',
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D32(e)(f)(g) — the act door", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ACT = "packages/gateway/src/mcp-sink/capture-act.ts";
  const GATE = "packages/gateway/src/mcp-sink/capture-gate.ts";

  test("allows the definition and the gate's call", () => {
    expect(
      checkActDoorConfinement([
        file(ACT, "export async function acceptAction(d) {}"),
        file(GATE, "return acceptAction(deps, caller, row, act);"),
      ]),
    ).toEqual([]);
  });

  test("(e) FAILS when acceptAction is named anywhere else", () => {
    const v = checkActDoorConfinement([
      file("packages/gateway/src/ipc/capture-rpc.ts", "acceptAction(d, c, r, a)"),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("act-door-accept-action");
  });

  test("(e) importing a DIFFERENT symbol from capture-act.ts is not a violation", () => {
    expect(
      checkActDoorConfinement([
        file(
          "packages/gateway/src/ipc/capture-rpc.ts",
          'import { formatActionConsent } from "../mcp-sink/capture-act.ts";',
        ),
      ]),
    ).toEqual([]);
  });

  test("(e) ignores a mention in a comment or a string", () => {
    expect(
      checkActDoorConfinement([
        file(
          "packages/gateway/src/x.ts",
          '// acceptAction is gate-only\nconst s = "acceptAction";',
        ),
      ]),
    ).toEqual([]);
  });

  test.each([
    'import { ToolExecutor } from "../engine/executor.ts";',
    'import type { HITL_REQUIRED } from "../engine/executor.ts";',
    'import { proposableWriteTool } from "../connectors/proposable-actions.ts";',
    'import type { X } from "../connectors/registry.ts";',
    'export * from "../connectors/x.ts";',
    'export type { Y } from "../engine/executor";',
    'const m = await import("../engine/executor.ts");',
    'import "../connectors/side-effect.ts";',
    'import {\n  a,\n  b,\n} from "../connectors/registry.ts";',
    'import { HITL_REQUIRED } from "../engine/executor.js";',
    'import { HITL_REQUIRED } from "../engine/executor.mjs";',
    'export { X } from "../engine/executor.mts";',
    'const e = require("../engine/executor.ts");',
    "const c = require('../connectors/registry.cjs');",
    'import executor = require("../engine/executor");',
    "const m = await import(`../engine/executor.ts`);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a template specifier is the fixture
    "const m = await import(`../connectors/${name}.ts`);",
  ])("(f) FAILS: an mcp-sink file %s", (line) => {
    const v = checkActDoorConfinement([file("packages/gateway/src/mcp-sink/capture-x.ts", line)]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("mcp-sink-no-executor-or-connectors");
  });

  test("(f) a semicolon-free allowed import does not hide a forbidden one after it", () => {
    const v = checkActDoorConfinement([
      file(
        "packages/gateway/src/mcp-sink/capture-x.ts",
        'import { serviceOf } from "../engine/service-of.ts"\nimport type { X } from "../connectors/registry.ts"',
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
  });

  test("(f) allows engine/service-of.ts, a test file, and files outside mcp-sink/", () => {
    expect(
      checkActDoorConfinement([
        file(ACT, 'import { serviceOf } from "../engine/service-of.ts";'),
        file(
          "packages/gateway/src/mcp-sink/capture-act.test.ts",
          'import { HITL_REQUIRED } from "../engine/executor.ts";',
        ),
        file(
          "packages/gateway/src/ipc/capture-rpc.ts",
          'import { ToolExecutor } from "../engine/executor.ts";',
        ),
      ]),
    ).toEqual([]);
  });

  test("(g) the mcpToolId literal is confined to capture-validate.ts under mcp-sink/", () => {
    expect(
      checkActDoorConfinement([
        file(
          "packages/gateway/src/mcp-sink/capture-validate.ts",
          'if (Object.hasOwn(input, "mcpToolId")) {}',
        ),
        file("packages/gateway/src/ipc/capture-rpc.ts", "payload: { mcpToolId: toolId, input }"),
      ]),
    ).toEqual([]);
    const v = checkActDoorConfinement([file(GATE, 'payload["mcpToolId"] = x;')]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("mcp-sink-mcptoolid-literal");
  });

  test("(g) a comment mentioning mcpToolId does not trip it", () => {
    expect(checkActDoorConfinement([file(GATE, "// never set mcpToolId here")])).toEqual([]);
  });
});

describe("D32(c) — capture-gate.ts is value-imported only by ipc/capture-rpc.ts", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const rpc = "packages/gateway/src/ipc/capture-rpc.ts";

  test("allows the rpc value import and type imports anywhere", () => {
    expect(
      checkCaptureGateImporters([
        file(rpc, 'import { submitCapture } from "../mcp-sink/capture-gate.ts";'),
        file(
          "packages/gateway/src/platform/assemble.ts",
          'import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";',
        ),
        file("packages/gateway/src/y.ts", 'export type { X } from "../mcp-sink/capture-gate.ts";'),
        file("packages/gateway/src/x.test.ts", 'import * as g from "../mcp-sink/capture-gate.ts";'),
        file(
          "packages/gateway/src/z.ts",
          'import "./polyfill"\nimport type { Y } from "../mcp-sink/capture-gate.ts"',
        ),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a barrel export *", 'export * from "../mcp-sink/capture-gate.ts";'],
    ["a namespace import", 'import * as gate from "../mcp-sink/capture-gate.ts";'],
    ["a value import", 'import { CaptureGateDeps } from "../mcp-sink/capture-gate";'],
    ["a multi-line import", 'import {\n  a,\n  b,\n} from "../mcp-sink/capture-gate.ts";'],
    ["a dynamic import", 'const g = await import("../mcp-sink/capture-gate.ts");'],
    ["a side-effect import", 'import "../mcp-sink/capture-gate.ts";'],
    [
      "a value import after a semicolon-free type import",
      'import type { X } from "./other"\nimport * as gate from "../mcp-sink/capture-gate.ts"',
    ],
    [
      "a value import after a semicolon-free side-effect import",
      'import "./polyfill"\nimport { a } from "../mcp-sink/capture-gate.ts"',
    ],
  ])("FAILS on %s outside capture-rpc.ts", (_n, src) => {
    expect(
      checkCaptureGateImporters([file("packages/gateway/src/platform/assemble.ts", src)]),
    ).toHaveLength(1);
  });

  test("ignores a mention in a comment and unrelated modules", () => {
    expect(
      checkCaptureGateImporters([
        file(
          "packages/gateway/src/x.ts",
          '// import { a } from "./capture-gate.ts";\nimport { b } from "./capture-gates.ts";',
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D32(b) — gate entry points are called only from ipc/capture-rpc.ts", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the rpc dispatcher and the gate's own definitions", () => {
    expect(
      checkCaptureGateCallers([
        file(
          "packages/gateway/src/ipc/capture-rpc.ts",
          "submitCapture(c.gate, c.caller, p); revokeCapture(a, b, c);",
        ),
        file(
          "packages/gateway/src/mcp-sink/capture-gate.ts",
          "export function submitCapture(deps) {}",
        ),
      ]),
    ).toEqual([]);
  });

  test.each(["submitCapture", "acceptCapture", "rejectCapture", "revokeCapture", "purgeCapture"])(
    "FAILS when %s is called anywhere else",
    (fn) => {
      expect(
        checkCaptureGateCallers([
          file("packages/gateway/src/platform/assemble.ts", `${fn}(deps, caller, x)`),
        ]),
      ).toHaveLength(1);
    },
  );

  test("an aliased import is also caught", () => {
    expect(
      checkCaptureGateCallers([
        file(
          "packages/gateway/src/x.ts",
          'import { submitCapture as sc } from "../mcp-sink/capture-gate.ts";',
        ),
      ]),
    ).toHaveLength(1);
  });
});

describe("D29(a) — nimbus/fetch method literal confinement (I39)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const definition = "packages/gateway/src/toolgen/toolgen-types.ts";
  const elsewhere = "packages/gateway/src/toolgen/toolgen-rogue.ts";

  test("allows the definition site", () => {
    expect(
      checkBrokeredFetchLiteralConfinement([
        file(definition, 'export const BROKERED_FETCH_METHOD = "nimbus/fetch";'),
      ]),
    ).toEqual([]);
  });

  test("a comment mentioning the method does NOT trip it", () => {
    expect(
      checkBrokeredFetchLiteralConfinement([
        file(
          elsewhere,
          '// this asks the broker to call "nimbus/fetch" on our behalf\nconst x = 1;',
        ),
      ]),
    ).toEqual([]);
  });

  test("FAILS on a second CODE occurrence", () => {
    expect(
      checkBrokeredFetchLiteralConfinement([file(elsewhere, 'const METHOD = "nimbus/fetch";')]),
    ).toHaveLength(1);
  });

  test("FAILS regardless of quote style", () => {
    expect(
      checkBrokeredFetchLiteralConfinement([file(elsewhere, "const m = `nimbus/fetch`;")]),
    ).toHaveLength(1);
  });

  test("does not trip on an unrelated string sharing a prefix", () => {
    expect(
      checkBrokeredFetchLiteralConfinement([
        file(elsewhere, 'const m = "nimbus/fetch-something-else";'),
      ]),
    ).toEqual([]);
  });
});

describe("D29(b) — generated-manifest constructor confinement (I39)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const definition = "packages/gateway/src/toolgen/toolgen-stub.ts";
  const elsewhere = "packages/gateway/src/toolgen/toolgen-rogue.ts";

  test("allows the one approved definition with an empty network literal", () => {
    expect(
      checkGeneratedManifestConfinement([
        file(
          definition,
          "export function buildGeneratedManifest(toolId) {\n  return { permissions: { network: [] } };\n}",
        ),
      ]),
    ).toEqual([]);
  });

  test("does NOT trip on an ordinary call, an import, or a typeof query", () => {
    expect(
      checkGeneratedManifestConfinement([
        file(
          elsewhere,
          'import { buildGeneratedManifest } from "./toolgen-stub.ts";\nconst m = buildGeneratedManifest("tg_a");\ntype M = ReturnType<typeof buildGeneratedManifest>;',
        ),
      ]),
    ).toEqual([]);
  });

  test("FAILS on a second definition elsewhere", () => {
    expect(
      checkGeneratedManifestConfinement([
        file(elsewhere, "export function buildGeneratedManifest(toolId) { return {}; }"),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS when the approved file assigns network a non-empty literal", () => {
    expect(
      checkGeneratedManifestConfinement([
        file(
          definition,
          'export function buildGeneratedManifest(toolId) {\n  return { permissions: { network: ["api.example.com"] } };\n}',
        ),
      ]),
    ).toHaveLength(1);
  });

  test("does not trip on a non-literal network assignment in the approved file", () => {
    expect(
      checkGeneratedManifestConfinement([
        file(
          definition,
          "export function buildGeneratedManifest(toolId, opts) {\n  return { permissions: { network: opts.network } };\n}",
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D29(c) — toolgen. Vault-key prefix confinement (I39)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const definition = "packages/gateway/src/toolgen/toolgen-credentials.ts";
  const elsewhere = "packages/gateway/src/toolgen/toolgen-rogue.ts";

  test("allows the one composition site", () => {
    expect(
      checkToolgenVaultKeyConfinement([
        file(
          definition,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
          "return `toolgen.${toolId}.${slug}`;",
        ),
      ]),
    ).toEqual([]);
  });

  test("FAILS on a toolgen. key composed outside toolgen-credentials.ts", () => {
    expect(
      checkToolgenVaultKeyConfinement([
        file(
          elsewhere,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
          "const leaked = `toolgen.${toolId}.${slug}`;",
        ),
      ]),
    ).toHaveLength(1);
  });

  test("does not trip on the unrelated single-segment extension id", () => {
    expect(
      checkToolgenVaultKeyConfinement([
        file(
          "packages/gateway/src/toolgen/toolgen-stub.ts",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture under audit
          "id: `toolgen.${toolId}`,",
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D29(d) — saved-tool accessor confinement (I40)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const store = "packages/gateway/src/toolgen/toolgen-saved-store.ts";
  const elsewhere = "packages/gateway/src/toolgen/toolgen-rogue.ts";

  test("allows the store defining and using its own private directory constant", () => {
    expect(
      checkSavedToolAccessorConfinement([
        file(
          store,
          'const SAVED_DIR = "saved";\n' +
            "export function savedToolDir(configDir, toolId) {\n" +
            "  return join(configDir, STORE_DIR, SAVED_DIR, toolId);\n" +
            "}",
        ),
      ]),
    ).toEqual([]);
  });

  test("does NOT trip on the sanctioned accessor itself", () => {
    expect(
      checkSavedToolAccessorConfinement([
        file(
          elsewhere,
          'import { readVerifiedSavedTool } from "./toolgen-saved-store.ts";\n' +
            "const r = await readVerifiedSavedTool(configDir, toolId, pubkeyB64);",
        ),
      ]),
    ).toEqual([]);
  });

  /**
   * The must-fail fixture (task brief step 2): without this, the rule's green is
   * indistinguishable from a rule that matches nothing at all — precisely the failure mode a
   * `/toolgen[\\/]saved/` path-text form would have shipped silently, since zero such literals
   * exist anywhere in this tree.
   */
  test("FAILS when the store's private directory constant is named outside the store", () => {
    expect(
      checkSavedToolAccessorConfinement([
        file(elsewhere, 'const dir = join(configDir, "toolgen", SAVED_DIR, toolId);'),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS on a hypothetical non-verifying accessor name", () => {
    expect(
      checkSavedToolAccessorConfinement([
        file(
          elsewhere,
          "export function readSavedToolUnverified(dir) {\n" +
            '  return JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));\n' +
            "}",
        ),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS on a hypothetical raw-artifact accessor name", () => {
    expect(
      checkSavedToolAccessorConfinement([
        file(elsewhere, "export function rawSavedArtifact(dir) { return readFileSync(dir); }"),
      ]),
    ).toHaveLength(1);
  });

  test("a mention inside a comment does not trip it", () => {
    expect(
      checkSavedToolAccessorConfinement([
        file(elsewhere, "// never add a rawSavedArtifact or readSavedToolUnverified helper here"),
      ]),
    ).toEqual([]);
  });
});

describe("D28 — push ClientKind confinement (oncall push)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ROGUE = "packages/gateway/src/agents/rogue.ts";
  const RUNNER = "packages/gateway/src/oncall-push/push-runner.ts";
  const EGRESS = "packages/gateway/src/egress/egress-bearing-kinds.ts";
  const flagged = (files: FileEntry[]): boolean =>
    checkPushClientKindConfinement(files).some((v) => v.rule === "D28-push-client-kind");

  test("flags an object-literal kind outside the runner", () => {
    expect(flagged([file(ROGUE, `const caller = { clientId: id, kind: "push" };`)])).toBe(true);
  });
  test("flags a SINGLE-quoted kind outside the runner", () => {
    expect(flagged([file(ROGUE, "const caller = { clientId: id, kind: 'push' };")])).toBe(true);
    expect(flagged([file(ROGUE, "const k = 'push' as ClientKind;")])).toBe(true);
  });
  test("allows it in the runner", () => {
    expect(flagged([file(RUNNER, `caller: { clientId: "oncall-push", kind: "push" },`)])).toBe(
      false,
    );
  });
  test("the unquoted `push: null` egress entry is allow-listed in EGRESS, flagged elsewhere", () => {
    const entry = `  fleet: null,\n  push: null,\n});`;
    expect(flagged([file(EGRESS, entry)])).toBe(false);
    expect(flagged([file(ROGUE, entry)])).toBe(true);
  });
  test("does not flag the owner-scoped map entry `push: false` or array push()", () => {
    expect(flagged([file("packages/gateway/src/ipc/agents-rpc.ts", "  push: false,")])).toBe(false);
    expect(flagged([file(ROGUE, "out.push(row);")])).toBe(false);
  });
  test("ignores test files", () => {
    expect(flagged([file("packages/gateway/src/x.test.ts", `kind: "push"`)])).toBe(false);
  });
});

describe("D28 — fleet ClientKind confinement (I38)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ROGUE = "packages/gateway/src/agents/rogue.ts";
  const KIND_DEF = "packages/gateway/src/ipc/server/client-kind.ts";
  const EGRESS = "packages/gateway/src/egress/egress-bearing-kinds.ts";
  const INVOKER = "packages/gateway/src/fleet/fleet-invoker.ts";
  const flagged = (files: FileEntry[]): boolean =>
    checkFleetClientKindConfinement(files).some((v) => v.rule === "D28-fleet-client-kind");

  // ---- positive: one per assignment shape the rule claims to cover -------------------------

  test("flags a SINGLE-quoted kind outside the allow-list", () => {
    expect(flagged([file(ROGUE, "const caller = { clientId: id, kind: 'fleet' };")])).toBe(true);
  });

  test("flags the REAL egress classification shape copy-pasted elsewhere", () => {
    // The rule could not see this until the unquoted-key alternative was added: the map-key
    // alternative required a QUOTED `"fleet":`, while the shipped map writes it bare.
    expect(
      flagged([
        file(
          ROGUE,
          `export const M = {
  fleet: null,
};`,
        ),
      ]),
    ).toBe(true);
  });

  test("does NOT flag a command-map entry — the value is what discriminates", () => {
    // `fleet:` also names the namespace in the CLI command map. Pinning the alternative to a
    // `null` value is what keeps the rule off it; a bare `fleet:` rule would false-positive here
    // and get weakened until it caught nothing.
    expect(flagged([file(ROGUE, `const H = { fleet: runFleet, exec: runExec };`)])).toBe(false);
  });

  test("does NOT flag a bare forbid-list element", () => {
    expect(flagged([file(ROGUE, `const F = new Set(["clip", "fleet", "exec"]);`)])).toBe(false);
  });

  test("flags an object-literal property — the copy-paste case", () => {
    expect(flagged([file(ROGUE, `const caller = { clientId: id, kind: "fleet" };`)])).toBe(true);
  });

  test("flags a plain assignment to any identifier ending in kind", () => {
    expect(flagged([file(ROGUE, `let callerKind = "fleet";`)])).toBe(true);
    expect(flagged([file(ROGUE, `ctx.kind = "fleet";`)])).toBe(true);
  });

  test("flags a ClientKind-typed declaration", () => {
    expect(flagged([file(ROGUE, `const k: ClientKind = "fleet";`)])).toBe(true);
  });

  test("flags a ClientKind assertion", () => {
    expect(flagged([file(ROGUE, `dispatch(method, params, "fleet" as ClientKind);`)])).toBe(true);
  });

  test("flags a ClientKindStore.declare second argument", () => {
    expect(flagged([file(ROGUE, `store.declare(clientId, "fleet");`)])).toBe(true);
  });

  test("flags a second copy of the egress classification", () => {
    expect(flagged([file(ROGUE, `const map = { "fleet": null, mcp: "mcp" };`)])).toBe(true);
  });

  test("flags a line-broken literal — a formatter must not disarm the rule", () => {
    // Prettier/Biome will break a long property onto two lines; a per-line scan alone misses it.
    expect(flagged([file(ROGUE, `const caller = {\n  kind:\n    "fleet",\n};`)])).toBe(true);
  });

  test("reports the line the literal is assigned on, exactly once", () => {
    // Regression guard for the two-line window: a violation wholly on line N must not ALSO be
    // reported as the tail of line N-1's window, which would double-count it at the wrong line.
    const v = checkFleetClientKindConfinement([
      file(ROGUE, `const a = 1;\nconst caller = { kind: "fleet" };\nconst b = 2;`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
    expect(v[0]?.snippet).toBe(`const caller = { kind: "fleet" };`);
  });

  // ---- negative: the legitimate occurrences -------------------------------------------------

  test("does not flag the ClientKind union member in its own definition file", () => {
    const union = `export type ClientKind = "cli" | "mcp" | "ui" | "http" | "chatops" | "fleet" | "unknown";`;
    expect(flagged([file(KIND_DEF, union)])).toBe(false);
    // And not even when it appears somewhere the allow-list does NOT cover: a union member is a
    // type declaration, not an attribution being assigned to a caller.
    expect(flagged([file(ROGUE, union)])).toBe(false);
  });

  test("the unquoted `fleet: null` egress entry is allow-listed in EGRESS, flagged elsewhere", () => {
    // INVERTED deliberately. This test previously asserted the rule flagged NEITHER file, which
    // encoded a real limitation as if it were intent: the map-key alternative required a QUOTED
    // `"fleet":` while the shipped map writes it bare, so a copy-paste of the real egress
    // classification into any file passed. The alternative is now pinned to a `null` VALUE, which
    // separates an egress classification from a command-map entry without matching a bare string.
    const entry = `  chatops: null,\n  fleet: null,\n});`;
    expect(flagged([file(EGRESS, entry)])).toBe(false); // allow-listed: this is its home
    expect(flagged([file(ROGUE, entry)])).toBe(true); // the copy-paste the rule exists to catch
  });

  test("does not flag FLEET_ELIGIBILITY — `preflight` contains `fleet` as a substring", () => {
    expect(
      flagged([
        file(
          "packages/gateway/src/ipc/agents-rpc.ts",
          `  "agents.preflight": "excluded_side_effects",\n  "agents.catchup": "eligible",`,
        ),
      ]),
    ).toBe(false);
  });

  test("does not flag a BARE `fleet` string — the LAN forbid-list and CLI map both need one", () => {
    // Load-bearing. A bare-string rule would false-positive on both of these, and a rule that
    // false-positives on legitimate code gets weakened or allow-listed until it catches nothing.
    expect(flagged([file("packages/gateway/src/ipc/lan-rpc.ts", `  "exec",\n  "fleet",`)])).toBe(
      false,
    );
    expect(flagged([file("packages/cli/src/commands/index.ts", `  fleet: runFleet,`)])).toBe(false);
  });

  // ---- negative: the structural exemptions --------------------------------------------------

  test("allows every file on the allow-list, including one that does not exist yet", () => {
    // fleet-invoker.ts is created in a later task. An allow-list entry for an absent file must be
    // inert, not an error.
    expect(
      checkFleetClientKindConfinement([
        file(KIND_DEF, `const resolved: ClientKind = "fleet";`),
        file(EGRESS, `const m = { "fleet": null };`),
        file(INVOKER, `const caller = { clientId, kind: "fleet" };`),
      ]),
    ).toEqual([]);
  });

  test("ignores .test.ts files", () => {
    expect(flagged([file("packages/gateway/src/fleet/fleet-store.test.ts", `kind: "fleet"`)])).toBe(
      false,
    );
  });

  /** Proves stripComments is actually exercised for THIS rule, not merely shared and untested here. */
  test("does not flag a mere mention in a comment", () => {
    expect(
      flagged([file(ROGUE, `// the invoker sets kind: "fleet" on its caller\nconst x = 1;`)]),
    ).toBe(false);
  });
});

describe("D30-sqlite-runtime-init — a file that can open a database reaches the full-SQLite install", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ROGUE = "packages/gateway/src/index/rogue-opener.ts";
  const flagged = (files: readonly FileEntry[]): boolean =>
    checkSqliteRuntimeInit(files).length > 0;

  // ---- positive: what CANNOT pass -----------------------------------------------------------

  test("flags a NEW entry point that value-imports Database and never calls the init", () => {
    // The regression this rule exists for: issue #1029 was one missing call, and the way it comes
    // back is a fifth entry point added by someone who wired the four that already existed.
    expect(
      flagged([
        file(
          ROGUE,
          'import { Database } from "bun:sqlite";\n' +
            "export function open(p: string) {\n  return new Database(p);\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("flags the ALIASED value import a `new Database(` text scan would miss", () => {
    // Not hypothetical: `db/snapshot.ts` ships exactly this shape.
    expect(
      flagged([
        file(
          ROGUE,
          'import { Database as BunDatabase, type Database } from "bun:sqlite";\n' +
            "export function open(p: string): Database {\n  return new BunDatabase(p);\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("flags a namespace and a default import", () => {
    expect(flagged([file(ROGUE, 'import * as sqlite from "bun:sqlite";')])).toBe(true);
    expect(flagged([file(ROGUE, 'import sqlite from "bun:sqlite";')])).toBe(true);
  });

  test("flags a multi-line import clause", () => {
    expect(
      flagged([
        file(ROGUE, 'import {\n  Database,\n  type SQLQueryBindings,\n} from "bun:sqlite";'),
      ]),
    ).toBe(true);
  });

  test("the violation names the file and the import line", () => {
    const v = checkSqliteRuntimeInit([
      file(ROGUE, 'const x = 1;\nimport { Database } from "bun:sqlite";'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("D30-sqlite-runtime-init");
    expect(v[0]?.file).toBe(ROGUE);
    expect(v[0]?.line).toBe(2);
    expect(v[0]?.snippet).toBe('import { Database } from "bun:sqlite";');
  });

  // ---- negative: what legitimately passes ----------------------------------------------------

  test("accepts a value import when the file calls the init", () => {
    expect(
      flagged([
        file(
          ROGUE,
          'import { Database } from "bun:sqlite";\n' +
            'import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";\n' +
            "export function open(p: string) {\n  ensureFullSqlite();\n  return new Database(p);\n}",
        ),
      ]),
    ).toBe(false);
  });

  test("ignores `import type` — ~200 files receive a handle they did not open", () => {
    expect(flagged([file(ROGUE, 'import type { Database } from "bun:sqlite";')])).toBe(false);
  });

  test("ignores an inline type-only specifier, which binds nothing at runtime", () => {
    expect(flagged([file(ROGUE, 'import { type Database } from "bun:sqlite";')])).toBe(false);
  });

  test("ignores .test.ts — the bunfig preload installs once for the whole test process", () => {
    expect(
      flagged([
        file("packages/gateway/src/index/thing.test.ts", 'import { Database } from "bun:sqlite";'),
      ]),
    ).toBe(false);
  });

  /** Proves stripComments is exercised for THIS rule, not merely shared and untested here. */
  test("does not flag a mention inside a comment", () => {
    expect(flagged([file(ROGUE, '// import { Database } from "bun:sqlite";\nconst x = 1;')])).toBe(
      false,
    );
  });

  test("an import from a DIFFERENT module is not this rule's business", () => {
    expect(flagged([file(ROGUE, 'import { Database } from "node:sqlite";')])).toBe(false);
  });

  test("a lazy clause match cannot start at an earlier import and swallow it", () => {
    // `[^;]` cannot cross a statement terminator, so the type-only bun:sqlite import below is
    // still read as type-only even with a value import of something else immediately above it.
    expect(
      flagged([
        file(
          ROGUE,
          'import { readFileSync } from "node:fs";\nimport type { Database } from "bun:sqlite";',
        ),
      ]),
    ).toBe(false);
  });

  // ---- the rule is live against the real tree ------------------------------------------------

  test("every real gateway entry point is wired (no violations in the scanned tree)", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkSqliteRuntimeInit(files)).toEqual([]);
    // Red-proof for the assertion above: the scan really did read files that carry the shape this
    // rule polices, so the empty result is enforcement rather than an empty input.
    const openers = files.filter(
      (f) =>
        /^import\s+([^;]*?)\s*from\s*["']bun:sqlite["']/m.test(f.contents) &&
        f.contents.includes("ensureFullSqlite"),
    );
    expect(openers.length).toBeGreaterThanOrEqual(10);
  });
});

describe("D31-listener-registry-registration — a listen site registers with the live registry", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ROGUE = "packages/gateway/src/ipc/rogue-listener.ts";
  const flagged = (files: readonly FileEntry[]): boolean =>
    checkListenerRegistryConfinement(files).length > 0;

  // ---- positive: what CANNOT pass -----------------------------------------------------------

  test("flags a Bun.listen<State>({ call with no registerListener — the generic-argument shape a bare Bun\\.listen\\( scan would miss", () => {
    expect(
      flagged([
        file(
          ROGUE,
          'import type { State } from "./options.ts";\n' +
            "export function open() {\n  return Bun.listen<State>({ port: 0, socket: {} });\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("flags a Bun.serve( call with no registerListener", () => {
    expect(
      flagged([file(ROGUE, "export function open() {\n  return Bun.serve({ port: 0 });\n}")]),
    ).toBe(true);
  });

  test("flags a file that only NAMES unregisterListener (never CALLS registerListener) and opens a real Bun.serve( socket", () => {
    // Regression: an earlier version matched the bare SUBSTRING "registerListener", and
    // "unregisterListener" contains that substring — so a file that merely reads back an
    // earlier unregister handle (never calling registerListener itself) passed clean.
    expect(
      flagged([
        file(
          ROGUE,
          "export function stop(h: { unregisterListener: () => void }) {\n" +
            "  const off = h.unregisterListener;\n" +
            "  off();\n" +
            "  return Bun.serve({ port: 0 });\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("flags a net.createServer( call with no registerListener", () => {
    expect(
      flagged([
        file(
          ROGUE,
          'import net from "node:net";\n' +
            "export function open() {\n  return net.createServer(() => {});\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("a typeof Bun.listen<…> type query PLUS a real Bun.listen<State>({ call, no registerListener, is still a violation", () => {
    // Ruling: stripping the type query must not hide a real call in the SAME file.
    expect(
      flagged([
        file(
          ROGUE,
          "let bunListener: ReturnType<typeof Bun.listen<State>> | undefined;\n" +
            "export function open() {\n  bunListener = Bun.listen<State>({ port: 0, socket: {} });\n  return bunListener;\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("server.ts's exact shape — a typeof type query plus the identifier unregisterIpcListener, no real call — is CLEAN only via the typeof exemption", () => {
    // A fixture copy of ipc/server/server.ts's own shape: it carries `typeof Bun.listen<...>`
    // ONLY as a type query (no real Bun.listen call lives in server.ts itself — the real calls
    // live in socket-listeners.ts) plus the identifier `unregisterIpcListener`, and it must be
    // clean BECAUSE the typeof query is blanked before matching, not because of anything the
    // `unregisterIpcListener`/`unregisterListener` identifiers themselves would satisfy — the
    // anchored registerListener-CALL check (Important finding 1) does not accept an unregister
    // identifier as proof of registration.
    expect(
      flagged([
        file(
          ROGUE,
          "let bunListener: ReturnType<typeof Bun.listen<State>> | undefined;\n" +
            "let unregisterIpcListener: (() => void) | undefined;\n" +
            "export function stop(): void {\n  unregisterIpcListener?.();\n  unregisterIpcListener = undefined;\n}",
        ),
      ]),
    ).toBe(false);
  });

  test("the same server.ts-shaped fixture PLUS a real Bun.listen<S>({ call is a violation — the exemption never hides a real call", () => {
    expect(
      flagged([
        file(
          ROGUE,
          "let bunListener: ReturnType<typeof Bun.listen<State>> | undefined;\n" +
            "let unregisterIpcListener: (() => void) | undefined;\n" +
            "export function start(): void {\n  bunListener = Bun.listen<State>({ port: 0, socket: {} });\n}\n" +
            "export function stop(): void {\n  unregisterIpcListener?.();\n  unregisterIpcListener = undefined;\n}",
        ),
      ]),
    ).toBe(true);
  });

  test("the violation names the file and the listen-call line", () => {
    const v = checkListenerRegistryConfinement([
      file(ROGUE, "const x = 1;\nBun.serve({ port: 0 });"),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("D31-listener-registry-registration");
    expect(v[0]?.file).toBe(ROGUE);
    expect(v[0]?.line).toBe(2);
    expect(v[0]?.snippet).toBe("Bun.serve({ port: 0 });");
  });

  // ---- negative: what legitimately passes ----------------------------------------------------

  test("accepts a listen call when the file also names registerListener", () => {
    expect(
      flagged([
        file(
          ROGUE,
          'import { registerListener } from "../locality/listener-registry.ts";\n' +
            "export function open() {\n" +
            "  const l = Bun.listen<State>({ port: 0, socket: {} });\n" +
            '  registerListener(() => ({ name: "ipc", address: "x", loopback: true }));\n' +
            "  return l;\n}",
        ),
      ]),
    ).toBe(false);
  });

  test("a fixture with ONLY a typeof Bun.listen<…> type query and no registerListener is clean — the query opens nothing", () => {
    expect(
      flagged([
        file(
          ROGUE,
          "let bunListener: ReturnType<typeof Bun.listen<State>> | undefined;\n" +
            "export function get() {\n  return bunListener;\n}",
        ),
      ]),
    ).toBe(false);
  });

  test("ignores .test.ts", () => {
    expect(
      flagged([file("packages/gateway/src/ipc/rogue-listener.test.ts", "Bun.serve({ port: 0 });")]),
    ).toBe(false);
  });

  test("ignores a file outside packages/gateway/src/", () => {
    expect(flagged([file("packages/cli/src/rogue-listener.ts", "Bun.serve({ port: 0 });")])).toBe(
      false,
    );
  });

  /** Proves stripComments is exercised for THIS rule, not merely shared and untested here. */
  test("does not flag a mention only inside a comment", () => {
    expect(flagged([file(ROGUE, "// Bun.serve({ port: 0 });\nconst x = 1;")])).toBe(false);
  });

  // ---- the rule is live against the real tree ------------------------------------------------

  test("every real listen site is registered (no violations in the scanned tree)", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkListenerRegistryConfinement(files)).toEqual([]);
    // Red-proof for the assertion above: the scan really did read files that carry the shape this
    // rule polices, so the empty result is enforcement rather than an empty input.
    const listenSites = files.filter(
      (f) =>
        f.relPath.startsWith("packages/gateway/src/") &&
        /\bBun\.(?:serve|listen)\b|\bcreateServer\s*\(/.test(f.contents),
    );
    expect(listenSites.length).toBeGreaterThanOrEqual(5);
  });
});

describe("D37 — the trust tables are named only by the trust store and their DDL", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the store and the V76 SQL module", () => {
    expect(
      checkTrustTableConfinement([
        file(
          "packages/gateway/src/extensions/trust/trust-store.ts",
          "INSERT OR IGNORE INTO trust_statement (x) VALUES (?); SELECT 1 FROM trust_feed_state",
        ),
        file(
          "packages/gateway/src/index/trust-layer-v76-sql.ts",
          "CREATE TABLE IF NOT EXISTS trust_statement ( CREATE TABLE IF NOT EXISTS trust_feed_state (",
        ),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a statement write", "INSERT INTO trust_statement (statement_id) VALUES (?)"],
    ["a statement delete", "DELETE FROM trust_statement WHERE kind = 'key.revoke'"],
    ["a floor update", "UPDATE trust_feed_state SET last_sequence = 0"],
    ["CREATE TABLE IF NOT EXISTS", "CREATE TABLE IF NOT EXISTS trust_statement (id TEXT)"],
    ["DROP TABLE IF EXISTS", "DROP TABLE IF EXISTS trust_feed_state"],
    ["a quoted name", 'SELECT 1 FROM "trust_feed_state"'],
    ["a schema-qualified name", "SELECT 1 FROM main.trust_statement"],
  ])("FAILS on %s from anywhere else", (_n, sql) => {
    expect(
      checkTrustTableConfinement([
        file("packages/gateway/src/extensions/trust/trust-feed.ts", sql),
      ]),
    ).toHaveLength(1);
  });

  test("does not match a look-alike identifier, a comment, or a test file", () => {
    expect(
      checkTrustTableConfinement([
        file("packages/gateway/src/ipc/trust-rpc.ts", "SELECT 1 FROM trust_statements_view"),
        file("packages/gateway/src/ipc/trust-rpc.ts", "// INSERT INTO trust_statement"),
        file("packages/gateway/src/ipc/trust-rpc.test.ts", "DELETE FROM trust_statement"),
      ]),
    ).toEqual([]);
  });
});

describe("D38 — extension code runs for evaluation only offline, without credentials", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const EVAL = "packages/gateway/src/extensions/eval";
  const rules = (files: FileEntry[]): string[] => checkEvalConfinement(files).map((v) => v.rule);

  test("allows the real shape: the builder in its module and the runtime, the entry command in its two modules", () => {
    expect(
      checkEvalConfinement([
        file(
          `${EVAL}/eval-spawn-spec.ts`,
          [
            'import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";',
            'import { extensionEntryCommand } from "../extension-launch-command.ts";',
            'import { extensionProcessEnv } from "../spawn-env.ts";',
            "export function buildExtensionEvalSpawnSpec() { return extensionEntryCommand(); }",
          ].join("\n"),
        ),
        file(
          `${EVAL}/eval-runtime.ts`,
          'import { buildExtensionEvalSpawnSpec } from "./eval-spawn-spec.ts";',
        ),
        file(
          `${EVAL}/eval-role.ts`,
          'const m = await import("@mastra/mcp");\nimport type { MCPClient } from "@mastra/mcp";',
        ),
        file(
          "packages/gateway/src/extensions/extension-runtime.ts",
          'import { readCredentialEnv } from "./extension-credentials.ts";\nexport function extensionEntryCommand() {}',
        ),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a call", "buildExtensionEvalSpawnSpec(staged, deps)"],
    [
      "an aliased import",
      'import { buildExtensionEvalSpawnSpec as b } from "./eval/eval-spawn-spec.ts";',
    ],
  ])("(a) FAILS on the spec builder named elsewhere: %s", (_n, src) => {
    expect(rules([file("packages/gateway/src/extensions/extension-runtime.ts", src)])).toEqual([
      "eval-spec-builder-confined",
    ]);
    // Inside extensions/eval/ too: the role may not build a spec of its own.
    expect(rules([file(`${EVAL}/eval-role.ts`, src)])).toEqual(["eval-spec-builder-confined"]);
  });

  test("(b) FAILS on the unwrapped entry command named outside its two modules", () => {
    const src = 'import { extensionEntryCommand } from "../extension-runtime.ts";';
    expect(rules([file(`${EVAL}/eval-runtime.ts`, src)])).toEqual(["eval-entry-command-confined"]);
    expect(rules([file("packages/gateway/src/extensions/run-extension-entry.ts", src)])).toEqual([
      "eval-entry-command-confined",
    ]);
  });

  test.each([
    ["the Vault", 'import { readPublisherKeyFor } from "../../vault/index.ts";'],
    ["the egress ledger", 'import { appendEgressEntry } from "../../egress/egress-ledger.ts";'],
    ["IPC", 'import { IPCServer } from "../../ipc/server.ts";'],
    ["the DB writer", 'import { dbRun } from "../../db/write.ts";'],
    ["the executor", 'import { ToolExecutor } from "../../engine/executor.ts";'],
    ["a type-only import", 'import type { NimbusVault } from "../../vault/nimbus-vault.ts";'],
    ["a dynamic import", 'const v = await import("../../vault/index.ts");'],
    ["a re-export", 'export { dbRun } from "../../db/write.ts";'],
    ["a bare import", 'import "../../ipc/server.ts";'],
    ["a bare db/ directory specifier", 'import { dbRun } from "../../db";'],
    ["a bare vault/ directory specifier", 'const v = await import("../../vault");'],
    ["a multi-line import", 'import {\n  dbRun,\n  dbExec,\n} from "../../db/write.ts";'],
  ])("(c) FAILS on a module under extensions/eval/ importing %s", (_n, src) => {
    expect(rules([file(`${EVAL}/eval-source.ts`, src)])).toEqual(["eval-imports-confined"]);
  });

  test("(c) reads only extensions/eval/, and not a look-alike segment or a comment", () => {
    expect(
      checkEvalConfinement([
        file(
          "packages/gateway/src/extensions/install-from-local.ts",
          'import "../vault/index.ts";',
        ),
        file(`${EVAL}/eval-source.ts`, 'import { x } from "../../dbx/y.ts";'),
        file(`${EVAL}/eval-source.ts`, 'import { x } from "../../dbx";'),
        file(`${EVAL}/eval-source.ts`, 'import { x } from "../../platform/ipc-path.ts";'),
        file(`${EVAL}/eval-source.ts`, '// import { dbRun } from "../../db/write.ts";'),
      ]),
    ).toEqual([]);
  });

  test("(d) FAILS on readCredentialEnv named under extensions/eval/", () => {
    expect(
      rules([
        file(
          `${EVAL}/eval-spawn-spec.ts`,
          'import { readCredentialEnv } from "../extension-credentials.ts";',
        ),
      ]),
    ).toEqual(["eval-no-credentials"]);
    expect(
      rules([file(`${EVAL}/eval-runtime.ts`, "const e = await readCredentialEnv(v, c);")]),
    ).toEqual(["eval-no-credentials"]);
  });

  test.each([
    ["a named import", 'import { MCPClient } from "@mastra/mcp";'],
    ["a subpath import", 'import { x } from "@mastra/mcp/client";'],
    ["a bare import", 'import "@mastra/mcp";'],
    ["a re-export", 'export { MCPClient } from "@mastra/mcp";'],
  ])("(e) FAILS on a static @mastra/mcp value import under extensions/eval/: %s", (_n, src) => {
    expect(rules([file(`${EVAL}/eval-role.ts`, src)])).toEqual(["eval-mcp-client-dynamic-only"]);
  });

  test("ignores test files and comments", () => {
    expect(
      checkEvalConfinement([
        file(
          `${EVAL}/eval-role.test.ts`,
          'import { MCPClient } from "@mastra/mcp";\nreadCredentialEnv();',
        ),
        file("packages/gateway/src/ipc/x.ts", "// buildExtensionEvalSpawnSpec(s)"),
      ]),
    ).toEqual([]);
  });

  test("the real tree is clean, and the scan really read the eval modules", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkEvalConfinement(files)).toEqual([]);
    const evalFiles = files.filter(
      (f) => f.relPath.startsWith(`${EVAL}/`) && !f.relPath.endsWith(".test.ts"),
    );
    expect(evalFiles.map((f) => f.relPath).sort()).toEqual([
      `${EVAL}/eval-reply.ts`,
      `${EVAL}/eval-role.ts`,
      `${EVAL}/eval-runtime.ts`,
      `${EVAL}/eval-source.ts`,
      `${EVAL}/eval-spawn-spec.ts`,
    ]);
  });
});

describe("D33(b) — extension_run_grant is named only by its store and its DDL", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the store and the V70 and V72 SQL modules", () => {
    expect(
      checkRunGrantTableConfinement([
        file(
          "packages/gateway/src/extensions/run-grant-store.ts",
          "SELECT * FROM extension_run_grant",
        ),
        file(
          "packages/gateway/src/index/extension-run-grant-v70-sql.ts",
          "CREATE TABLE IF NOT EXISTS extension_run_grant (",
        ),
        file(
          "packages/gateway/src/index/extension-run-grant-credentials-v72-sql.ts",
          "ALTER TABLE extension_run_grant ADD COLUMN credentials_json TEXT",
        ),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a read", "SELECT 1 FROM extension_run_grant"],
    ["a write", "INSERT INTO extension_run_grant (extension_id) VALUES (?)"],
    ["an upsert-or-replace", "INSERT OR REPLACE INTO extension_run_grant (x) VALUES (1)"],
    ["a delete", "DELETE FROM extension_run_grant WHERE extension_id = ?"],
    ["a quoted name", 'SELECT 1 FROM "extension_run_grant"'],
    ["a schema-qualified name", "UPDATE main.extension_run_grant SET version = ?"],
  ])("FAILS on %s from anywhere else", (_n, sql) => {
    expect(
      checkRunGrantTableConfinement([file("packages/gateway/src/ipc/automation-rpc.ts", sql)]),
    ).toHaveLength(1);
  });

  test("does not match a look-alike identifier, a comment, or a test file", () => {
    expect(
      checkRunGrantTableConfinement([
        file(
          "packages/gateway/src/x.ts",
          "FROM extension_run_grant_v2; // FROM extension_run_grant",
        ),
        file("packages/gateway/src/y.test.ts", "FROM extension_run_grant"),
      ]),
    ).toEqual([]);
  });
});

describe("D33(c) — only the store and the approve/revoke path create or delete a run grant", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the store, approve-run.ts, and (delete only) extension-store.ts", () => {
    expect(
      checkRunGrantWriters([
        file(
          "packages/gateway/src/extensions/run-grant-store.ts",
          "export function upsertRunGrant() {}\nexport function deleteRunGrant() {}",
        ),
        file(
          "packages/gateway/src/extensions/approve-run.ts",
          'import { deleteRunGrant, upsertRunGrant } from "./run-grant-store.ts";\nupsertRunGrant(db, row);\ndeleteRunGrant(db, id);',
        ),
        file(
          "packages/gateway/src/automation/extension-store.ts",
          'import { deleteRunGrant } from "../extensions/run-grant-store.ts";\ndeleteRunGrant(db, id);',
        ),
      ]),
    ).toEqual([]);
  });

  test("FAILS on an upsert call from anywhere else", () => {
    const v = checkRunGrantWriters([
      file("packages/gateway/src/ipc/automation-rpc.ts", "upsertRunGrant(db, row);"),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("run-grant-writers");
    expect(v[0]?.line).toBe(1);
  });

  test("FAILS on an upsert from extension-store.ts, which may only delete", () => {
    expect(
      checkRunGrantWriters([
        file("packages/gateway/src/automation/extension-store.ts", "upsertRunGrant(db, row);"),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS on a delete call from anywhere else", () => {
    expect(
      checkRunGrantWriters([
        file("packages/gateway/src/ipc/automation-rpc.ts", "deleteRunGrant(db, id);"),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS on an aliased import", () => {
    const v = checkRunGrantWriters([
      file(
        "packages/gateway/src/ipc/automation-rpc.ts",
        'import { upsertRunGrant as grant } from "../extensions/run-grant-store.ts";\ngrant(db, row);',
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });

  test("does not match a comment, a look-alike identifier, a test file, or a non-gateway file", () => {
    expect(
      checkRunGrantWriters([
        file(
          "packages/gateway/src/x.ts",
          "// upsertRunGrant(db, row)\n/* deleteRunGrant */\nconst upsertRunGrants = 1;",
        ),
        file("packages/gateway/src/y.test.ts", "upsertRunGrant(db, row); deleteRunGrant(db, id);"),
        file("scripts/z.ts", "upsertRunGrant(db, row);"),
      ]),
    ).toEqual([]);
  });
});

describe("D33(a) — the __nimbus-extension role is named only by the layout and the launch command", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const LAYOUT = "packages/gateway/src/platform/runtime-layout.ts";
  const RUNTIME = "packages/gateway/src/extensions/extension-runtime.ts";
  const LAUNCH = "packages/gateway/src/extensions/extension-launch-command.ts";

  test("allows the literal in runtime-layout.ts and selfSpawn(extension) in extension-launch-command.ts", () => {
    expect(
      checkExtensionRoleConfinement([
        file(LAYOUT, 'export const R = { extension: "__nimbus-extension" };'),
        file(LAUNCH, 'selfSpawn("extension", [p]);'),
      ]),
    ).toEqual([]);
  });

  test("FAILS on the literal in any other gateway file", () => {
    const v = checkExtensionRoleConfinement([
      file("packages/gateway/src/index.ts", 'if (s === "__nimbus-extension") {}'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("extension-role-confined");
    expect(v[0]?.line).toBe(1);
  });

  test("FAILS on the literal in extension-runtime.ts (only the layout may name it)", () => {
    expect(
      checkExtensionRoleConfinement([file(RUNTIME, 'const s = "__nimbus-extension";')]),
    ).toHaveLength(1);
  });

  test.each([
    ["double quotes", 'selfSpawn("extension", [p])'],
    ["single quotes", "selfSpawn('extension', [p])"],
    ["a template literal", "selfSpawn(`extension`, [p])"],
    ["inner whitespace", 'selfSpawn( "extension", [p])'],
    ["whitespace before the paren", 'selfSpawn ("extension", [p])'],
    ["a comment before the paren", 'selfSpawn /* note */ ("extension", [p])'],
  ])("FAILS on selfSpawn with %s outside extension-launch-command.ts", (_n, src) => {
    expect(
      checkExtensionRoleConfinement([file("packages/gateway/src/index.ts", src)]),
    ).toHaveLength(1);
  });

  test("FAILS on selfSpawn(extension) in extension-runtime.ts (it holds the launch command, not the role)", () => {
    expect(
      checkExtensionRoleConfinement([file(RUNTIME, 'selfSpawn("extension", [p]);')]),
    ).toHaveLength(1);
  });

  test("does not match a comment, a test file, a non-gateway file, or another role", () => {
    expect(
      checkExtensionRoleConfinement([
        file("packages/gateway/src/x.ts", '// __nimbus-extension\nselfSpawn("sandbox", [p]);'),
        file("packages/gateway/src/y.test.ts", 'selfSpawn("extension", []); "__nimbus-extension"'),
        file("scripts/z.ts", '"__nimbus-extension"'),
      ]),
    ).toEqual([]);
  });
});

describe("D34 — the connector migration's table, grant entry point and consent are confined", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const ENGINE = "packages/gateway/src/extensions/migration/migration-engine.ts";
  const RPC = "packages/gateway/src/ipc/migration-rpc.ts";

  test("allows the store, the DDL, approve-run.ts, the engine, the RPC path, migration-boot.ts, the I2 set and the proposability table", () => {
    expect(
      checkMigrationConfinement([
        file(
          "packages/gateway/src/extensions/migration/migration-store.ts",
          "UPDATE connector_migration SET state = ?",
        ),
        file(
          "packages/gateway/src/index/connector-migration-v73-sql.ts",
          "CREATE TABLE IF NOT EXISTS connector_migration (",
        ),
        file(
          "packages/gateway/src/extensions/approve-run.ts",
          "export async function approveMigratedExtensionRun() {}",
        ),
        file(
          ENGINE,
          'import { approveMigratedExtensionRun } from "../approve-run.ts";\nexport const EXTENSION_MIGRATE_ACTION_TYPE = "extension.migrate";\nexport function migrationConsentViaGate() {}\nexport function createMigrationEngine() {}',
        ),
        file(RPC, "engine.accept(id, migrationConsentViaGate(gate));"),
        file("packages/gateway/src/platform/assemble.ts", "ipcOpts.migrationEngine = engine;"),
        file("packages/gateway/src/ipc/server/options.ts", "migrationEngine?: MigrationEngine;"),
        file(
          "packages/gateway/src/ipc/server/dispatchers.ts",
          "const engine = ctx.options.migrationEngine;",
        ),
        file(
          "packages/gateway/src/platform/migration-boot.ts",
          "return createMigrationEngine({});",
        ),
        file("packages/gateway/src/engine/executor.ts", '  "extension.migrate",'),
        file("packages/gateway/src/connectors/proposable-actions.ts", '  "extension.migrate",'),
      ]),
    ).toEqual([]);
  });

  test.each([
    [
      "a write to the table",
      "INSERT INTO connector_migration (id) VALUES (?)",
      "migration-table-confined",
    ],
    ["a read of the table", "SELECT * FROM connector_migration", "migration-table-confined"],
    [
      "a grant without the engine",
      "await approveMigratedExtensionRun(deps, id);",
      "migration-grant-callers",
    ],
    [
      "an aliased grant import",
      'import { approveMigratedExtensionRun as g } from "./x";',
      "migration-grant-callers",
    ],
    [
      "a second consent raiser",
      "await engine.accept(id, migrationConsentViaGate(gate));",
      "migration-consent-raisers",
    ],
    [
      "the action-type constant",
      "gate({ type: EXTENSION_MIGRATE_ACTION_TYPE, payload });",
      "migration-consent-raisers",
    ],
    ["the literal", 'gate({ type: "extension.migrate", payload });', "migration-consent-raisers"],
    ["a second engine", "createMigrationEngine(deps);", "migration-consent-raisers"],
    [
      "a prompt-less accept through the engine option",
      "await ctx.options.migrationEngine.accept(id, async () => true);",
      "migration-consent-raisers",
    ],
  ])("FAILS on %s from anywhere else", (_n, src, rule) => {
    const v = checkMigrationConfinement([file("packages/gateway/src/ipc/automation-rpc.ts", src)]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe(rule);
    expect(v[0]?.line).toBe(1);
  });

  test("the RPC path may raise the consent but never names the table or the grant entry point", () => {
    expect(
      checkMigrationConfinement([file(RPC, "await approveMigratedExtensionRun(d, id);")]),
    ).toHaveLength(1);
    expect(
      checkMigrationConfinement([file(RPC, 'gate({ type: "extension.migrate", payload });')]),
    ).toHaveLength(1);
  });

  test("does not match a comment, a look-alike identifier, a test file, or a non-gateway file", () => {
    expect(
      checkMigrationConfinement([
        file(
          "packages/gateway/src/x.ts",
          '// approveMigratedExtensionRun "extension.migrate"\n/* FROM connector_migration */\nconst approveMigratedExtensionRuns = 1;\nconst t = "extension.migrated";',
        ),
        file("packages/gateway/src/y.test.ts", "approveMigratedExtensionRun(d, id);"),
        file("scripts/z.ts", "migrationConsentViaGate(gate);"),
      ]),
    ).toEqual([]);
  });
});

describe("D35 — config reads are confined to the layered reader", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("flags a nimbus.toml literal outside the reader", () => {
    const v = checkConfigReaderConfinement([
      file("packages/gateway/src/ipc/x.ts", 'const p = join(d, "nimbus.toml");'),
    ]);
    expect(v.map((x) => x.rule)).toEqual(["config-reader-confined"]);
  });

  test("allows the reader", () => {
    expect(
      checkConfigReaderConfinement([
        file("packages/gateway/src/config/layered-config.ts", 'const p = join(d, "nimbus.toml");'),
      ]),
    ).toEqual([]);
  });

  test("flags a FromPath call in production", () => {
    expect(
      checkConfigReaderConfinement([
        file("packages/gateway/src/platform/assemble.ts", "const f = loadNimbusFleetFromPath(p);"),
      ]),
    ).toHaveLength(1);
  });

  test("ignores the definition", () => {
    expect(
      checkConfigReaderConfinement([
        file(
          "packages/gateway/src/config/fleet-toml.ts",
          "export function loadNimbusFleetFromPath(p: string) { return p; }",
        ),
      ]),
    ).toEqual([]);
  });

  test("ignores a FromPath definition outside config/", () => {
    expect(
      checkConfigReaderConfinement([
        file(
          "packages/gateway/src/ipc/x.ts",
          "export function loadXFromPath(p: string) { return p; }",
        ),
      ]),
    ).toEqual([]);
  });

  test("ignores nimbus.openapi.toml", () => {
    expect(
      checkConfigReaderConfinement([
        file("packages/gateway/src/ipc/x.ts", 'join(d, "nimbus.openapi.toml");'),
      ]),
    ).toEqual([]);
  });

  test("ignores prose", () => {
    expect(
      checkConfigReaderConfinement([
        file(
          "packages/gateway/src/agents/x.ts",
          'const m = "Edit `[ci.service.<id>]` in `nimbus.toml`";\nconst k = n !== "nimbus.toml";',
        ),
      ]),
    ).toEqual([]);
  });

  test("catches resolve() and resolveNimbusTomlForProfile", () => {
    expect(
      checkConfigReaderConfinement([
        file("packages/gateway/src/ipc/x.ts", 'resolve(dir, "nimbus.toml");'),
      ]),
    ).toHaveLength(1);
    expect(
      checkConfigReaderConfinement([
        file("packages/gateway/src/ipc/x.ts", "resolveNimbusTomlForProfile(a, b);"),
      ]),
    ).toHaveLength(1);
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkConfigReaderConfinement(files)).toEqual([]);
  });
});

describe("D36 — only the store and pack-install.ts name the pack-layer writers (I47)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const STORE = "packages/gateway/src/packs/pack-layer-store.ts";
  const INSTALL = "packages/gateway/src/packs/pack-install.ts";

  test("allows the store and pack-install.ts", () => {
    expect(
      checkPackLayerWriters([
        file(STORE, "setPackLayer(p, i, d, o) {}\nremovePackLayer(p, i) {}"),
        file(
          INSTALL,
          "deps.store.setPackLayer(p, id, d, { record });\ndeps.store.removePackLayer(p, id);",
        ),
      ]),
    ).toEqual([]);
  });

  test("FAILS on setPackLayer named anywhere else", () => {
    const v = checkPackLayerWriters([
      file(
        "packages/gateway/src/ipc/pack-rpc.ts",
        "const x = 1;\nstore.setPackLayer(p, id, d, o);",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("pack-layer-writers");
    expect(v[0]?.line).toBe(2);
  });

  test("FAILS on removePackLayer named anywhere else, and on a destructured alias", () => {
    expect(
      checkPackLayerWriters([
        file("packages/gateway/src/ipc/server/dispatchers.ts", "store.removePackLayer(p, id);"),
      ]),
    ).toHaveLength(1);
    expect(
      checkPackLayerWriters([
        file("packages/gateway/src/x.ts", "const { setPackLayer: w } = store;\nw(p, id, d, o);"),
      ]),
    ).toHaveLength(1);
  });

  test("does not match a comment, a string, a look-alike identifier, a test file, or a non-gateway file", () => {
    expect(
      checkPackLayerWriters([
        file(
          "packages/gateway/src/x.ts",
          '// setPackLayer(p)\n/* removePackLayer */\nconst m = "setPackLayer";\nconst setPackLayers = 1;',
        ),
        file("packages/gateway/src/y.test.ts", "store.setPackLayer(p, id, d, o);"),
        file("scripts/z.ts", "store.removePackLayer(p, id);"),
      ]),
    ).toEqual([]);
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(checkPackLayerWriters(files)).toEqual([]);
  });
});

describe("D39 — the model's connector-write door is the only builder of write tools (I53)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const DOOR = "packages/gateway/src/engine/connector-write-agent-tools.ts";
  const GOOD_DOOR = [
    'import { createTool } from "@mastra/core/tools";',
    'import { isModelOfferableRow } from "../connectors/connector-writes/model-offerable.ts";',
    'const t = createTool({ id: "x", execute: () => ex.execute({ type: "a", origin: "model" }) });',
  ].join("\n");
  const rules = (files: FileEntry[]): string[] => checkModelWriteDoor(files).map((v) => v.rule);

  test("allows the door, and agent.ts importing the door's builder next to its own tools", () => {
    expect(
      checkModelWriteDoor([
        file(DOOR, GOOD_DOOR),
        file(
          "packages/gateway/src/engine/agent.ts",
          'import { createTool } from "@mastra/core/tools";\nimport { buildConnectorWriteAgentTools } from "./connector-write-agent-tools.ts";\nconst a = createTool({});\nconst e = getAgentRequestConnectorWriteExecutor();',
        ),
      ]),
    ).toEqual([]);
  });

  test("(a) FAILS on another file that value-imports the write table and calls createTool", () => {
    const v = checkModelWriteDoor([
      file(
        "packages/gateway/src/engine/other-tools.ts",
        'import { createTool } from "@mastra/core/tools";\nimport { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";\nconst t = createTool({});',
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("connector-write-tools-built-outside-door");
  });

  test("(a) FAILS on the registry import and on an aliased createTool", () => {
    expect(
      rules([
        file(
          "packages/gateway/src/x.ts",
          'import { createTool as ct } from "@mastra/core/tools";\nimport { isConnectorWriteToolId } from "./connectors/connector-write-registry.ts";\nconst t = ct({});',
        ),
      ]),
    ).toEqual(["connector-write-tools-built-outside-door"]);
  });

  test("(a) FAILS on a namespace import's createTool and on a dynamic import of the rows", () => {
    expect(
      rules([
        file(
          "packages/gateway/src/x.ts",
          'import * as tools from "@mastra/core/tools";\nimport { rows } from "./connectors/connector-writes/rows.ts";\ntools.createTool({});',
        ),
      ]),
    ).toEqual(["connector-write-tools-built-outside-door"]);
    expect(
      rules([
        file(
          "packages/gateway/src/y.ts",
          'import { createTool } from "@mastra/core/tools";\nconst m = await import("./connectors/connector-writes/rows.ts");\ncreateTool({});',
        ),
      ]),
    ).toEqual(["connector-write-tools-built-outside-door"]);
  });

  test("(a) does NOT trip on a type-only import, an all-type braces import, or no createTool call", () => {
    expect(
      rules([
        file(
          "packages/gateway/src/a.ts",
          'import { createTool } from "@mastra/core/tools";\nimport type { ConnectorWriteRow } from "./connectors/connector-writes/types.ts";\ncreateTool({});',
        ),
        file(
          "packages/gateway/src/b.ts",
          'import { createTool } from "@mastra/core/tools";\nimport { type ConnectorWriteRow } from "./connectors/connector-writes/types.ts";\ncreateTool({});',
        ),
        file(
          "packages/gateway/src/c.ts",
          'import { CONNECTOR_WRITE_ROWS } from "./connectors/connector-writes/index.ts";\nconst n = CONNECTOR_WRITE_ROWS.length;',
        ),
        file(
          "packages/gateway/src/d.ts",
          '// import { x } from "./connectors/connector-writes/rows.ts"\nimport { createTool } from "@mastra/core/tools";\ncreateTool({});',
        ),
      ]),
    ).toEqual([]);
  });

  test("(a) resolves relative specifiers: both layouts evade a raw-string test, neither evades this", () => {
    const TOOLS = 'import { createTool } from "@mastra/core/tools";\n';
    expect(
      rules([
        file(
          "packages/gateway/src/connectors/foo.ts",
          `${TOOLS}import { CONNECTOR_WRITE_ROWS } from "./connector-writes/index.ts";\ncreateTool({});`,
        ),
      ]),
    ).toEqual(["connector-write-tools-built-outside-door"]);
    expect(
      rules([
        file(
          "packages/gateway/src/connectors/connector-writes/rogue.ts",
          `${TOOLS}import { CONNECTOR_WRITE_ROWS } from "./index.ts";\ncreateTool({});`,
        ),
      ]),
    ).toEqual(["connector-write-tools-built-outside-door"]);
    expect(
      rules([
        file(
          "packages/gateway/src/connectors/foo.ts",
          `${TOOLS}import { isConnectorWriteToolId } from "./connector-write-registry.ts";\ncreateTool({});`,
        ),
      ]),
    ).toEqual(["connector-write-tools-built-outside-door"]);
  });

  test("(a) a relative import that is NOT the table, or a table file that never calls createTool, stays clean", () => {
    expect(
      rules([
        file(
          "packages/gateway/src/connectors/foo.ts",
          'import { createTool } from "@mastra/core/tools";\nimport { x } from "./other.ts";\ncreateTool({});',
        ),
        file(
          "packages/gateway/src/connectors/connector-writes/enable.ts",
          'import { CONNECTOR_WRITE_ROWS } from "./index.ts";\nconst n = CONNECTOR_WRITE_ROWS.length;',
        ),
      ]),
    ).toEqual([]);
  });

  test("(b) FAILS when getAgentRequestConnectorWriteExecutor is named elsewhere", () => {
    const v = checkModelWriteDoor([
      file(
        "packages/gateway/src/engine/executor-helpers.ts",
        "const ex = getAgentRequestConnectorWriteExecutor();",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("connector-write-executor-read-confined");
  });

  test("(b) allows the four named files and ignores comments, strings and tests", () => {
    const body = "const ex = getAgentRequestConnectorWriteExecutor();";
    expect(
      checkModelWriteDoor([
        file("packages/gateway/src/engine/agent-request-context.ts", body),
        file("packages/gateway/src/engine/run-ask.ts", body),
        file("packages/gateway/src/engine/agent.ts", body),
        file(DOOR, `${GOOD_DOOR}\n${body}`),
        file(
          "packages/gateway/src/z.ts",
          `// ${body}\nconst s = "getAgentRequestConnectorWriteExecutor";`,
        ),
        file("packages/gateway/src/z.test.ts", body),
        file("scripts/z.ts", body),
      ]),
    ).toEqual([]);
  });

  test("(c) FAILS when the door names a transport", () => {
    for (const bad of [
      "invokeConnectorWrite(a);",
      "withConnectorSession(s);",
      "createConnectorDispatcher(d);",
      "createConnectorWriteDispatcher(i, d);",
      "const { dispatch } = connectors;\ndispatch(a);",
      "await connectors.dispatch(a);",
    ]) {
      expect(rules([file(DOOR, `${GOOD_DOOR}\n${bad}`)])).toEqual([
        "connector-write-door-names-transport",
      ]);
    }
  });

  test("(b) FAILS on a READ and on a WRITE of the request-context field outside its two files", () => {
    for (const body of [
      "const ex = agentRequestContext.getStore()?.connectorWriteExecutor;",
      "agentRequestContext.run({ connectorWriteExecutor: x }, () => 1);",
      "store.connectorWriteExecutor = x;",
    ]) {
      expect(rules([file("packages/gateway/src/engine/rogue.ts", body)])).toEqual([
        "connector-write-context-field-confined",
      ]);
    }
  });

  test("(b) allows the field in agent-request-context.ts and run-ask.ts", () => {
    const body = "store.connectorWriteExecutor = x;";
    expect(
      checkModelWriteDoor([
        file("packages/gateway/src/engine/agent-request-context.ts", body),
        file("packages/gateway/src/engine/run-ask.ts", body),
      ]),
    ).toEqual([]);
  });

  test("(e) FAILS on a rogue caller of either builder; allows the named files", () => {
    expect(
      rules([
        file(
          "packages/gateway/src/ipc/rogue.ts",
          "await buildConnectorWriteAgentTools(s, e, w, t);",
        ),
      ]),
    ).toEqual(["connector-write-builders-confined"]);
    expect(
      rules([file("packages/gateway/src/ipc/rogue.ts", "const ex = buildModelWriteExecutor(p);")]),
    ).toEqual(["connector-write-builders-confined"]);
    expect(
      rules([
        file(
          "packages/gateway/src/engine/agent.ts",
          "await buildConnectorWriteAgentTools(s, e, w, t);",
        ),
        file("packages/gateway/src/engine/run-ask.ts", "const ex = buildModelWriteExecutor(p);"),
      ]),
    ).toEqual([]);
  });

  test("(e) FAILS on a rogue buildWorkflowWriteExecutor; allows run-ask.ts and gateway-main.ts (SA2)", () => {
    expect(
      rules([
        file("packages/gateway/src/ipc/rogue.ts", "const ex = buildWorkflowWriteExecutor(p);"),
      ]),
    ).toEqual(["connector-write-builders-confined"]);
    expect(
      rules([
        file("packages/gateway/src/engine/run-ask.ts", "const ex = buildWorkflowWriteExecutor(p);"),
        file("packages/gateway/src/gateway-main.ts", "const ex = buildWorkflowWriteExecutor(p);"),
      ]),
    ).toEqual([]);
  });

  test("(e) FAILS on a rogue buildUnattendedWorkflowWriteExecutor; allows run-ask.ts and gateway-main.ts (SA4)", () => {
    for (const rogue of [
      "packages/gateway/src/ipc/rogue.ts",
      "packages/gateway/src/automation/workflow-scheduler.ts",
    ]) {
      expect(
        rules([file(rogue, "const ex = buildUnattendedWorkflowWriteExecutor(p);")]),
        rogue,
      ).toEqual(["connector-write-builders-confined"]);
    }
    expect(
      rules([
        file(
          "packages/gateway/src/engine/run-ask.ts",
          "export function buildUnattendedWorkflowWriteExecutor(p) { return 1; }",
        ),
        file(
          "packages/gateway/src/gateway-main.ts",
          "const ex = buildUnattendedWorkflowWriteExecutor(p);",
        ),
      ]),
    ).toEqual([]);
  });

  test("(c) does not apply to other files", () => {
    expect(
      rules([file("packages/gateway/src/engine/executor.ts", "connectors.dispatch(a);")]),
    ).toEqual([]);
  });

  test("(d) FAILS when the door lacks origin: model, including when only a comment or string has it", () => {
    const noOrigin = 'import { createTool } from "@mastra/core/tools";\ncreateTool({});';
    expect(rules([file(DOOR, noOrigin)])).toEqual(["connector-write-door-origin-model"]);
    expect(rules([file(DOOR, `${noOrigin}\n// origin: "model"`)])).toEqual([
      "connector-write-door-origin-model",
    ]);
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(files.some((f) => f.relPath === DOOR)).toBe(true);
    expect(checkModelWriteDoor(files)).toEqual([]);
  });
});

describe("D40 — a before-state read stays a guarded read on the door's executor (I53, spec § 5.4)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const BEFORE = "packages/gateway/src/engine/before-state.ts";
  const RUN_ASK = "packages/gateway/src/engine/run-ask.ts";
  const EXECUTOR = "packages/gateway/src/engine/executor.ts";
  const REGISTRY = "packages/gateway/src/connectors/registry.ts";
  const GOOD = [
    file(
      BEFORE,
      'const S = ".before.read";\nexport function createBeforeStateRunner() {}\nexport function isBeforeReadActionType() {}',
    ),
    file(
      RUN_ASK,
      'import {\n  type BeforeStateRunner,\n  createBeforeStateRunner,\n} from "./before-state.ts";\nfunction buildAskExecutor(p) {\n  return newTurnExecutor(p, p.delegation);\n}\nexport function buildModelWriteExecutor(p) {\n  return newTurnExecutor(p, undefined, createBeforeStateRunner());\n}\n',
    ),
    file(EXECUTOR, "if (isBeforeReadActionType(action.type)) {}"),
    file(REGISTRY, "if (!isBeforeReadActionType(t)) return; // .before.read guard"),
  ];
  const rules = (files: FileEntry[]): string[] => checkBeforeStateRead(files).map((v) => v.rule);
  const replace = (relPath: string, contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === relPath ? file(relPath, contents) : f));

  test("the control: the allowed shape is clean", () => {
    expect(checkBeforeStateRead(GOOD)).toEqual([]);
  });

  test("(a) FAILS on the literal anywhere else, in a string or a template", () => {
    const other = "packages/gateway/src/engine/other.ts";
    expect(rules([...GOOD, file(other, 'const t = "jira.before.read";')])).toEqual([
      "before-read-literal-confined",
    ]);
    expect(
      rules([...GOOD, file(other, ["const t = `", "$", "{s}.before.read`;"].join(""))]),
    ).toEqual(["before-read-literal-confined"]);
    // Comments and test files are not scanned.
    expect(rules([...GOOD, file(other, "// a .before.read type")])).toEqual([]);
    expect(
      rules([...GOOD, file("packages/gateway/src/engine/x.test.ts", '"a.before.read"')]),
    ).toEqual([]);
  });

  test("(b) FAILS on the runner built outside run-ask.ts's door builder", () => {
    expect(
      rules([
        ...GOOD,
        file("packages/gateway/src/ipc/x.ts", "const r = createBeforeStateRunner();"),
      ]),
    ).toEqual(["before-state-runner-confined"]);
    // Inside run-ask.ts but in the ASK executor's builder.
    expect(
      rules(
        replace(
          RUN_ASK,
          'import { createBeforeStateRunner } from "./before-state.ts";\nfunction buildAskExecutor(p) {\n  return newTurnExecutor(p, p.delegation, createBeforeStateRunner());\n}\nexport function buildModelWriteExecutor(p) {\n  return newTurnExecutor(p, undefined, createBeforeStateRunner());\n}\n',
        ),
      ),
    ).toEqual(["before-state-runner-confined"]);
  });

  test("(b) allows the runner inside newWorkflowWriteExecutor too (SA2/SA4), and nowhere else in run-ask.ts", () => {
    const carriers =
      'import { createBeforeStateRunner } from "./before-state.ts";\nfunction buildAskExecutor(p) {\n  return newTurnExecutor(p, p.delegation);\n}\nexport function buildModelWriteExecutor(p) {\n  return newTurnExecutor(p, undefined, createBeforeStateRunner());\n}\nfunction newWorkflowWriteExecutor(p) {\n  return newTurnExecutor(p, undefined, createBeforeStateRunner());\n}\n';
    expect(rules(replace(RUN_ASK, carriers))).toEqual([]);
    // A third function in run-ask.ts that builds a runner is still refused.
    expect(
      rules(
        replace(
          RUN_ASK,
          `${carriers}export function buildSomethingElse(p) {\n  return newTurnExecutor(p, undefined, createBeforeStateRunner());\n}\n`,
        ),
      ),
    ).toEqual(["before-state-runner-confined"]);
  });

  test("(b) FAILS on an `as` alias of the runner import, even in run-ask.ts", () => {
    expect(
      rules(
        replace(
          RUN_ASK,
          'import { createBeforeStateRunner as mk } from "./before-state.ts";\nfunction buildAskExecutor(p) {\n  return newTurnExecutor(p, p.delegation, mk());\n}\nexport function buildModelWriteExecutor(p) {\n  return newTurnExecutor(p, undefined, mk());\n}\n',
        ),
      ),
    ).toEqual(["before-state-runner-confined"]);
  });

  test("(c) FAILS when the gate refusal or the dispatch guard stops calling the predicate", () => {
    expect(rules(replace(EXECUTOR, "if (requiresHITL) {}"))).toEqual(["before-read-guard-present"]);
    // A leftover import names the predicate but calls nothing.
    expect(
      rules(
        replace(
          EXECUTOR,
          'import { isBeforeReadActionType } from "./before-state.ts";\nif (requiresHITL) {}\n',
        ),
      ),
    ).toEqual(["before-read-guard-present"]);
    expect(rules(replace(REGISTRY, "// no guard here"))).toEqual(["before-read-guard-present"]);
    expect(rules(GOOD.filter((f) => f.relPath !== REGISTRY))).toEqual([
      "before-read-guard-present",
    ]);
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(files.some((f) => f.relPath === BEFORE)).toBe(true);
    expect(checkBeforeStateRead(files)).toEqual([]);
  });
});

describe("D41 — a Wave 4 write is approved only by typed text, judged only at the gate (I53, I20)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const EXECUTOR = "packages/gateway/src/engine/executor.ts";
  const TYPES = "packages/gateway/src/engine/types.ts";
  const WRAPPER = "packages/gateway/src/ipc/capture-rpc.ts";
  const CONSENT = "packages/gateway/src/ipc/consent.ts";
  const CONFIRM = "packages/gateway/src/connectors/connector-writes/confirm.ts";
  const OTHER = "packages/gateway/src/ipc/other.ts";
  const EXECUTOR_GOOD = [
    "class ToolExecutor {",
    "  private async resolveHitlApproval(action, opts, record) {",
    "    const preview = await this.captureBeforePhase(action, opts);",
    "    const confirm = this.renderConfirmPhase(action);",
    "    return this.approvalPhase(action, preview, confirm, record);",
    "  }",
    "  private renderConfirmPhase(action) {",
    "    const wave4 = rows.find((r) => r.wave === 4);",
    "    return renderConfirmText(wave4, input);",
    "  }",
    "  private async approvalPhase(action, preview, confirm, record) {",
    '    if (confirm.kind === "none") {',
    "      return this.consent.requestApproval(prompt, details, action.type);",
    "    }",
    "    return this.confirmedOwnerPrompt(req, record);",
    "  }",
    "  private async confirmedOwnerPrompt(req, record) {",
    "    const channel = this.consent;",
    "    const answer = await channel.requestConfirmedApproval(req);",
    "    return answer.typed === req.confirmText;",
    "  }",
    "}",
    "export function bindConsentChannel(c) {",
    "  return { requestConfirmedApproval(req) { return c.requestConfirmedConsent(req); } };",
    "}",
    "",
  ].join("\n");
  const GOOD = [
    file(EXECUTOR, EXECUTOR_GOOD),
    file(TYPES, "interface ConsentChannel { requestConfirmedApproval?(req): Promise<R>; }"),
    file(
      WRAPPER,
      "export function provenanceConsent(inner) {\n  const confirmed = inner.requestConfirmedApproval?.bind(inner);\n  return { requestConfirmedApproval: (req) => confirmed(req) };\n}\nfunction other() {}\n",
    ),
    file(
      CONSENT,
      "class C {\n  requestConfirmedConsent() {}\n  open(confirmText) {\n    return confirmText === undefined ? {} : { confirmText };\n  }\n}\n",
    ),
    file(CONFIRM, "export function renderConfirmText() {}"),
  ];
  const rules = (files: FileEntry[]): string[] => checkConfirmComparison(files).map((v) => v.rule);
  const replace = (relPath: string, contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === relPath ? file(relPath, contents) : f));

  test("the control: the allowed shape is clean", () => {
    expect(checkConfirmComparison(GOOD)).toEqual([]);
  });

  test("(a) FAILS on the channel method named anywhere else", () => {
    expect(
      rules([
        ...GOOD,
        file(OTHER, "async function f(c) { return c.requestConfirmedApproval(r); }"),
      ]),
    ).toEqual(["confirm-channel-confined"]);
    // Inside the wrapper's file but outside provenanceConsent.
    expect(
      rules(
        replace(
          WRAPPER,
          "export function provenanceConsent(inner) {\n  return inner;\n}\nfunction other(i) {\n  return i.requestConfirmedApproval(r);\n}\n",
        ),
      ),
    ).toEqual(["confirm-channel-confined"]);
    // Comments and test files are not scanned.
    expect(rules([...GOOD, file(OTHER, "// requestConfirmedApproval(x)")])).toEqual([]);
    expect(
      rules([...GOOD, file("packages/gateway/src/ipc/x.test.ts", "c.requestConfirmedApproval(r)")]),
    ).toEqual([]);
  });

  test("(a) FAILS on the coordinator's half named outside the executor and consent.ts", () => {
    expect(rules([...GOOD, file(OTHER, "c.requestConfirmedConsent(a, b);")])).toEqual([
      "confirm-coordinator-confined",
    ]);
    // A test-support helper is exempt (an inert stub); a production file of another name is not.
    expect(
      rules([
        ...GOOD,
        file(
          "packages/gateway/src/engine/run-ask.test-helpers.ts",
          "requestConfirmedConsent: async () => ({})",
        ),
      ]),
    ).toEqual([]);
  });

  test("(b) FAILS on renderConfirmText named anywhere but the executor and its definition", () => {
    expect(rules([...GOOD, file(OTHER, "const t = renderConfirmText(row, input);")])).toEqual([
      "confirm-render-confined",
    ]);
  });

  test("(c) FAILS on a typed or confirmText comparison outside the executor, either side", () => {
    for (const body of [
      "if (answer.typed === confirmText) return true;",
      "if (confirmText !== answer.typed) return false;",
      "return req.confirmText === typedValue;",
      "return x !== p.typed;",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["confirm-comparison-confined"]);
    }
    // A presence check against undefined or null is not a judgement of the text.
    expect(
      rules([
        ...GOOD,
        file(OTHER, "const a = confirmText === undefined; const b = null !== confirmText;"),
      ]),
    ).toEqual([]);
  });

  test("(d) FAILS when the phases are reordered or one is missing", () => {
    const swapped = EXECUTOR_GOOD.replace(
      "    const preview = await this.captureBeforePhase(action, opts);\n    const confirm = this.renderConfirmPhase(action);\n",
      "    const confirm = this.renderConfirmPhase(action);\n    const preview = await this.captureBeforePhase(action, opts);\n",
    );
    expect(rules(replace(EXECUTOR, swapped))).toEqual(["confirm-order-pinned"]);
    const missing = EXECUTOR_GOOD.replace(
      "    const confirm = this.renderConfirmPhase(action);\n",
      "    const confirm = { kind: 0 };\n",
    );
    expect(rules(replace(EXECUTOR, missing))).toEqual(["confirm-order-pinned"]);
  });

  test("(d) FAILS when the plain prompt is reachable outside approvalPhase's none guard", () => {
    const unguarded = EXECUTOR_GOOD.replace(
      '    if (confirm.kind === "none") {\n      return this.consent.requestApproval(prompt, details, action.type);\n    }\n',
      "    return this.consent.requestApproval(prompt, details, action.type);\n",
    );
    expect(rules(replace(EXECUTOR, unguarded))).toEqual(["confirm-order-pinned"]);
    // A swapped branch: the plain prompt sits in a guard on another kind, or after the block.
    const swapped = EXECUTOR_GOOD.replace(
      'if (confirm.kind === "none") {',
      'if (confirm.kind === "text") {',
    );
    expect(rules(replace(EXECUTOR, swapped))).toEqual(["confirm-order-pinned"]);
    const after = EXECUTOR_GOOD.replace(
      '    if (confirm.kind === "none") {\n      return this.consent.requestApproval(prompt, details, action.type);\n    }\n',
      '    if (confirm.kind === "none") {\n      log(prompt);\n    }\n    return this.consent.requestApproval(prompt, details, action.type);\n',
    );
    expect(rules(replace(EXECUTOR, after))).toEqual(["confirm-order-pinned"]);
    const second = EXECUTOR_GOOD.replace(
      "  private async confirmedOwnerPrompt(req, record) {\n",
      "  private async confirmedOwnerPrompt(req, record) {\n    await this.consent.requestApproval(req);\n",
    );
    expect(rules(replace(EXECUTOR, second))).toEqual(["confirm-order-pinned"]);
  });

  test("(c2) FAILS on a second typed call through any receiver, optional-call forms included", () => {
    const anchor = "  private async confirmedOwnerPrompt(req, record) {\n";
    for (const extra of [
      "await this.consent.requestConfirmedApproval(req);",
      "await this.consent.requestConfirmedApproval?.(req);",
      "await this.consent\n      .requestConfirmedApproval (req);",
    ]) {
      const twice = EXECUTOR_GOOD.replace(anchor, `${anchor}    ${extra}\n`);
      expect(rules(replace(EXECUTOR, twice)), extra).toEqual(["confirm-order-pinned"]);
    }
  });

  test("(c3) FAILS on a second plain requestApproval call through any receiver", () => {
    const phase = "  private async approvalPhase(action, preview, confirm, record) {\n";
    for (const extra of [
      "const channel = this.consent; await channel.requestApproval(prompt);",
      "await this.consent.requestApproval?.(prompt);",
      "await other\n      .requestApproval (prompt);",
    ]) {
      const twice = EXECUTOR_GOOD.replace(phase, `${phase}    ${extra}\n`);
      expect(rules(replace(EXECUTOR, twice)), extra).toEqual(["confirm-order-pinned"]);
    }
  });

  test("(d) FAILS when the typed call moves out of confirmedOwnerPrompt, or Wave 4 is not read from the row", () => {
    const moved = EXECUTOR_GOOD.replace(
      "  private async approvalPhase(action, preview, confirm, record) {\n",
      "  private async approvalPhase(action, preview, confirm, record) {\n    await channel.requestConfirmedApproval(req);\n",
    );
    expect(rules(replace(EXECUTOR, moved))).toEqual(["confirm-order-pinned"]);
    const noWave = EXECUTOR_GOOD.replace("r.wave === 4", "r.confirm");
    expect(rules(replace(EXECUTOR, noWave))).toEqual(["confirm-order-pinned"]);
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(files.some((f) => f.relPath === EXECUTOR)).toBe(true);
    expect(checkConfirmComparison(files)).toEqual([]);
  });
});

describe("D42 — a bound write is dispatched only with its own prepare step's values (I54)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const EXECUTOR = "packages/gateway/src/engine/executor.ts";
  const STEP = "packages/gateway/src/engine/prepare-step.ts";
  const REGISTRY = "packages/gateway/src/connectors/registry.ts";
  const TOOLS = "packages/gateway/src/connectors/connector-writes/prepare-tools.ts";
  const TYPES = "packages/gateway/src/connectors/connector-writes/types.ts";
  const OTHER = "packages/gateway/src/ipc/other.ts";
  const DIFF = "packages/gateway/src/connectors/connector-writes/diff.ts";
  const WRITE_REGISTRY = "packages/gateway/src/connectors/connector-write-registry.ts";
  const EXECUTOR_GOOD = [
    "function withPrepared(preview, prepared) {",
    "  return { ...preview, prepared: { status: 'ok' }, ...(prepared.diff === undefined ? {} : { diff: prepared.diff }) };",
    "}",
    "class ToolExecutor {",
    "  constructor(a, b, c, d, e, f, g, h, private readonly writeTable) {}",
    "  private boundRefusal(action, requiresHITL, scope) {",
    "    if (!scope.bind) return 1;",
    "    return boundInputRefusal(row.bound, action);",
    "  }",
    "  private async resolveHitlApproval(action, opts, record, scope) {",
    "    const captured = await this.captureBeforePhase(action, opts);",
    "    if (!(await this.preflightPhase(action, record, scope))) return false;",
    "    const prepared = await this.preparePhase(action, opts, scope);",
    "    const confirm = this.renderConfirmPhase(action);",
    "    return this.approvalPhase(action, preview, confirm, record);",
    "  }",
    "  private async preparePhase(action, opts, scope) {",
    "    const gate = (a) => this.gateWithin(a, undefined, { bind: false, prepareStep: true });",
    "    return runPrepareStep(ops, row, row.bound, action, { prepareToolIds: this.prepareToolIds() });",
    "  }",
    "  private async runGateChecks(action, opts, scope) {",
    "    if (isPrepareActionType(action.type) && scope.prepareStep !== true) return 1;",
    "    return this.resolveHitlApproval(action, opts, record, scope);",
    "  }",
    "  private dispatchBoundPhase(action, scope) {",
    "    return injectBoundFields(action, binds, values);",
    "  }",
    "  async gate(action, opts) {",
    "    return this.gateWithin(action, opts, { bind: false });",
    "  }",
    "  async execute(action, opts) {",
    "    const scope = { bind: true };",
    "    const gateResult = await this.gateWithin(action, opts, scope);",
    "    const toDispatch = this.dispatchBoundPhase(action, scope);",
    "    return this.connectors.dispatch(toDispatch);",
    "  }",
    "}",
    "",
  ].join("\n");
  const TOOLS_GOOD =
    "export const PREPARE_TOOL_IDS = Object.freeze({\n  add(_id: string): never { throw 1; },\n  delete(_id: string): never { throw 1; },\n  clear(): never { throw 1; },\n});\nexport function isPrepareToolId() {}\n";
  const REGISTRY_GOOD =
    "import { isPrepareActionType } from './x'; import { isPrepareToolId, PREPARE_TOOL_IDS } from './y'; function f(prepareToolIds) { return prepareToolIds; }";
  const GOOD = [
    file(EXECUTOR, EXECUTOR_GOOD),
    file(
      STEP,
      'const S = ".write.prepare"; export function runPrepareStep() {} export function injectBoundFields() {} export function isPrepareActionType() {} const d = renderUnifiedDiff(files);',
    ),
    file(DIFF, "export function renderUnifiedDiff() {}"),
    file(
      WRITE_REGISTRY,
      "import { isPrepareToolId } from './p'; export const f = (id) => isPrepareToolId(id);",
    ),
    file(REGISTRY, REGISTRY_GOOD),
    file(TOOLS, TOOLS_GOOD),
    file(
      TYPES,
      "import { PREPARE_TOOL_IDS } from './p'; export function withBound(r, b, prepareToolIds = PREPARE_TOOL_IDS) {}",
    ),
  ];
  const rules = (files: FileEntry[]): string[] => checkBoundWrites(files).map((v) => v.rule);
  const replace = (relPath: string, contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === relPath ? file(relPath, contents) : f));

  test("the control: the allowed shape is clean", () => {
    expect(checkBoundWrites(GOOD)).toEqual([]);
  });

  test("(a) FAILS on the .write.prepare literal outside the prepare step", () => {
    expect(rules([...GOOD, file(OTHER, 'const t = "iac.write.prepare";')])).toEqual([
      "bound-prepare-literal-confined",
    ]);
    expect(rules([...GOOD, file(OTHER, "// the .write.prepare type")])).toEqual([]);
    expect(
      rules([...GOOD, file("packages/gateway/src/ipc/x.test.ts", 'x(".write.prepare")')]),
    ).toEqual([]);
  });

  test("(a) FAILS on a bound-write name outside its files", () => {
    for (const body of [
      "injectBoundFields(a, b, c);",
      "await runPrepareStep(o, r, b, a, p);",
      "isPrepareActionType(t);",
      "isPrepareToolId(k);",
      "PREPARE_TOOL_IDS.has(k);",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["bound-name-confined"]);
    }
    // The registry may name the action-type guard but not the injection.
    expect(rules(replace(REGISTRY, `${REGISTRY_GOOD} injectBoundFields();`))).toEqual([
      "bound-name-confined",
    ]);
  });

  test("(a) isPrepareToolId is allowed in connector-write-registry.ts, and ONLY in it (D1c)", () => {
    expect(checkBoundWrites(GOOD)).toEqual([]);
    // The federation predicate file may name it; any other file still may not.
    const otherFile = "packages/gateway/src/connectors/connector-write-transport.ts";
    expect(rules([...GOOD, file(otherFile, "isPrepareToolId(k);")])).toEqual([
      "bound-name-confined",
    ]);
    expect(
      rules([...GOOD, file("packages/gateway/src/ipc/federation-rpc.ts", "isPrepareToolId(k);")]),
    ).toEqual(["bound-name-confined"]);
    // ...and the registry file may not name the OTHER bound-write names.
    expect(
      rules(replace(WRITE_REGISTRY, "import { isPrepareToolId } from './p'; injectBoundFields();")),
    ).toEqual(["bound-name-confined"]);
    expect(
      rules(
        replace(WRITE_REGISTRY, "import { isPrepareToolId } from './p'; PREPARE_TOOL_IDS.has(k);"),
      ),
    ).toEqual(["bound-name-confined"]);
  });

  test("(g) renderUnifiedDiff is allowed only in the prepare step and diff.ts (D1c)", () => {
    expect(rules([...GOOD, file(OTHER, "const d = renderUnifiedDiff(files);")])).toEqual([
      "bound-name-confined",
    ]);
    expect(rules([...GOOD, file(`${EXECUTOR}.x.ts`, "renderUnifiedDiff(files);")])).toEqual([
      "bound-name-confined",
    ]);
    expect(
      rules(
        replace(
          EXECUTOR,
          `${EXECUTOR_GOOD}
const d = renderUnifiedDiff(files);
`,
        ),
      ),
    ).toEqual(["bound-name-confined"]);
    expect(
      rules(replace(WRITE_REGISTRY, "import { isPrepareToolId } from './p'; renderUnifiedDiff();")),
    ).toEqual(["bound-name-confined"]);
    // Tests are exempt.
    expect(
      rules([...GOOD, file("packages/gateway/src/ipc/x.test.ts", "renderUnifiedDiff(f);")]),
    ).toEqual([]);
  });

  test("(g) FAILS when withPrepared stops carrying only prepared.diff", () => {
    const own = EXECUTOR_GOOD.replace("diff: prepared.diff", "diff: makeMyOwnDiff()");
    expect(rules(replace(EXECUTOR, own))).toEqual(["bound-order-pinned"]);
    const start = EXECUTOR_GOOD.indexOf("function withPrepared");
    const end = EXECUTOR_GOOD.indexOf("\n}\n", start) + 3;
    const gone = EXECUTOR_GOOD.slice(0, start) + EXECUTOR_GOOD.slice(end);
    expect(rules(replace(EXECUTOR, gone))).toEqual(["bound-order-pinned"]);
  });

  test("(b) FAILS when the prepare phase is missing, moved after the confirm text, or reordered", () => {
    const missing = EXECUTOR_GOOD.replace(
      "    const prepared = await this.preparePhase(action, opts, scope);\n",
      "",
    );
    expect(rules(replace(EXECUTOR, missing))).toContain("bound-order-pinned");
    const after = EXECUTOR_GOOD.replace(
      "    const prepared = await this.preparePhase(action, opts, scope);\n    const confirm = this.renderConfirmPhase(action);\n",
      "    const confirm = this.renderConfirmPhase(action);\n    const prepared = await this.preparePhase(action, opts, scope);\n",
    );
    expect(rules(replace(EXECUTOR, after))).toContain("bound-order-pinned");
  });

  test("(b) FAILS when the preflight phase is missing or runs after the prepare phase (D2)", () => {
    const pre = "    if (!(await this.preflightPhase(action, record, scope))) return false;\n";
    const prep = "    const prepared = await this.preparePhase(action, opts, scope);\n";
    const confirm = "    const confirm = this.renderConfirmPhase(action);\n";
    expect(rules(replace(EXECUTOR, EXECUTOR_GOOD))).toEqual([]);
    const missing = EXECUTOR_GOOD.replace(pre, "");
    expect(missing).not.toBe(EXECUTOR_GOOD);
    expect(rules(replace(EXECUTOR, missing))).toContain("bound-order-pinned");
    const late = EXECUTOR_GOOD.replace(pre + prep, prep + pre);
    expect(late).not.toBe(EXECUTOR_GOOD);
    expect(rules(replace(EXECUTOR, late))).toContain("bound-order-pinned");
    // After the confirm text is no better.
    const afterConfirm = EXECUTOR_GOOD.replace(pre + prep + confirm, prep + confirm + pre);
    expect(afterConfirm).not.toBe(EXECUTOR_GOOD);
    expect(rules(replace(EXECUTOR, afterConfirm))).toContain("bound-order-pinned");
  });

  test("(b) FAILS on a second or misplaced injection or prepare call, and on a reordered execute", () => {
    const extraInject = EXECUTOR_GOOD.replace(
      "    const confirm = this.renderConfirmPhase(action);\n",
      "    const confirm = this.renderConfirmPhase(action);\n    injectBoundFields(action, b, v);\n",
    );
    expect(rules(replace(EXECUTOR, extraInject))).toContain("bound-order-pinned");
    const extraPrepare = EXECUTOR_GOOD.replace(
      "  private dispatchBoundPhase(action, scope) {\n",
      "  private dispatchBoundPhase(action, scope) {\n    runPrepareStep();\n",
    );
    expect(rules(replace(EXECUTOR, extraPrepare))).toContain("bound-order-pinned");
    const swapped = EXECUTOR_GOOD.replace(
      "    const toDispatch = this.dispatchBoundPhase(action, scope);\n    return this.connectors.dispatch(toDispatch);\n",
      "    this.connectors.dispatch(action);\n    const toDispatch = this.dispatchBoundPhase(action, scope);\n",
    );
    expect(rules(replace(EXECUTOR, swapped))).toContain("bound-order-pinned");
  });

  test("(c) FAILS when production passes the write table or the prepare-tool seam", () => {
    expect(
      rules([...GOOD, file(OTHER, "const e = new ToolExecutor(a, b, c, d, e, f, g, h, table);")]),
    ).toContain("bound-seam-not-production");
    expect(
      rules([...GOOD, file(OTHER, "const e = new ToolExecutor(a, b, c, d, e, f, g, h);")]),
    ).toEqual([]);
    expect(
      rules([
        ...GOOD,
        file(OTHER, "const e = new ToolExecutor(a, b, fn(1, 2, 3), d, e, f, g, [1, 2, 3, 4]);"),
      ]),
    ).toEqual([]);
    expect(
      rules([...GOOD, file(OTHER, "createConnectorDispatcher(client, { prepareToolIds: ids });")]),
    ).toContain("bound-seam-not-production");
    expect(rules([...GOOD, file(OTHER, "withBound(row, bound, ids);")])).toContain(
      "bound-seam-not-production",
    );
    expect(rules([...GOOD, file(OTHER, "withBound(row, bound);")])).toEqual([]);
    // A test-support file is exempt.
    expect(
      rules([
        ...GOOD,
        file("packages/gateway/src/engine/x.test-helpers.ts", "withBound(r, b, ids); writeTable;"),
      ]),
    ).toEqual([]);
  });

  test("(c) FAILS on the seam names in any other production file", () => {
    expect(
      rules([...GOOD, file(OTHER, "const writeTable = { rows: [], prepareToolIds: s };")]),
    ).toEqual(["bound-name-confined", "bound-name-confined"]);
  });

  test("(d) FAILS when PREPARE_TOOL_IDS is no longer frozen or is mutated", () => {
    const frozen = (contents: string): boolean =>
      rules(replace(TOOLS, contents)).includes("bound-prepare-set-frozen");
    expect(frozen(TOOLS_GOOD.replace("Object.freeze(", "Object.assign("))).toBe(true);
    expect(frozen(TOOLS_GOOD.replace("clear(): never", "clear(): void"))).toBe(true);
    expect(frozen(TOOLS_GOOD.replace("add(_id: string): never", "add(_id: string): void"))).toBe(
      true,
    );
    expect(
      frozen(TOOLS_GOOD.replace("delete(_id: string): never", "delete(_id: string): void")),
    ).toBe(true);
    expect(
      rules([...GOOD, file(OTHER, 'PREPARE_TOOL_IDS.add("x");')]).includes(
        "bound-prepare-set-frozen",
      ),
    ).toBe(true);
    expect(rules(replace(EXECUTOR, `${EXECUTOR_GOOD} PREPARE_TOOL_IDS.delete("x");`))).toContain(
      "bound-prepare-set-frozen",
    );
  });

  test("(f) FAILS when a caller's prepare type is no longer refused outside the step", () => {
    const noRefusal = EXECUTOR_GOOD.replace(
      "    if (isPrepareActionType(action.type) && scope.prepareStep !== true) return 1;\n",
      "",
    );
    expect(rules(replace(EXECUTOR, noRefusal))).toContain("bound-order-pinned");
    const late = EXECUTOR_GOOD.replace(
      "    if (isPrepareActionType(action.type) && scope.prepareStep !== true) return 1;\n    return this.resolveHitlApproval(action, opts, record, scope);\n",
      "    const r = this.resolveHitlApproval(action, opts, record, scope);\n    if (isPrepareActionType(action.type) && scope.prepareStep !== true) return 1;\n    return r;\n",
    );
    expect(rules(replace(EXECUTOR, late))).toContain("bound-order-pinned");
    const elsewhere = EXECUTOR_GOOD.replace(
      "  async gate(action, opts) {\n",
      "  async gate(action, opts) {\n    const s = { prepareStep: true };\n",
    );
    expect(rules(replace(EXECUTOR, elsewhere))).toContain("bound-order-pinned");
    const gone = EXECUTOR_GOOD.replace("{ bind: false, prepareStep: true }", "{ bind: false }");
    expect(rules(replace(EXECUTOR, gone))).toContain("bound-order-pinned");
  });

  test("a test-helpers file is exempt only while no production file imports it", () => {
    const helper = file(
      "packages/gateway/src/engine/fixtures.test-helpers.ts",
      "withBound(r, b, ids); writeTable;",
    );
    expect(rules([...GOOD, helper])).toEqual([]);
    expect(
      rules([
        ...GOOD,
        helper,
        file(OTHER, 'import { x } from "../engine/fixtures.test-helpers.ts";'),
      ]),
    ).toContain("bound-seam-not-production");
    // A test importing it keeps the exemption.
    expect(
      rules([
        ...GOOD,
        helper,
        file(
          "packages/gateway/src/ipc/y.test.ts",
          'import { x } from "../engine/fixtures.test-helpers.ts";',
        ),
      ]),
    ).toEqual([]);
  });

  test("(e) FAILS when the public gate could bind", () => {
    const publicBinds = EXECUTOR_GOOD.replace("{ bind: false }", "{ bind: true }");
    expect(rules(replace(EXECUTOR, publicBinds))).toContain("bound-public-gate-refuses");
    const noGuard = EXECUTOR_GOOD.replace("    if (!scope.bind) return 1;\n", "");
    expect(rules(replace(EXECUTOR, noGuard))).toContain("bound-public-gate-refuses");
    const late = EXECUTOR_GOOD.replace(
      "    if (!scope.bind) return 1;\n    return boundInputRefusal(row.bound, action);\n",
      "    const r = boundInputRefusal(row.bound, action);\n    if (!scope.bind) return 1;\n    return r;\n",
    );
    expect(rules(replace(EXECUTOR, late))).toContain("bound-public-gate-refuses");
    const twice = EXECUTOR_GOOD.replace(
      "    const scope = { bind: true };\n",
      "    const scope = { bind: true };\n    const other = { bind: true };\n",
    );
    expect(rules(replace(EXECUTOR, twice))).toContain("bound-public-gate-refuses");
  });

  test("is green on the repo", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles()) {
      files.push({ relPath: f.relPath, contents: f.contents });
    }
    expect(files.some((f) => f.relPath === EXECUTOR)).toBe(true);
    expect(checkBoundWrites(files)).toEqual([]);
  });
});

describe("D42(h) — the bound IaC capabilities are reached only from the preflight and prepare phases (I54)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const EXECUTOR = "packages/gateway/src/engine/executor.ts";
  const REGISTRY = "packages/gateway/src/connectors/registry.ts";
  const TYPES = "packages/gateway/src/engine/types.ts";
  const OTHER = "packages/gateway/src/ipc/other.ts";
  const EXECUTOR_GOOD = [
    "class ToolExecutor {",
    "  private async preflightPhase(action, record, scope) {",
    "    const capabilities = this.connectors.boundWriteCapabilities;",
    "    return capabilities.preflight(id, input);",
    "  }",
    "  private async preparePhase(action, opts, scope) {",
    "    const capabilities = this.connectors.boundWriteCapabilities;",
    "    return { settle: (id, ctx) => capabilities.settle(id, ctx) };",
    "  }",
    "  private other() {}",
    "}",
    "",
  ].join("\n");
  const GOOD = [
    file(EXECUTOR, EXECUTOR_GOOD),
    file(TYPES, "export interface ConnectorDispatcher { readonly boundWriteCapabilities?: X; }"),
    file(
      REGISTRY,
      "const caps: BoundWriteCapabilities = { a }; const d = { boundWriteCapabilities: caps };",
    ),
  ];
  const rules = (files: FileEntry[]): string[] => checkBoundCapabilities(files).map((v) => v.rule);
  const swap = (contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === EXECUTOR ? file(EXECUTOR, contents) : f));
  const otherBody = (body: string): string => EXECUTOR_GOOD.replace("private other() {}", body);

  test("the control: the allowed shape is clean", () => {
    expect(checkBoundCapabilities(GOOD)).toEqual([]);
  });

  test("(h1) FAILS on the member named, or a capability built, outside the registry", () => {
    expect(rules([...GOOD, file(OTHER, "d.boundWriteCapabilities;")])).toEqual([
      "bound-capability-confined",
    ]);
    for (const body of [
      "const c: BoundWriteCapabilities = { settle, preflight };",
      "function f(): BoundWriteCapabilities { return x; }",
      "class C implements BoundWriteCapabilities {}",
      "const c = {} as BoundWriteCapabilities;",
      "const c = {} satisfies BoundWriteCapabilities;",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["bound-capability-confined"]);
    }
    // A comment, a string and a test file are not code.
    expect(
      rules([
        ...GOOD,
        file(OTHER, '// boundWriteCapabilities\nconst s = "boundWriteCapabilities";'),
      ]),
    ).toEqual([]);
    expect(
      rules([...GOOD, file("packages/gateway/src/ipc/x.test.ts", "d.boundWriteCapabilities;")]),
    ).toEqual([]);
  });

  test("(h3) FAILS when a file other than the settler and the registry names the Kubernetes settler", () => {
    expect(
      rules([
        ...GOOD,
        file("packages/gateway/src/engine/k8s-settle.ts", "export function settleK8sManifest() {}"),
      ]),
    ).toEqual([]);
    expect(
      rules([
        ...GOOD.filter((f) => f.relPath !== REGISTRY),
        file(
          REGISTRY,
          "const caps: BoundWriteCapabilities = { settle: () => settleK8sManifest(x) };",
        ),
      ]),
    ).toEqual([]);
    expect(rules([...GOOD, file(OTHER, "settleK8sManifest({ input, reply });")])).toEqual([
      "bound-capability-confined",
    ]);
    expect(rules([...GOOD, file(OTHER, "// settleK8sManifest")])).toEqual([]);
  });

  test("(h2) FAILS when another method of the executor reads the member or calls a capability", () => {
    for (const body of [
      "private other() { return this.connectors.boundWriteCapabilities; }",
      "private other() { c.settle(1); }",
      "private other() { c.preflight(1); }",
    ]) {
      expect(rules(swap(otherBody(body))), body).toContain("bound-capability-calls");
    }
  });

  test("(h2) FAILS when the settle or the preflight left its phase", () => {
    expect(
      rules(swap(EXECUTOR_GOOD.replace("capabilities.settle(id, ctx)", "undefined"))),
    ).toContain("bound-capability-calls");
    expect(
      rules(swap(EXECUTOR_GOOD.replace("capabilities.preflight(id, input)", "true"))),
    ).toContain("bound-capability-calls");
  });
});

describe("D43 — the unused change set is discarded only by the executor's own step, never after a dispatch (I2 exception)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const EXECUTOR = "packages/gateway/src/engine/executor.ts";
  const LIMITS = "packages/gateway/src/connectors/connector-writes/iac-limits.ts";
  const REGISTRY = "packages/gateway/src/connectors/registry.ts";
  const OTHER = "packages/gateway/src/ipc/other.ts";
  const EXECUTOR_GOOD = [
    "class ToolExecutor {",
    "  private async runGateChecks(action, opts, scope, record, requiresHITL) {",
    "    if (requiresHITL && scope.discardStep !== undefined) {",
    "      if (!isDiscardOf(action, scope.discardStep)) return 1;",
    "      return 2;",
    "    } else if (requiresHITL) {",
    "      return this.resolveHitlApproval(action);",
    "    }",
    "  }",
    "  async execute(planned, opts) {",
    "    let dispatched: boolean | undefined;",
    "    try {",
    "      dispatched = true;",
    "      return await this.connectors.dispatch(x);",
    "    } finally {",
    "      await this.finishScope(action, scope, dispatched);",
    "    }",
    "  }",
    "  private async finishScope(action, scope, dispatched) {",
    "    if (!dispatched) await this.discardUnusedChangeSet(action, scope);",
    "  }",
    "  private async discardUnusedChangeSet(action, scope) {",
    "    await this.gateWithin(d, undefined, { bind: false, discardStep: target });",
    "  }",
    "}",
    "",
  ].join("\n");
  const GOOD = [
    file(EXECUTOR, EXECUTOR_GOOD),
    file(LIMITS, 'export const IAC_DISCARD = { toolId: "iac_cloudformation_changeset_discard" };'),
    file(REGISTRY, "import { IAC_DISCARD } from './x'; const k = IAC_DISCARD.toolId;"),
  ];
  const rules = (files: FileEntry[]): string[] => checkIacDiscard(files).map((v) => v.rule);
  const swap = (contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === EXECUTOR ? file(EXECUTOR, contents) : f));
  const before = (anchor: string, extra: string): string =>
    EXECUTOR_GOOD.replace(anchor, `${extra}\n${anchor}`);

  test("the control: the allowed shape is clean", () => {
    expect(checkIacDiscard(GOOD)).toEqual([]);
  });

  test("(a) FAILS when the discard scope is named outside the executor", () => {
    expect(rules([...GOOD, file(OTHER, "gate(a, undefined, { discardStep: t });")])).toEqual([
      "discard-step-confined",
    ]);
    expect(rules([...GOOD, file(OTHER, "// discardStep")])).toEqual([]);
  });

  test("(c) FAILS on the tool id, the action type or the constant named outside its files", () => {
    for (const body of [
      'const t = "iac_cloudformation_changeset_discard";',
      'const t = "iac.cloudformation.changeset.discard";',
      'const t = "iac_iac_cloudformation_changeset_discard";',
      "IAC_DISCARD.toolId;",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["discard-name-confined"]);
    }
    expect(rules([...GOOD, file(OTHER, "// iac_cloudformation_changeset_discard")])).toEqual([]);
  });

  test("(b) FAILS when the discard is reachable after a dispatch (dispatched set after it)", () => {
    const late = EXECUTOR_GOOD.replace(
      "      dispatched = true;\n      return await this.connectors.dispatch(x);",
      "      const r = await this.connectors.dispatch(x);\n      dispatched = true;\n      return r;",
    );
    expect(rules(swap(late))).toEqual(["discard-order-pinned"]);
  });

  test("(b) FAILS when the discard no longer depends on !dispatched, or is called a second time", () => {
    expect(rules(swap(EXECUTOR_GOOD.replace("if (!dispatched) await", "await")))).toEqual([
      "discard-order-pinned",
    ]);
    expect(
      rules(
        swap(
          before(
            "  private async finishScope",
            "  private async x() { await this.discardUnusedChangeSet(a, s); }",
          ),
        ),
      ),
    ).toEqual(["discard-order-pinned"]);
  });

  test("(b) FAILS when a second place writes the discard scope or the gate branch lost its guard", () => {
    expect(
      rules(
        swap(
          before(
            "  private async finishScope",
            "  private async y() { await this.gateWithin(d, u, { discardStep: t }); }",
          ),
        ),
      ),
    ).toEqual(["discard-order-pinned"]);
    expect(
      rules(swap(EXECUTOR_GOOD.replace("requiresHITL && scope.discardStep !== undefined", "true"))),
    ).toEqual(["discard-order-pinned"]);
    expect(
      rules(swap(EXECUTOR_GOOD.replace("isDiscardOf(action, scope.discardStep)", "true"))),
    ).toEqual(["discard-order-pinned"]);
  });

  test("(b) FAILS on every other way of writing the discard scope", () => {
    for (const body of [
      "  private async z1(discardStep) { await this.gateWithin(d, u, { bind: false, discardStep }); }",
      "  private async z2(s) { s.discardStep = t; }",
      "  private async z3(s) { Object.assign(s, { discardStep: t }); }",
      '  private async z4(s) { s["discardStep"] = t; }',
      '  private async z5() { await this.gateWithin(d, u, { "discardStep": t }); }',
    ]) {
      expect(rules(swap(before("  private async finishScope", body))), body).toContain(
        "discard-order-pinned",
      );
    }
  });

  test("(b) FAILS when dispatched is ever reset to false or set true a second time", () => {
    expect(
      rules(
        swap(
          EXECUTOR_GOOD.replace("    } finally {", "      dispatched = false;\n    } finally {"),
        ),
      ),
    ).toContain("discard-order-pinned");
    expect(
      rules(
        swap(EXECUTOR_GOOD.replace("    } finally {", "      dispatched = true;\n    } finally {")),
      ),
    ).toContain("discard-order-pinned");
  });

  test("(c) FAILS on IAC_DISCARD spelled as a string key, in either stripped form", () => {
    for (const body of [
      'const k = limits["IAC_DISCARD"];',
      "const k = limits[`IAC_DISCARD`];",
      "const k = IAC_DISCARD;",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["discard-name-confined"]);
    }
  });

  test("(d) FAILS when another file builds an iac spawn, the profile flag or the ENOSYS program", () => {
    const RUNNER = "packages/gateway/src/connectors/lazy-mesh/iac-runner.ts";
    expect(
      rules([
        ...GOOD,
        file(RUNNER, "wrapIacServerSpec(a, b, c); const i = 'com.nimbus.iac-plan';"),
      ]),
    ).toEqual([]);
    for (const body of [
      "wrapIacServerSpec(a, b, c);",
      "const p = { iacProfile: true };",
      "buildIacSeccompFilter();",
      "import { IAC_ENOSYS_SYSCALLS } from './x';",
      "const id = 'com.nimbus.iac-plan.abc';",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["iac-spawn-confined"]);
    }
    expect(rules([...GOOD, file(OTHER, "// wrapIacServerSpec iacProfile")])).toEqual([]);
  });

  test("(d) FAILS when a second file wraps a kubernetes spawn with the flag or names the kube routing table (D3a)", () => {
    const RUNNER = "packages/gateway/src/connectors/lazy-mesh/iac-runner.ts";
    expect(
      rules([
        ...GOOD,
        file(
          RUNNER,
          'wrapIacServerSpec(connectorSpawn("kubernetes"), m, c); const t = KUBE_TOOL_PROFILE; const i = "com.nimbus.iac-kube.x";',
        ),
      ]),
    ).toEqual([]);
    for (const body of [
      'const s = wrapIacServerSpec({ ...connectorSpawn("kubernetes"), env }, manifest, cwd);',
      "const t = KUBE_TOOL_PROFILE;",
      'const id = "com.nimbus.iac-kube.abc";',
      "const p = { iacProfile: true, id: 'kube' };",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toContain("iac-spawn-confined");
    }
    // The listing slot's own wrap (no flag) is not this rule's business.
    expect(
      rules([...GOOD, file(OTHER, 'const s = wrapServerSpec(connectorSpawn("kubernetes"), m);')]),
    ).toEqual([]);
  });
});

describe("D44 — a standing rule approves only inside approvalPhase, for an exactly matching owner-workflow action (I55)", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const SRC = "packages/gateway/src/";
  const EXECUTOR = `${SRC}engine/executor.ts`;
  const STEP = `${SRC}engine/standing-rule-step.ts`;
  const TYPES = `${SRC}engine/types.ts`;
  const WRITE_STEP = `${SRC}automation/workflow-write-step.ts`;
  const STORE = `${SRC}standing/standing-rule-store.ts`;
  const V88 = `${SRC}index/standing-rule-v88-sql.ts`;
  const RPC = `${SRC}ipc/standing-rpc.ts`;
  const RUN_ASK = `${SRC}engine/run-ask.ts`;
  const OTHER = `${SRC}ipc/other.ts`;
  const SCHEDULER = `${SRC}automation/workflow-scheduler.ts`;
  const LEARNING = `${SRC}standing/approval-learning.ts`;
  const SUGG_STORE = `${SRC}standing/standing-suggestion-store.ts`;
  const V90 = `${SRC}index/standing-suggestion-v90-sql.ts`;
  const RUNNER = `${SRC}automation/workflow-runner.ts`;
  const EXECUTOR_GOOD = [
    "class ToolExecutor {",
    "  private async resolveHitlApproval(action, opts, record, scope) {",
    "    const confirm = this.renderConfirmPhase(action);",
    "    return this.approvalPhase(action, preview, confirm, record);",
    "  }",
    "  private async approvalPhase(action, preview, confirm, record) {",
    "    const match = standingRuleStep(action, { deps: this.standingRules, rows: this.rows() });",
    "    if (match !== undefined) {",
    '      return { kind: "standing_approved", ruleId: match.ruleId, fireId: match.fireId };',
    "    }",
    "    if (this.unattended) {",
    "      record.rejectReason = UNATTENDED_NO_RULE_REASON;",
    '      return { kind: "rejected", reason: UNATTENDED_NO_RULE_REASON, answerSource: "none" };',
    "    }",
    "    const delegated = await this.tryDelegatedApproval(action, confirm, record);",
    "    return delegated;",
    "  }",
    "  constructor(extras) { this.unattended = extras.unattended === true; }",
    "}",
    'export const UNATTENDED_NO_RULE_REASON = "no rule";',
    "",
  ].join("\n");
  const RUN_ASK_GOOD = [
    "export function buildModelWriteExecutor(p) {",
    "  return newTurnExecutor(p, undefined, { beforeState: runner });",
    "}",
    "export function buildWorkflowWriteExecutor(p) {",
    "  return newWorkflowWriteExecutor(p, consentOf(p), false);",
    "}",
    "export function buildUnattendedWorkflowWriteExecutor(p) {",
    "  return newWorkflowWriteExecutor(p, NEVER, true);",
    "}",
    "function newWorkflowWriteExecutor(p, consent, unattended) {",
    "  return newExecutorOnChannel(p, consent, undefined, {",
    "    standingRules: createStandingRuleDeps(p),",
    "    unattended,",
    "  });",
    "}",
    "",
  ].join("\n");
  const GOOD: FileEntry[] = [
    file(EXECUTOR, EXECUTOR_GOOD),
    file(RUN_ASK, RUN_ASK_GOOD),
    file(
      STEP,
      'export function standingRuleStep(a, c) { if (a.provenance?.kind !== "owner_workflow") return; return claimFire(); }\n',
    ),
    file(
      WRITE_STEP,
      'const p = { kind: "owner_workflow" }; const q = WorkflowProvenance; const f = fieldSources; if (r.reason === UNATTENDED_NO_RULE_REASON) {}\n',
    ),
    file(SCHEDULER, 'const run = { trigger: "schedule", workflowName: n };\n'),
    file(
      TYPES,
      'export type X = { readonly kind: "owner_workflow"; fieldSources: 1 } | { kind: "standing_approved" };\n',
    ),
    file(
      STORE,
      'db.run("INSERT INTO standing_rule (id) VALUES (1)"); export function insertRule() {} export function claimFire() {} export function hasLiveRuleFor() {}\n',
    ),
    file(
      V88,
      'const sql = "CREATE TABLE IF NOT EXISTS standing_rule (id TEXT)"; const f = "CREATE TABLE standing_rule_fire (id TEXT)";\n',
    ),
    file(
      RPC,
      "insertRule(db, r); resumeRule(db, id); pauseRule(db, id, n); revokeRule(db, id, n);\n",
    ),
    file(
      LEARNING,
      'if (prov["kind"] === "owner_workflow") { applyStepRun(); openSuggestion(); markStaleFor(); hasLiveRuleFor(); }\n',
    ),
    file(
      SUGG_STORE,
      'db.run("INSERT INTO standing_suggestion (id) VALUES (1)"); db.run("DELETE FROM standing_streak"); export function applyStepRun() {} export function openSuggestion() {} export function markStaleFor() {}\n',
    ),
    file(
      V90,
      'const a = "CREATE TABLE IF NOT EXISTS standing_streak (id TEXT)"; const b = "CREATE TABLE IF NOT EXISTS standing_suggestion (id TEXT)";\n',
    ),
    file(RUNNER, "learnFromStepRun(db, run, cfg);\n"),
  ];
  const rules = (files: FileEntry[]): string[] => [
    ...new Set(checkStandingApprovals(files).map((v) => v.rule)),
  ];
  const swapExecutor = (contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === EXECUTOR ? file(EXECUTOR, contents) : f));
  const swapRunAsk = (contents: string): FileEntry[] =>
    GOOD.map((f) => (f.relPath === RUN_ASK ? file(RUN_ASK, contents) : f));

  test("the control: the allowed shape is clean", () => {
    expect(checkStandingApprovals(GOOD)).toEqual([]);
  });

  test("(a) FAILS when the owner_workflow provenance is built or its shape named outside its files", () => {
    for (const body of [
      'const p = { kind: "owner_workflow", workflowId: 1 };',
      'const t = "owner_workflow";',
      "const x: WorkflowProvenance = y;",
      "const s = { fieldSources: {} };",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-provenance-confined"]);
    }
    expect(
      rules([...GOOD, file(OTHER, "// owner_workflow WorkflowProvenance fieldSources")]),
    ).toEqual([]);
  });

  test("(a) the check may READ the literal but never construct it", () => {
    const reader = file(
      STEP,
      'if (p.kind !== "owner_workflow") return; const x = { kind: "owner_workflow" };\n',
    );
    expect(rules(GOOD.map((f) => (f.relPath === STEP ? reader : f)))).toEqual([
      "standing-provenance-confined",
    ]);
  });

  test("(f) the learning pass may read the owner_workflow literal but never construct it", () => {
    const reader = file(LEARNING, 'const ok = prov["kind"] === "owner_workflow";\n');
    expect(rules(GOOD.map((f) => (f.relPath === LEARNING ? reader : f)))).toEqual([]);
    for (const body of [
      'const p = { kind: "owner_workflow", runId: 1 };',
      'const p = { "kind": "owner_workflow", runId: 1 };',
      "const p = { 'kind' : 'owner_workflow' };",
      'p.kind = "owner_workflow";',
      'p["kind"] = "owner_workflow";',
    ]) {
      const builder = file(LEARNING, `${body}\n`);
      expect(rules(GOOD.map((f) => (f.relPath === LEARNING ? builder : f))), body).toEqual([
        "standing-provenance-confined",
      ]);
    }
    const compare = file(
      LEARNING,
      'const ok = p.kind === "owner_workflow" || p["kind"] == "owner_workflow";\n',
    );
    expect(rules(GOOD.map((f) => (f.relPath === LEARNING ? compare : f)))).toEqual([]);
    const shape = file(LEARNING, "const p: WorkflowProvenance = x; const q = p.fieldSources;\n");
    expect(rules(GOOD.map((f) => (f.relPath === LEARNING ? shape : f)))).toEqual([
      "standing-provenance-confined",
    ]);
  });

  test("(f) FAILS when a learning table is referenced outside the suggestion store and its DDL", () => {
    for (const body of [
      'db.run("INSERT INTO standing_suggestion (id) VALUES (1)");',
      'db.query("SELECT * FROM standing_streak");',
      'db.run("UPDATE standing_streak SET streak = 9");',
      'db.run("DELETE FROM standing_suggestion WHERE id = 1");',
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-learning-confined"]);
      expect(rules([...GOOD, file(LEARNING, body)]), body).toContain("standing-learning-confined");
    }
    expect(rules([...GOOD, file(OTHER, "// standing_streak standing_suggestion")])).toEqual([]);
  });

  test("(f) FAILS when the suggestion store or its DDL touches a rule table", () => {
    const dirtyStore = file(SUGG_STORE, 'db.run("UPDATE standing_rule SET paused_at = 1");\n');
    expect(rules(GOOD.map((f) => (f.relPath === SUGG_STORE ? dirtyStore : f)))).toEqual([
      "standing-tables-confined",
    ]);
    const dirtyDdl = file(
      V90,
      'const s = "CREATE TABLE IF NOT EXISTS standing_rule_fire (id TEXT)";\n',
    );
    expect(rules(GOOD.map((f) => (f.relPath === V90 ? dirtyDdl : f)))).toEqual([
      "standing-tables-confined",
    ]);
  });

  test("(f) FAILS when the learning pass, a streak writer or the live-rule question is named elsewhere", () => {
    for (const body of [
      "learnFromStepRun(db, run, cfg);",
      "applyStepRun(db, key, v, r, n);",
      "openSuggestion(db, key, 5, n);",
      "markStaleFor(db, id, sha, n);",
      "hasLiveRuleFor(db, key, n);",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-learning-confined"]);
    }
    // The RPC handler and the scheduler do not get the pass.
    expect(rules([...GOOD, file(RPC, "learnFromStepRun(db, run, cfg);")])).toEqual([
      "standing-learning-confined",
    ]);
    expect(rules([...GOOD, file(RPC, "hasLiveRuleFor(db, key, n);")])).toEqual([
      "standing-learning-confined",
    ]);
    expect(rules([...GOOD, file(SCHEDULER, "learnFromStepRun(db, run, cfg);")])).toEqual([
      "standing-learning-confined",
    ]);
  });

  test("(b) FAILS when either standing table is referenced outside the store and its DDL", () => {
    for (const body of [
      'db.run("INSERT INTO standing_rule (id) VALUES (1)");',
      'db.query("SELECT * FROM standing_rule_fire");',
      'db.run("UPDATE standing_rule SET actions_used = 0");',
      'db.run("DELETE FROM standing_rule WHERE id = 1");',
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-tables-confined"]);
    }
    expect(rules([...GOOD, file(OTHER, "// standing_rule")])).toEqual([]);
  });

  test("(b) FAILS when a store writer or the claim is named elsewhere", () => {
    for (const body of [
      "insertRule(db, r);",
      "resumeRule(db, id);",
      "revokeRule(db, id, n);",
      "pauseRule(db, id, n);",
      "claimFire(db, id, n, t, h);",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-tables-confined"]);
    }
  });

  test("(b) test files and test-support helpers are not scanned", () => {
    expect(rules([...GOOD, file(`${SRC}ipc/other.test.ts`, "insertRule(db, r);")])).toEqual([]);
    expect(rules([...GOOD, file(`${SRC}ipc/x.test-helpers.ts`, "insertRule(db, r);")])).toEqual([]);
  });

  test("(c) FAILS when the step is called twice, outside approvalPhase, or after the delegate", () => {
    expect(
      rules(swapExecutor(`${EXECUTOR_GOOD}\nfunction other() { standingRuleStep(a, c); }\n`)),
    ).toContain("standing-step-order-pinned");
    expect(
      rules(
        swapExecutor(EXECUTOR_GOOD.replace("standingRuleStep(action,", "somethingElse(action,")),
      ),
    ).toContain("standing-step-order-pinned");
    const late = EXECUTOR_GOOD.replace(
      "    const match = standingRuleStep(action, { deps: this.standingRules, rows: this.rows() });",
      "    const delegated = await this.tryDelegatedApproval(action, confirm, record);\n    const match = standingRuleStep(action, { deps: this.standingRules, rows: this.rows() });",
    ).replace(
      "    const delegated = await this.tryDelegatedApproval(action, confirm, record);\n    return delegated;",
      "    return 1;",
    );
    expect(rules(swapExecutor(late))).toContain("standing-step-order-pinned");
  });

  test("(c) FAILS when approvalPhase runs before the confirm phase in resolveHitlApproval", () => {
    const swapped = EXECUTOR_GOOD.replace(
      "    const confirm = this.renderConfirmPhase(action);\n    return this.approvalPhase(action, preview, confirm, record);",
      "    return this.approvalPhase(action, preview, confirm, record);\n    const confirm = this.renderConfirmPhase(action);",
    );
    expect(rules(swapExecutor(swapped))).toEqual(["standing-step-order-pinned"]);
  });

  test("(c) FAILS when the step name or the standing_approved outcome is used elsewhere", () => {
    expect(rules([...GOOD, file(OTHER, "standingRuleStep(a, c);")])).toEqual([
      "standing-outcome-confined",
    ]);
    for (const body of [
      'return { kind: "standing_approved", ruleId: r, fireId: f };',
      'record({ hitlStatus: "standing_approved" });',
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-outcome-confined"]);
    }
    // A status MAP or a SQL CHECK names the string without constructing the outcome.
    expect(rules([...GOOD, file(OTHER, 'case "standing_approved": return 1;')])).toEqual([]);
  });

  test("(e) FAILS when the dependency is named by any other file", () => {
    expect(
      rules([
        ...GOOD,
        file(OTHER, "new ToolExecutor(a, b, c, d, e, f, g, { standingRules: deps });"),
      ]),
    ).toEqual(["standing-rules-dep-confined"]);
    expect(rules([...GOOD, file(OTHER, "const d = exec.standingRules;")])).toEqual([
      "standing-rules-dep-confined",
    ]);
  });

  test("(e) FAILS when run-ask writes the dependency outside newWorkflowWriteExecutor, or twice", () => {
    const door = RUN_ASK_GOOD.replace(
      "{ beforeState: runner }",
      "{ beforeState: runner, standingRules: createStandingRuleDeps(p) }",
    );
    expect(rules(swapRunAsk(door))).toEqual(["standing-rules-dep-confined"]);
    const twice = RUN_ASK_GOOD.replace(
      "    standingRules: createStandingRuleDeps(p),",
      "    standingRules: createStandingRuleDeps(p),\n    standingRules: other,",
    );
    expect(rules(swapRunAsk(twice))).toEqual(["standing-rules-dep-confined"]);
    expect(
      rules(swapRunAsk("export function buildWorkflowWriteExecutor(p) { return 1; }\n")),
    ).toContain("standing-rules-dep-confined");
  });

  test("(e) FAILS when newWorkflowWriteExecutor gains a third caller or loses one", () => {
    const third = RUN_ASK_GOOD.replace(
      "export function buildModelWriteExecutor(p) {",
      "export function buildSneaky(p) {\n  return newWorkflowWriteExecutor(p, NEVER, false);\n}\nexport function buildModelWriteExecutor(p) {",
    );
    expect(rules(swapRunAsk(third))).toEqual(["standing-rules-dep-confined"]);
    const twiceInOne = RUN_ASK_GOOD.replace(
      "  return newWorkflowWriteExecutor(p, NEVER, true);",
      "  newWorkflowWriteExecutor(p, NEVER, true);\n  return newWorkflowWriteExecutor(p, NEVER, true);",
    );
    expect(rules(swapRunAsk(twiceInOne))).toEqual(["standing-rules-dep-confined"]);
    const swapped = RUN_ASK_GOOD.replace(
      "  return newWorkflowWriteExecutor(p, consentOf(p), false);",
      "  return newWorkflowWriteExecutor(p, NEVER, true);",
    );
    expect(rules(swapRunAsk(swapped))).toEqual(["standing-rules-dep-confined"]);
  });

  test("(d) FAILS when the unattended option is named by another file, or valued outside newWorkflowWriteExecutor", () => {
    for (const body of [
      "new ToolExecutor(a, b, c, d, e, f, g, { unattended: true });",
      "const u = ex.unattended;",
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-unattended-confined"]);
    }
    const outside = RUN_ASK_GOOD.replace(
      "export function buildModelWriteExecutor(p) {",
      "export function buildSneaky(p) {\n  return newTurnExecutor(p, undefined, { unattended: true });\n}\nexport function buildModelWriteExecutor(p) {",
    );
    expect(rules(swapRunAsk(outside))).toEqual(["standing-unattended-confined"]);
    expect(rules([...GOOD, file(OTHER, "// unattended: true")])).toEqual([]);
  });

  test("(d) FAILS when the executor reads the option twice, outside approvalPhase, or after the delegate", () => {
    const twice = EXECUTOR_GOOD.replace(
      "    const delegated = await",
      "    if (this.unattended) { log(); }\n    const delegated = await",
    );
    expect(rules(swapExecutor(twice))).toContain("standing-unattended-confined");
    const elsewhere = `${EXECUTOR_GOOD}\nfunction other(self) { return this.unattended; }\n`;
    expect(rules(swapExecutor(elsewhere))).toContain("standing-unattended-confined");
    const late = EXECUTOR_GOOD.replace(
      '    if (this.unattended) {\n      record.rejectReason = UNATTENDED_NO_RULE_REASON;\n      return { kind: "rejected", reason: UNATTENDED_NO_RULE_REASON, answerSource: "none" };\n    }\n    const delegated = await this.tryDelegatedApproval(action, confirm, record);',
      '    const delegated = await this.tryDelegatedApproval(action, confirm, record);\n    if (this.unattended) {\n      record.rejectReason = UNATTENDED_NO_RULE_REASON;\n      return { kind: "rejected", reason: UNATTENDED_NO_RULE_REASON, answerSource: "none" };\n    }',
    );
    expect(rules(swapExecutor(late))).toContain("standing-unattended-confined");
    const before = EXECUTOR_GOOD.replace(
      "    const match = standingRuleStep(action, { deps: this.standingRules, rows: this.rows() });\n",
      "    if (this.unattended) { return 1; }\n    const match = standingRuleStep(action, { deps: this.standingRules, rows: this.rows() });\n",
    ).replace(
      '    if (this.unattended) {\n      record.rejectReason = UNATTENDED_NO_RULE_REASON;\n      return { kind: "rejected", reason: UNATTENDED_NO_RULE_REASON, answerSource: "none" };\n    }\n',
      "",
    );
    expect(rules(swapExecutor(before))).toContain("standing-unattended-confined");
  });

  test("(d) FAILS when the refusal text is returned outside approvalPhase or by another file", () => {
    const stray = `${EXECUTOR_GOOD}\nfunction other() { return UNATTENDED_NO_RULE_REASON; }\n`;
    expect(rules(swapExecutor(stray))).toContain("standing-unattended-confined");
    expect(rules([...GOOD, file(OTHER, "return { reason: UNATTENDED_NO_RULE_REASON };")])).toEqual([
      "standing-unattended-confined",
    ]);
  });

  test("(d) FAILS when the schedule trigger is produced by any file but the scheduler", () => {
    for (const body of [
      'const run = { trigger: "schedule" };',
      "const run = { trigger: 'schedule', x: 1 };",
      'f({ trigger : "schedule" });',
    ]) {
      expect(rules([...GOOD, file(OTHER, body)]), body).toEqual(["standing-unattended-confined"]);
    }
    // Reading the literal (a comparison, a type, a set of triggers) is not producing it.
    expect(
      rules([...GOOD, file(OTHER, 'if (p.trigger === "schedule") {} type T = "schedule";')]),
    ).toEqual([]);
  });
});
