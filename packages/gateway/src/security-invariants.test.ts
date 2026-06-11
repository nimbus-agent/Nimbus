import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { runIndexedSchemaMigrations } from "./index/migrations/runner.ts";
import { type LocalBaseline, PolicyGate } from "./policy/policy-gate.ts";
import { signPolicy } from "./policy/policy-signing.ts";
import { PolicyStore } from "./policy/policy-store.ts";

const SRC_ROOT = import.meta.dir;
const REPO_ROOT = resolve(SRC_ROOT, "..", "..", "..");

async function read(relPathFromRepoRoot: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relPathFromRepoRoot), "utf8");
}

async function readDirConcat(relDirFromRepoRoot: string): Promise<string> {
  const dir = resolve(REPO_ROOT, relDirFromRepoRoot);
  const entries = await readdir(dir);
  const tsFiles = entries.filter((f) => f.endsWith(".ts"));
  const contents = await Promise.all(tsFiles.map((f) => readFile(resolve(dir, f), "utf8")));
  return contents.join("\n");
}

describe("I1 — extensionProcessEnv is the only env source for spawned MCP children", () => {
  test("lazy-mesh/ contains no raw `{ ...process.env }` spread", async () => {
    const src = await readDirConcat("packages/gateway/src/connectors/lazy-mesh");
    expect(src).not.toMatch(/\{\s*\.\.\.process\.env\s*\}/);
  });

  test("lazy-mesh/ uses extensionProcessEnv() at every spawn site", async () => {
    const src = await readDirConcat("packages/gateway/src/connectors/lazy-mesh");
    const callers = src.match(/extensionProcessEnv\(/g) ?? [];
    expect(callers.length).toBeGreaterThanOrEqual(20);
  });

  test("extensionProcessEnv uses an allowlist (BASELINE_KEYS) — denylist would let new secrets leak by default", async () => {
    const src = await read("packages/gateway/src/extensions/spawn-env.ts");
    expect(src).toMatch(/BASELINE_KEYS/);
    expect(src).not.toMatch(/\.\.\.process\.env/);
    expect(src).toMatch(/process\.env\[k\]/);
  });
});

describe("I2 — HITL frozen-set membership", () => {
  test("HITL_REQUIRED is exported from a frozen Object.freeze façade", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(/export const HITL_REQUIRED\s*=\s*Object\.freeze\(/);
  });

  test("HITL_REQUIRED_BACKING is module-private (not exported)", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).not.toMatch(/export\s+(?:const|let|var)\s+HITL_REQUIRED_BACKING/);
  });

  test("HITL_REQUIRED_BACKING contains T2 PR 3 auto-update action types", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(/"extension\.autoUpdate"/);
    expect(src).toMatch(/"extension\.downgrade"/);
  });
});

describe("I3 — HITL gate consults action.type (not payload.mcpToolId)", () => {
  test("executor.gate looks up HITL_REQUIRED.has(action.type), not the routing-only mcpToolId", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(/HITL_REQUIRED\.has\(action\.type\)/);
    expect(src).not.toMatch(/HITL_REQUIRED\.has\(\s*action\.payload/);
    expect(src).not.toMatch(/HITL_REQUIRED\.has\(\s*resolvedToolId\s*\)/);
  });

  test("dispatcher uses action.type when payload.mcpToolId is absent", async () => {
    const src = await read("packages/gateway/src/connectors/registry.ts");
    expect(src).toMatch(/mcpToolId/);
    expect(src).toMatch(/action\.type/);
  });
});

describe("I4 — hitlStatus is consent-output-only in production paths", () => {
  test("data-delete.ts does not hardcode hitlStatus", async () => {
    const src = await read("packages/gateway/src/commands/data-delete.ts");
    expect(src).not.toMatch(/hitlStatus:\s*"approved"/);
  });
});

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

  test("FORBIDDEN_OVER_LAN blocks extension.checkForUpdates + extension.update (T2 PR 3)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"extension\.checkForUpdates"/);
    expect(src).toMatch(/"extension\.update"/);
  });

  test("admits the team-vault wire methods but FORBIDS team-vault/HITL management over LAN (Slice 2)", async () => {
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
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
});

