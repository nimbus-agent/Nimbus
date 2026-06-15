import { describe, expect, test } from "bun:test";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import {
  checkShareConsentBrokerConfinement,
  checkSpawnInvariant,
  checkVaultKeyAllowList,
  checkWarehouseWriteConfinement,
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
    ]) {
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

describe("D20 — warehouse write-id confinement", () => {
  test("flags a write tool id referenced outside the allowed sites", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `dispatch("tableau_datasource_refresh")`,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("D20-warehouse-write");
  });

  test("allows the SSoT, connector servers, and transport/dispatch sites", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/warehouse-write-tools.ts",
        contents: `"tableau_datasource_refresh"`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("requires answerFederatedInvoke to consult isWriteForbiddenToolId", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `export async function answerFederatedInvoke() { return; }`,
      },
    ]);
    expect(v.some((x) => x.rule === "D20-invoke-gate-predicate")).toBe(true);
  });

  test("does NOT flag invoke-gate.ts when it consults isWriteForbiddenToolId", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `if (ctx.isWriteForbiddenToolId?.(q.toolId) === true) audit(ctx, q, "write_forbidden");`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("ignores .test.ts files", () => {
    const v = checkWarehouseWriteConfinement([
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
      { relPath: ASSEMBLE, contents: `shareConsent.request(input, ttl);` },
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
      { relPath: ASSEMBLE, contents: `shareConsent.request(input, ttl);` },
    ]);
    expect(v).toHaveLength(0);
  });
});
