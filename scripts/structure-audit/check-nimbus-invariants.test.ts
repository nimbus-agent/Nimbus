import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { CO_OWNED_ENTITY_TYPES } from "../../packages/gateway/src/graph/relationship-graph.ts";
import {
  assertScanIsMeaningful,
  checkActuationConfinement,
  checkAgentEmitterImportConfinement,
  checkChatopsUnwrappedPost,
  checkConnectorSpawnIsHidden,
  checkConnectorWriteConfinement,
  checkDriverImportConfinement,
  checkEgressChokepointConfinement,
  checkEmbeddingAppenderConfinement,
  checkEmbeddingConstructorConfinement,
  checkFlatUpsertGraphEntityCoOwnedTypes,
  checkForwardShareConfinement,
  checkRunConfinedConfinement,
  checkShareConsentBrokerConfinement,
  checkSharePublishConfinement,
  checkSpawnInvariant,
  checkSyncContextNoRawHandles,
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
  test("VAULT_KEY_ALLOW_LIST has exactly 10 entries", () => {
    // 9 → 10: slice 2b adds ONLY `llm/vendor-vault-keys.ts`, which owns the vendor keyspace. The
    // `<vendor>.api_key` when resolving the credential per call. The count is frozen ON PURPOSE —
    // a file gaining permission to construct a vault key is a decision, so it must be made
    // deliberately in a commit that also explains it, never absorbed silently.
    expect(VAULT_KEY_ALLOW_LIST).toHaveLength(10);
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