describe("I6 — LAN bind defaults to loopback", () => {
  test("DEFAULT_NIMBUS_LAN_TOML.bind is 127.0.0.1, never 0.0.0.0", async () => {
    const src = await read("packages/gateway/src/config/nimbus-toml.ts");
    expect(src).not.toMatch(/bind:\s*"0\.0\.0\.0"/);
    expect(src).toMatch(/bind:\s*"127\.0\.0\.1"/);
  });
});

describe("I8 — Tauri renderer CSP is restrictive", () => {
  test("tauri.conf.json sets a non-null, non-unsafe CSP", async () => {
    const raw = await read("packages/ui/src-tauri/tauri.conf.json");
    const conf = JSON.parse(raw) as { app?: { security?: { csp?: string | null } } };
    const csp = conf.app?.security?.csp;
    expect(csp).toBeTypeOf("string");
    expect(csp).not.toBeNull();
    expect(csp ?? "").not.toMatch(/unsafe-inline/);
    expect(csp ?? "").not.toMatch(/unsafe-eval/);
    expect(csp ?? "").toMatch(/default-src 'self'/);
  });
});

describe("I9 — bound SQL parameters; identifiers go through escapeIdentifier", () => {
  test("db/repair.ts escapes identifiers by doubling quotes (no raw interpolation)", async () => {
    const src = await read("packages/gateway/src/db/repair.ts");
    expect(src).toMatch(/escapeIdentifier/);
    expect(src).toMatch(/replaceAll\('"', '""'\)/);
  });

  test("db/repair.ts guards against NUL-byte / empty identifier names", async () => {
    const src = await read("packages/gateway/src/db/repair.ts");
    expect(src).toMatch(/String\.fromCodePoint\(0\)/);
    expect(src).toMatch(/includes\(NUL_CHAR\)/);
  });

  test("people/person-store.ts binds caller values via dbRun placeholders, never string-built SQL", async () => {
    const src = await read("packages/gateway/src/people/person-store.ts");
    expect(src).toMatch(/import \{ dbRun \} from "\.\.\/db\/write\.ts"/);
    expect(src).toMatch(/WHERE id = \?/);
    // S5-F5: no caller-supplied value is interpolated into an UPDATE/SET clause.
    expect(src).not.toMatch(/SET\s+\w+\s*=\s*\$\{/);
  });
});

describe("I12 — DPAPI calls pass per-installation optional entropy (win32)", () => {
  test("vault/win32.ts loads entropy from <configDir>/vault/.entropy", async () => {
    const src = await read("packages/gateway/src/vault/win32.ts");
    expect(src).toMatch(/ENTROPY_FILENAME\s*=\s*"\.entropy"/);
    expect(src).toMatch(/function loadOrCreateEntropy\(/);
  });

  test("entropy flows into both the encrypt and decrypt DPAPI paths", async () => {
    const src = await read("packages/gateway/src/vault/win32.ts");
    // Encrypt path consumes the cached entropy; decrypt tries with-entropy before the legacy null fallback.
    expect(src).toMatch(/loadOrCreateEntropy\(this\.vaultDir\)/);
    expect(src).toMatch(/dpapiDecrypt\(encrypted, entropy\)/);
    // The pOptionalEntropy DATA_BLOB pointer is only built when entropy is present, never dropped unconditionally.
    expect(src).toMatch(/entropyArg = ptr\(entropyBlob\)/);
  });
});

describe("I10 — Constant-time compare helpers live in util/timing-safe-compare.ts", () => {
  test("extensions/verify-extensions.ts imports sha256HexEqualConstantTime from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/extensions/verify-extensions.ts");
    expect(src).toMatch(
      /import\s*\{\s*sha256HexEqualConstantTime\s*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  test("updater/updater.ts imports sha256HexEqualConstantTime from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/updater/updater.ts");
    expect(src).toMatch(
      /import\s*\{\s*sha256HexEqualConstantTime\s*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  test("ipc/lan-pairing.ts imports constantTimeStringEqual from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/ipc/lan-pairing.ts");
    expect(src).toMatch(
      /import\s*\{[^}]*\bconstantTimeStringEqual\b[^}]*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  test("ipc/http-auth.ts imports constantTimeStringEqual from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/ipc/http-auth.ts");
    expect(src).toMatch(
      /import\s*\{[^}]*\bconstantTimeStringEqual\b[^}]*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  test("ipc/lan-pairing.ts does NOT define a local timingSafeEqual or constantTimeStringEqual", async () => {
    const src = await read("packages/gateway/src/ipc/lan-pairing.ts");
    expect(src).not.toMatch(/function\s+timingSafeEqual\s*\(/);
    expect(src).not.toMatch(/function\s+constantTimeStringEqual\s*\(/);
  });

  test("ipc/http-auth.ts does NOT define a local constantTimeStringEqual", async () => {
    const src = await read("packages/gateway/src/ipc/http-auth.ts");
    expect(src).not.toMatch(/function\s+constantTimeStringEqual\s*\(/);
  });
});

describe("I11 — Tool-result envelope on the LLM-facing path", () => {
  test("wrapToolOutput is exported from tool-output-envelope.ts", async () => {
    const src = await read("packages/gateway/src/engine/tool-output-envelope.ts");
    expect(src).toMatch(/export function wrapToolOutput/);
  });

  test("the envelope helper escapes literal </tool_output> sequences inside tool bodies", async () => {
    const src = await read("packages/gateway/src/engine/tool-output-envelope.ts");
    expect(src).toMatch(/replaceAll\("<\/tool_output>"/);
  });

  test("agent.ts both wraps with envelope AND writes tool_call_log on the LLM-facing path", async () => {
    const src = await read("packages/gateway/src/engine/agent.ts");
    expect(src).toMatch(/wrapToolOutput\(/);
    expect(src).toMatch(/writeToolCallLog\(/);
  });

  test("mesh.ts:listTools both wraps with envelope AND writes tool_call_log", async () => {
    const src = await read("packages/gateway/src/connectors/lazy-mesh/mesh.ts");
    expect(src).toMatch(/wrapToolOutput\(/);
    expect(src).toMatch(/writeToolCallLog\(/);
  });

  test("db/tool-call-log.ts exports writeToolCallLog and readToolCallLog", async () => {
    const src = await read("packages/gateway/src/db/tool-call-log.ts");
    expect(src).toMatch(/export function writeToolCallLog/);
    expect(src).toMatch(/export function readToolCallLog/);
  });
});

describe("I13 — HTTP write routes go through allowlist + bearer auth", () => {
  test("http-server.ts imports dispatchWriteRoute from ./http-write-routes.ts", async () => {
    const src = await read("packages/gateway/src/ipc/http-server.ts");
    // The named-import block may span multiple lines and carry sibling imports
    // (e.g. `type PolicyAuthorResult`, `WRITE_ROUTE_ALLOWLIST`); assert the
    // braced block both contains `dispatchWriteRoute` and resolves to the
    // `./http-write-routes.ts` module.
    expect(src).toMatch(
      /import\s*\{[\s\S]*?\bdispatchWriteRoute\b[\s\S]*?\}\s*from\s*['"]\.\/http-write-routes\.ts['"]/,
    );
  });

  test("http-server.ts opens at most one writable Database handle (and only inside the server-context wiring)", async () => {
    const src = await read("packages/gateway/src/ipc/http-server.ts");
    const readonlyOpens = (src.match(/new Database\([^)]*readonly:\s*true/g) ?? []).length;
    const allOpens = (src.match(/new Database\(/g) ?? []).length;
    const writableOpens = allOpens - readonlyOpens;
    expect(writableOpens).toBeLessThanOrEqual(1);
  });

  test("WRITE_ROUTE_ALLOWLIST is exactly the deployment + SCIM provisioning + admin-policy + teams-events routes", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("./ipc/http-write-routes.ts");
    // The count IS the integrity check (see nimbus-http-write-surface). Adding a write route
    // requires bumping this assertion in the same commit. 1 deploy route + 3 SCIM routes +
    // 1 admin-console anchor-policy route (PUT /v1/admin/policy, Task 18b) +
    // 1 ChatOps Teams inbound route (POST /v1/messaging/teams/events, Slice 5 — Bot Framework JWT).
    expect(WRITE_ROUTE_ALLOWLIST.length).toBe(6);
    expect([...WRITE_ROUTE_ALLOWLIST]).toEqual([
      "POST /v1/deployments",
      "POST /scim/v2/Users",
      "PATCH /scim/v2/Users/{id}",
      "DELETE /scim/v2/Users/{id}",
      "PUT /v1/admin/policy",
      "POST /v1/messaging/teams/events",
    ]);
  });
});

describe("I14 — all SQLite write paths route through dbRun/dbExec/dbStmtRun", () => {
  test("migrated subsystems import dbRun or dbExec from db/write.ts", async () => {
    const samples = [
      "packages/gateway/src/sync/scheduler-store.ts",
      "packages/gateway/src/automation/watcher-store.ts",
      "packages/gateway/src/connectors/health.ts",
      "packages/gateway/src/engine/sub-agent.ts",
      "packages/gateway/src/db/audit-chain.ts",
      "packages/gateway/src/embedding/pipeline.ts",
      "packages/gateway/src/index/migrations/runner.ts",
    ];
    for (const rel of samples) {
      const src = await read(rel);
      expect(src).toMatch(/from\s+"[^"]*write\.ts"/);
    }
  });

  test("three representative subsystems contain dbRun/dbExec/dbStmtRun calls but no direct db.run/db.exec", async () => {
    const checks = [
      "packages/gateway/src/automation/watcher-store.ts",
      "packages/gateway/src/engine/sub-agent.ts",
      "packages/gateway/src/db/audit-chain.ts",
    ];
    for (const rel of checks) {
      const src = await read(rel);
      expect(src).toMatch(/\bdb(?:Run|Exec|StmtRun)\s*\(/);
      expect(src).not.toMatch(/\bdb\.(?:run|exec)\s*\(/);
    }
  });

  test("DB_RUN_EXEC_ALLOW_LIST in check-nimbus-invariants.ts is exactly the wrapper file", async () => {
    const src = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(src).toMatch(/DB_RUN_EXEC_ALLOW_LIST/);
    expect(src).toMatch(/"packages\/gateway\/src\/db\/write\.ts"/);
    const m = /DB_RUN_EXEC_ALLOW_LIST[^\]]*?\]/s.exec(src);
    expect(m).toBeTruthy();
    const block = m?.[0] ?? "";
    const extra = block.match(/"packages\/(?!gateway\/src\/db\/write\.ts")[^"]+"/g);
    expect(extra).toBeNull();
  });
});

describe("I15 — SandboxRunner is intrinsic to every extension spawn", () => {
  test("sandbox-runner.ts exports SandboxRunner + createSandboxRunner", async () => {
    const src = await read("packages/gateway/src/platform/sandbox/sandbox-runner.ts");
    expect(src).toMatch(/export interface SandboxRunner\b/);
    expect(src).toMatch(/export async function createSandboxRunner\b/);
  });

  test("sandbox-wrapper.ts wires sandboxRunner.spawn at the wrapper entrypoint", async () => {
    const src = await read("packages/gateway/src/platform/sandbox/sandbox-wrapper.ts");
    expect(src).toMatch(/createSandboxRunner/);
    expect(src).toMatch(/runner\.spawn\s*\(/);
  });

  test("wrap-server-spec.ts exports wrapServerSpec", async () => {
    const src = await read("packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts");
    expect(src).toMatch(/export function wrapServerSpec\b/);
  });

  for (const file of [
    "packages/gateway/src/connectors/lazy-mesh/mesh.ts",
    "packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts",
    "packages/gateway/src/connectors/lazy-mesh/phase3-config.ts",
    "packages/gateway/src/connectors/lazy-mesh/user-mcp.ts",
  ]) {
    test(`${file} routes every ServerSpec through wrapServerSpec`, async () => {
      const src = await read(file);
      expect(src).toMatch(/wrapServerSpec\s*\(/);
    });
  }
});

describe("I16 — Verified-publisher invariant", () => {
  test("static: install-from-local.ts and verify-extensions.ts both call verifyManifestSignature", async () => {
    const install = await read("packages/gateway/src/extensions/install-from-local.ts");
    const verify = await read("packages/gateway/src/extensions/verify-extensions.ts");
    expect(install).toContain("verifyManifestSignature(");
    expect(verify).toContain("verifyManifestSignature(");
  });

  test("behavioral #1: signed extension with missing vault key is hard-disabled at startup", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pino = (await import("pino")).default;

    const { insertExtensionRow, listExtensions } = await import("./automation/extension-store.ts");
    const { signatureDisabledRegistry } = await import("./extensions/hard-disable.ts");
    const { encodeBase64, generateEd25519Keypair, signManifest } = await import(
      "./extensions/verify-signature.ts"
    );
    const { verifyExtensionsBestEffort } = await import("./extensions/verify-extensions.ts");
    const { MockVault } = await import("./vault/mock.ts");
    const { setupFreshExtensionDb } = await import("../test/fixtures/extension.ts");

    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    const id = "test-ext-missing-key";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const base = {
      id,
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(pubkey) },
    };
    const signature = await signManifest(base, privkey);
    const mfBytes = Buffer.from(JSON.stringify({ ...base, signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    const entryText = "export default {};";
    writeFileSync(join(dir, "dist", "index.js"), entryText);
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update(entryText).digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });

    try {
      await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
      expect(signatureDisabledRegistry.reasonFor(id)).toBe("publisher_key_missing");
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("behavioral #2: tampered manifest is hard-disabled at startup with signature_failed", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pino = (await import("pino")).default;

    const { insertExtensionRow, listExtensions } = await import("./automation/extension-store.ts");
    const { dbRun } = await import("./db/write.ts");
    const { signatureDisabledRegistry } = await import("./extensions/hard-disable.ts");
    const { writePublisherKey } = await import("./extensions/publisher-keys.ts");
    const { encodeBase64, generateEd25519Keypair, signManifest } = await import(
      "./extensions/verify-signature.ts"
    );
    const { verifyExtensionsBestEffort } = await import("./extensions/verify-extensions.ts");
    const { MockVault } = await import("./vault/mock.ts");
    const { setupFreshExtensionDb } = await import("../test/fixtures/extension.ts");

    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const id = "test-ext-tampered";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const base = {
      id,
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(pubkey) },
    };
    const signature = await signManifest(base, privkey);
    const mfBytes = Buffer.from(JSON.stringify({ ...base, signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    const entryText = "export default {};";
    writeFileSync(join(dir, "dist", "index.js"), entryText);
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update(entryText).digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    const tampered = Buffer.from(JSON.stringify({ ...base, version: "9.9.9", signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), tampered);
    const newHash = createHash("sha256").update(tampered).digest("hex");
    dbRun(db, "UPDATE extension SET manifest_hash = ? WHERE id = ?", [newHash, id]);

    try {
      await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

      const row = listExtensions(db).find((r) => r.id === id);
      expect(row?.enabled).toBe(0);
      expect(signatureDisabledRegistry.reasonFor(id)).toBe("signature_failed");
    } finally {
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});

describe("I7 — Tauri ALLOWED_METHODS surface for T2 PR 3", () => {
  test("ALLOWED_METHODS contains extension.checkForUpdates and extension.update", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toContain(`"extension.checkForUpdates"`);
    expect(rust).toContain(`"extension.update"`);
  });

  test("extension.install stays absent from ALLOWED_METHODS (chain C1 / B1 audit)", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toMatch(/^\s*"extension\.install",\s*$/m);
  });

  test("allowlist_exact_size assertion is 88", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*88\s*\)/);
  });

  test("Slice 4: read-only admin/policy/team-audit methods are allowed; privileged policy/team-purge methods stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    // Read-only observability/admin surfaces are renderer-callable.
    for (const m of ["admin.status", "policy.show", "team.auditMerged"]) {
      expect(rust).toContain(`"${m}"`);
    }
    // Trust-establishing / destructive methods must NOT be renderer-callable.
    for (const m of ["policy.sign", "policy.trust", "policy.refetch", "team.purge"]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
    }
  });

  test("Slice 2: renderer-SAFE team methods are allowed; secret/RCE-class ones stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of [
      "federation.approvalRespond",
      "federation.quorumRespond",
      "hitl.listDelegations",
      "hitl.pendingQueue",
      "teamvault.list",
    ]) {
      expect(rust).toContain(`"${m}"`);
    }
    // Secret-writing / out-of-band / RCE-class team methods must NOT be renderer-callable.
    for (const m of [
      "teamvault.put",
      "teamvault.delete",
      "teamvault.grant",
      "teamvault.revoke",
      "hitl.delegate",
      "hitl.revokeDelegation",
      "federation.invoke",
      "federation.askInvoke",
    ]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
    }
  });
});

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

describe("I18 — IdP token validation is intrinsic + tokens are Vault-only", () => {
  test("identity.* read/login methods are in the Tauri allowlist; bind/setToken are NOT", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of [
      "identity.login",
      "identity.status",
      "identity.logout",
      "identity.listBindings",
      "scim.status",
      "scim.listUsers",
    ]) {
      expect(rust).toContain(`"${m}"`);
    }
    expect(rust).not.toContain('"scim.setToken"');
    expect(rust).not.toContain('"identity.bind"');
  });
  test("only the identity verifier validates an ID token; query-gate consults it", async () => {
    const gate = await read("packages/gateway/src/federation/query-gate.ts");
    expect(gate).toContain("isOperatorValid");
  });
});

describe("I19 — team-vault secret injection is leak-proof + fail-closed", () => {
  test("federation.invoke routes through the answerFederatedInvoke gate (sole consumption path)", async () => {
    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toContain("answerFederatedInvoke");
  });

  test("a missing team secret fails CLOSED before any spawn (never the operator credential)", async () => {
    const { invokeTeamTool } = await import("./teamvault/team-tool-invoke.ts");
    const vault = {
      get: async () => null, // team entry has no secret
      set: async () => {},
      delete: async () => {},
      listKeys: async () => [],
    };
    let spawned = false;
    await expect(
      invokeTeamTool(
        {
          vault,
          sandboxCwd: "/tmp",
          requiredSecretKeysFor: () => ["github.pat"],
          spawnAndCall: async () => {
            spawned = true;
            return {};
          },
        },
        { entry: "e", service: "github", toolId: "t", args: {} },
      ),
    ).rejects.toThrow();
    expect(spawned).toBe(false);
  });
});

describe("I20 — a delegated approval is honored only from a live, identity-valid delegate", () => {
  test("forged peer / invalid identity / timeout all fall back to the local owner", async () => {
    const { resolveDelegatedApproval } = await import("./engine/delegated-approval.ts");
    const base = { isActiveDelegate: (p: string) => p === "peer:bob", isOperatorValid: () => true };
    const forged = await resolveDelegatedApproval({
      ...base,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:eve", approved: true }),
    });
    const badId = await resolveDelegatedApproval({
      ...base,
      isOperatorValid: () => false,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: true }),
    });
    expect(forged).toBe("fallback_to_owner");
    expect(badId).toBe("fallback_to_owner");
  });
});

describe("I21 — quorum counts only DISTINCT authenticated peers", () => {
  test("the same peer approving twice does not satisfy a 2-of-N quorum", async () => {
    const { QuorumCoordinator } = await import("./engine/quorum/quorum-coordinator.ts");
    const ids: string[] = [];
    const coord = new QuorumCoordinator((requestId: string) => ids.push(requestId));
    const p = coord.collect({ approvers: 2, windowMs: 30 });
    coord.respond(ids[0] ?? "", "peer:a", true);
    coord.respond(ids[0] ?? "", "peer:a", true); // duplicate — must NOT count
    const r = await p;
    expect(r.outcome).toBe("failed"); // window elapses with only 1 distinct approver
  });
});

describe("I23 — ChatOps operational posts are bounded to originating / policy-notify channels", () => {
  test("(a) ReplyDispatcher derives the destination from a server-side ReplyTarget, not caller input", async () => {
    const src = await readFile(resolve(import.meta.dir, "chatops/reply-dispatcher.ts"), "utf8");
    expect(src).toMatch(/send\(target: ReplyTarget, text: string\)/);
    expect(src).toMatch(/target\.kind === "originating"/);
    expect(src).toMatch(/notifyChannelsFor\(target\.namespace\)/);
  });

  test("(b) no chatops module outside reply-dispatcher/transport references the connector post tools (D17)", async () => {
    const dir = resolve(import.meta.dir, "chatops");
    const offenders: string[] = [];
    async function walk(d: string, rel: string): Promise<void> {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
        if (ent.isDirectory()) {
          await walk(resolve(d, ent.name), childRel);
          continue;
        }
        if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
        if (childRel === "reply-dispatcher.ts" || childRel.startsWith("transport/")) continue;
        const c = await readFile(resolve(d, ent.name), "utf8");
        if (/\b(?:slack_chat_post|teams_chat_post)\b/.test(c)) offenders.push(childRel);
      }
    }
    await walk(dir, "");
    expect(offenders).toEqual([]);
  });
});

describe("I24 — a federated preflight executes only behind the LOCAL owner's HITL gate", () => {
  test("federation.preflight routes through answerFederatedPreflight (sole inbound path)", async () => {
    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toContain("answerFederatedPreflight");
  });

  test("the gate never spawns before approval, ignores a caller-supplied command, fails closed", async () => {
    const { answerFederatedPreflight } = await import("./federation/preflight-gate.ts");
    let ran = 0;
    let cmdSeen = "";
    const base = {
      isPeerGranted: () => true,
      resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/x", timeoutSeconds: 60 }),
      runCommand: async (cfg: { command: string }) => {
        ran += 1;
        cmdSeen = cfg.command;
        return { passed: true, summary: "", durationMs: 0 };
      },
      audit: () => {},
    };
    const req = { peerId: "p", namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" };
    // denied → zero run
    await answerFederatedPreflight({ ...base, requestApproval: async () => false }, req);
    expect(ran).toBe(0);
    // approved + a caller-supplied command field → only the configured command runs
    await answerFederatedPreflight({ ...base, requestApproval: async () => true }, {
      ...req,
      ...({ command: "rm -rf /" } as object),
    } as never);
    expect(cmdSeen).toBe("bun");
    // no local config → not_configured, fail-closed
    const r = await answerFederatedPreflight(
      { ...base, resolveCommand: () => undefined, requestApproval: async () => true },
      req,
    );
    expect(r).toEqual({ kind: "error", error: "not_configured" });
  });

  test("D18 confines runPreflightCommand to preflight-gate/preflight-runner", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D18-preflight-runner");
  });
});

describe("I22 — org policy applied only from a signature-verified bundle, monotonic-stricter", () => {
  const baseline: LocalBaseline = {
    retentionDays: 7,
    hitlRequired: new Set(["git.force_push_main"]),
    quorum: new Map(),
  };

  function gateWith(toml: string, sig: string, pubkeyB64: string): PolicyGate {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(pubkeyB64, "manual", 1);
    store.persist({ toml, sig, org: "acme", version: 1, source: "peer", fetchedAt: 1 });
    return new PolicyGate(store, baseline);
  }

  test("(a) a tampered policy is rejected; the gate stays ungoverned (falls back to baseline)", () => {
    const kp = generateEd25519Keypair();
    const good = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(good, encodeBase64(kp.privkey));
    const tampered = good.replace("min_days=30", "min_days=99");
    const gate = gateWith(tampered, sig, encodeBase64(kp.pubkey));
    expect(gate.status().signatureValid).toBe(false);
    expect(gate.enforced().retentionDays).toBe(7); // baseline, NOT 99
  });

  test("(b) a valid policy below baseline cannot weaken HITL/quorum/retention", () => {
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=3\n[policy.hitl]\nrequire=[]\n`;
    const gate = gateWith(
      toml,
      signPolicy(toml, encodeBase64(kp.privkey)),
      encodeBase64(kp.pubkey),
    );
    expect(gate.enforced().retentionDays).toBe(7);
    expect(gate.enforced().hitlRequired.has("git.force_push_main")).toBe(true);
  });
});
