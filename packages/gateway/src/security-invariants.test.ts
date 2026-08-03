import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { PairingWindowController } from "./clips/pairing-window.ts";
import { CONNECTOR_WRITES } from "./connectors/connector-write-registry.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "./egress/egress-ledger.ts";
import { egressHead } from "./egress/egress-verify.ts";
import { HITL_REQUIRED } from "./engine/executor.ts";
import { CURRENT_SCHEMA_VERSION } from "./index/local-index.ts";
import { runIndexedSchemaMigrations } from "./index/migrations/runner.ts";
import { HttpWriteRateLimiter } from "./ipc/http-rate-limit.ts";
import { type LocalBaseline, PolicyGate } from "./policy/policy-gate.ts";
import { signPolicy } from "./policy/policy-signing.ts";
import { PolicyStore } from "./policy/policy-store.ts";
import { TribalClusterStore } from "./tribal/cluster-store.ts";
import { captureToKnowledgeBase } from "./tribal/tribal-write-gate.ts";

function baseInvariantWriteCtx() {
  return {
    writeDb: new Database(":memory:"),
    expectedToken: "",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1000,
    knownServices: () => [] as readonly string[],
  };
}

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

  test("FORBIDDEN_OVER_LAN blocks index.rebody* (drives outbound third-party API traffic)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"index\.rebody"/);
    expect(src).toMatch(/"index\.rebodyCancel"/);
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // Fully forbidden, not merely write-gated: unlike index.reembed (local CPU recompute),
    // rebody spends the owner's own third-party API quota/rate limits — a stronger reason, so
    // this must never be reachable by a paired peer regardless of grant-write.
    expect(() => checkLanMethodAllowed("index.rebody", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    expect(() => checkLanMethodAllowed("index.rebodyCancel", peer)).toThrow(
      /ERR_METHOD_NOT_ALLOWED/,
    );
  });

  test("FORBIDDEN_OVER_LAN blocks extension.checkForUpdates + extension.update (T2 PR 3)", async () => {
    const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(src).toMatch(/"extension\.checkForUpdates"/);
    expect(src).toMatch(/"extension\.update"/);
  });

  test("FORBIDDEN_OVER_LAN blocks share.create + share.prune + share.approvalRespond (Slice 8 / I27)", async () => {
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // The outbound chokepoint, the local prune, and the LOCAL-owner approval answer are all
    // un-callable over the wire — a remote peer must never approve/trigger an outbound publish.
    expect(() => checkLanMethodAllowed("share.create", peer)).toThrow();
    expect(() => checkLanMethodAllowed("share.prune", peer)).toThrow();
    expect(() => checkLanMethodAllowed("share.approvalRespond", peer)).toThrow();
    // Read-only share methods remain admitted (gated downstream like federation reads).
    expect(() => checkLanMethodAllowed("share.verify", peer)).not.toThrow();
  });

  test("FORBIDDEN_OVER_LAN blocks filesystem.ensureRoot (Stage 2a)", async () => {
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // Blame-root registration is a local-only owner action; a remote peer must never be able
    // to add an indexing root on this machine.
    expect(() => checkLanMethodAllowed("filesystem.ensureRoot", peer)).toThrow(
      /ERR_METHOD_NOT_ALLOWED/,
    );
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

  test("FORBIDDEN_OVER_LAN blocks the clip namespace (I30 — pairing must stay owner-opened)", async () => {
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // clip.pair opens the I30 pairing window and returns the one-time code in its response; a
    // paired LAN peer must never be able to call it and mint its own token without the owner
    // running `nimbus clip pair`. Checked on two methods to prove the namespace entry, not a
    // single-method coincidence.
    expect(() => checkLanMethodAllowed("clip.pair", peer)).toThrow(/not callable over LAN/);
    expect(() => checkLanMethodAllowed("clip.status", peer)).toThrow(/not callable over LAN/);
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
  test("db/write.ts defines the canonical escapeIdentifier (doubles embedded quotes)", async () => {
    const src = await read("packages/gateway/src/db/write.ts");
    expect(src).toMatch(/export function escapeIdentifier\(/);
    expect(src).toMatch(/replaceAll\('"', '""'\)/);
  });

  test("db/repair.ts imports escapeIdentifier from db/write.ts rather than defining its own copy", async () => {
    const src = await read("packages/gateway/src/db/repair.ts");
    // The import must be the SOURCE of the symbol. A regression that re-adds a
    // local `const escapeIdentifier = ...` / `function escapeIdentifier(...)`
    // shadowing definition would still satisfy a bare /escapeIdentifier/ match
    // and a bare /replaceAll\('"', '""'\)/ match (the string would just move
    // with it) — that is precisely the two-copies-of-a-security-primitive
    // drift this consolidation exists to prevent, so this test must fail in
    // that case rather than pass on the name alone.
    expect(src).toMatch(/import \{ dbRun, escapeIdentifier \} from "\.\/write\.ts"/);
    expect(src).toMatch(/escapeIdentifier\(table\)/);
    // The implementation itself must NOT be present in this file.
    expect(src).not.toMatch(/replaceAll\('"', '""'\)/);
    expect(src).not.toMatch(/(?:const|function)\s+escapeIdentifier\s*[=(]/);
  });

  test("connectors/reindex.ts imports escapeIdentifier from db/write.ts rather than defining its own copy", async () => {
    const src = await read("packages/gateway/src/connectors/reindex.ts");
    expect(src).toMatch(/import \{ dbRun, escapeIdentifier \} from "\.\.\/db\/write\.ts"/);
    expect(src).toMatch(/escapeIdentifier\(vecTable\)/);
    expect(src).not.toMatch(/replaceAll\('"', '""'\)/);
    expect(src).not.toMatch(/(?:const|function)\s+escapeIdentifier\s*[=(]/);
  });

  test("search/vec-store.ts imports escapeIdentifier from db/write.ts rather than a raw template literal", async () => {
    const src = await read("packages/gateway/src/search/vec-store.ts");
    // Same shape as reindex.ts: dims is constrained to SUPPORTED_EMBEDDING_DIMS,
    // but I9 is unconditional — the identifier is still escaped rather than
    // interpolated raw, and there must be no independent local copy.
    expect(src).toMatch(/import \{ escapeIdentifier \} from "\.\.\/db\/write\.ts"/);
    expect(src).toMatch(/escapeIdentifier\(`vec_items_\$\{String\(dims\)\}`\)/);
    expect(src).not.toMatch(/replaceAll\('"', '""'\)/);
    expect(src).not.toMatch(/(?:const|function)\s+escapeIdentifier\s*[=(]/);
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
    // 1 ChatOps Teams inbound route (POST /v1/messaging/teams/events, Slice 5 — Bot Framework JWT) +
    // 2 web-clipper routes (POST /v1/clips + POST /v1/clips/pair/confirm, I30) +
    // 4 research-brief routes (POST /v1/briefs + .../sources + .../run + .../save).
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(12);
    expect([...WRITE_ROUTE_ALLOWLIST]).toEqual([
      "POST /v1/deployments",
      "POST /scim/v2/Users",
      "PATCH /scim/v2/Users/{id}",
      "DELETE /scim/v2/Users/{id}",
      "PUT /v1/admin/policy",
      "POST /v1/messaging/teams/events",
      "POST /v1/clips",
      "POST /v1/clips/pair/confirm",
      "POST /v1/briefs",
      "POST /v1/briefs/{id}/sources",
      "POST /v1/briefs/{id}/run",
      "POST /v1/briefs/{id}/save",
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

  test("allowlist_exact_size assertion is 103", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*103\s*\)/);
  });

  // The count above is NOT sufficient on its own. A change that removes
  // agents.decisions and adds decisions.refresh — LAN-forbidden, and the verb
  // that can clear the whole decision store via decisions.rebuild — leaves the
  // count at 103 and would sail through. Name the methods.
  test("S1 decisions: agents.decisions is renderer-exposed; the pass verbs stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/^\s*"agents\.decisions",\s*$/m);
    expect(rust).not.toMatch(/^\s*"decisions\.refresh",\s*$/m);
    expect(rust).not.toMatch(/^\s*"decisions\.rebuild",\s*$/m);
    // …and the Rust side asserts the same thing at runtime, not just by count.
    expect(rust).toContain(`assert!(is_method_allowed("agents.decisions"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("decisions.refresh"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("decisions.rebuild"));`);
  });

  test("I29: the 4 egress read verbs are renderer-exposed; egress.prune (mutation) stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["egress.head", "egress.list", "egress.proveWindow", "egress.verify"]) {
      expect(rust).toContain(`"${m}"`);
    }
    expect(rust).not.toMatch(/^\s*"egress\.prune",\s*$/m);
  });

  test("Slice 6c: read-only tribal.status/list allowed; control-plane tribal methods stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["tribal.status", "tribal.list"]) {
      expect(rust).toContain(`"${m}"`);
    }
    for (const m of [
      "tribal.start",
      "tribal.stop",
      "tribal.dismiss",
      "tribal.scan",
      "tribal.capture",
    ]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
    }
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

  test("a localOperator team list fails CLOSED on a missing secret (no session opened)", async () => {
    const { invokeTeamToolList } = await import("./teamvault/team-tool-invoke.ts");
    let opened = false;
    await expect(
      invokeTeamToolList(
        {
          vault: {
            get: async () => null,
            set: async () => {},
            delete: async () => {},
            listKeys: async () => [],
          },
          sandboxCwd: "/tmp",
          requiredSecretKeysFor: () => ["snowflake.account"],
          openSession: async () => {
            opened = true;
            return [];
          },
        },
        { entry: "e", service: "snowflake", listToolId: "snowflake_list" },
      ),
    ).rejects.toThrow();
    expect(opened).toBe(false);
  });

  test("a team-credentialed list reaches the secret ONLY via the gate, never the personal drain", async () => {
    const { listConnectorItems, __setPersonalDrainForTest } = await import(
      "./connectors/warehouse-sync-transport.ts"
    );
    let personalCalled = false;
    let teamCalled = false;
    __setPersonalDrainForTest(async () => {
      personalCalled = true;
      return [];
    });
    try {
      await listConnectorItems(
        {
          vault: {
            get: async () => "x",
            set: async () => {},
            delete: async () => {},
            listKeys: async () => [],
          },
          sandboxCwd: "/tmp",
          credentialFor: () => ({ credential: "team", teamEntry: "prod-snowflake" }),
          runTeamList: async () => {
            teamCalled = true;
            return [];
          },
        } as never,
        "snowflake",
        "snowflake_list",
      );
    } finally {
      __setPersonalDrainForTest(undefined);
    }
    expect(teamCalled).toBe(true);
    expect(personalCalled).toBe(false);
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

  test("(c) no tribal module references the connector post tools — suggestions only via the injected I23 send seam (D17)", async () => {
    const dir = resolve(import.meta.dir, "tribal");
    const offenders: string[] = [];
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
      const c = await readFile(resolve(dir, ent.name), "utf8");
      if (/\b(?:slack_chat_post|teams_chat_post)\b/.test(c)) offenders.push(ent.name);
    }
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

describe("I25 — a tribal KB capture writes only the config destination, behind the owner's HITL gate", () => {
  function seededStore(): TribalClusterStore {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 39);
    const store = new TribalClusterStore(db);
    store.upsertOccurrence({
      clusterId: "k1",
      question: "how do I deploy?",
      vec: null,
      channelId: "C1",
      platform: "slack",
      now: 1000,
    });
    return store;
  }

  const draft = {
    title: "Deploying",
    bodyMarkdown: "Run deploy",
    citations: [] as { itemId: string; channelId: string; url: string | null }[],
  };

  test("(a) the destination is the config databaseId — never a caller value", async () => {
    const submitted: { type: string; payload: Record<string, unknown> }[] = [];
    const store = seededStore();
    const cluster = store.get("k1");
    expect(cluster).toBeDefined();
    const r = await captureToKnowledgeBase(
      {
        cfg: { notion: { databaseId: "db_cfg" } },
        synthesize: async () => draft,
        submitAction: async (action) => {
          submitted.push(action);
          return { status: "approved", result: { pageRef: "notion:pg1" } };
        },
        store,
        cooldownDays: 30,
        now: () => 5000,
      },
      cluster!,
      "notion",
    );
    expect(r).toEqual({ ok: true, pageRef: "notion:pg1" });
    expect(submitted[0]?.type).toBe("notion.knowledge.write");
    expect(submitted[0]?.payload["databaseId"]).toBe("db_cfg");
    expect(store.get("k1")?.status).toBe("captured");
  });

  test("(b) an unconfigured target fails closed (not_configured) and never submits an action", async () => {
    let submitCalls = 0;
    const store = seededStore();
    const r = await captureToKnowledgeBase(
      {
        cfg: {},
        synthesize: async () => draft,
        submitAction: async () => {
          submitCalls += 1;
          return { status: "approved", result: { pageRef: "x" } };
        },
        store,
        cooldownDays: 30,
        now: () => 5000,
      },
      store.get("k1")!,
      "notion",
    );
    expect(r).toEqual({ ok: false, error: "not_configured" });
    expect(submitCalls).toBe(0);
    expect(store.get("k1")?.status).toBe("pending");
  });

  test("(c) a rejected HITL leaves the cluster uncaptured", async () => {
    const store = seededStore();
    const r = await captureToKnowledgeBase(
      {
        cfg: { notion: { databaseId: "db_cfg" } },
        synthesize: async () => draft,
        submitAction: async () => ({ status: "rejected" }),
        store,
        cooldownDays: 30,
        now: () => 5000,
      },
      store.get("k1")!,
      "notion",
    );
    expect(r).toEqual({ ok: false, error: "rejected" });
    expect(store.get("k1")?.status).toBe("pending");
  });

  test("(d) D19 confines the KB-write tool ids to the write-gate + connector sites", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D19-tribal-kb-write");
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

describe("I26 — connector writes (warehouse/BI ∪ GitOps/ML) are confined to the local I2 path; federated gate rejects them", () => {
  test("answerFederatedInvoke is wired with the union isConnectorWriteToolId predicate in federation-rpc.ts", async () => {
    const src = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(src).toContain("isWriteForbiddenToolId");
    expect(src).toContain("isConnectorWriteToolId");
  });

  test("the federated invoke gate fail-closed rejects write-classified tool ids (D20 predicate)", async () => {
    const gate = await read("packages/gateway/src/federation/invoke-gate.ts");
    expect(gate).toContain("isWriteForbiddenToolId");
    expect(gate).toContain("write_forbidden");
  });

  test("every connector write tool id (incl. GitOps/ML) is HITL-gated via its action type (local path)", () => {
    for (const w of CONNECTOR_WRITES) {
      expect(HITL_REQUIRED.has(w.actionType)).toBe(true);
    }
  });

  test("D20 confines connector write tool ids to the SSoT + connector + transport/dispatch sites", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D20-connector-write");
    expect(audit).toContain("D20-invoke-gate-predicate");
  });
});

describe("I27 — outbound share gated by share.publish HITL action", () => {
  test("HITL_REQUIRED includes share.publish", async () => {
    const { HITL_REQUIRED } = await import("./engine/executor.ts");
    expect(HITL_REQUIRED.has("share.publish")).toBe(true);
  });

  // Replay executes tool calls named by an untrusted share file against the owner's live
  // credentialed mesh, so the read-only classifier is a security boundary and not a convenience.
  // It classifies by NAME: `iac_pulumi_preview` once matched the `preview` verb, and it runs
  // `pulumi preview --cwd <caller-supplied directory>`, which EVALUATES the stack program there.
  // Re-adding any verb that a process-spawning tool can carry reopens that path.
  test("the replay read-only classifier admits no process-spawning tool", async () => {
    const { isReadOnlyToolId } = await import("./share/read-tool-registry.ts");
    for (const id of [
      "iac_terraform_plan",
      "iac_terraform_apply",
      "iac_terraform_destroy",
      "iac_cloudformation_deploy",
      "iac_pulumi_preview",
      "iac_pulumi_up",
    ]) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
  });
});

describe("I29 — egress-ledger completeness over the executor chokepoint", () => {
  test("egress.prune is in the I2 HITL frozen set", async () => {
    const { HITL_REQUIRED } = await import("./engine/executor.ts");
    expect(HITL_REQUIRED.has("egress.prune")).toBe(true);
  });

  test("executor.gate appends an egress row before dispatch, blocks on deny, aborts on append failure", async () => {
    const { ToolExecutor } = await import("./engine/executor.ts");
    const order: string[] = [];
    const appended: Array<{ resultStatus: string }> = [];
    const consent = { requestApproval: async () => true };
    const audit = { recordAudit: () => {} };
    const connectors = {
      dispatch: async () => {
        order.push("dispatch");
        return {};
      },
    };
    const sink = {
      append: (e: { resultStatus: string }) => {
        order.push("append");
        appended.push(e);
      },
    };
    const exec = new ToolExecutor(consent, audit, connectors, undefined, sink);
    await exec.execute({ type: "search.run", payload: {} });
    expect(order).toEqual(["append", "dispatch"]);

    // deny → blocked row, no dispatch
    const order2: string[] = [];
    const denyConsent = { requestApproval: async () => false };
    const sink2 = { append: (e: { resultStatus: string }) => order2.push(e.resultStatus) };
    const connectors2 = {
      dispatch: async () => {
        order2.push("dispatch");
        return {};
      },
    };
    const exec2 = new ToolExecutor(denyConsent, audit, connectors2, undefined, sink2);
    await exec2.execute({ type: "email.send", payload: {} });
    expect(order2).toContain("blocked");
    expect(order2).not.toContain("dispatch");

    // append throws → abort
    const throwingSink = {
      append: () => {
        throw new Error("x");
      },
    };
    const connectors3 = { dispatch: async () => ({}) };
    const exec3 = new ToolExecutor(consent, audit, connectors3, undefined, throwingSink);
    await expect(exec3.execute({ type: "search.run", payload: {} })).rejects.toThrow();
  });

  test("D22 confines connectors.dispatch to executor.ts and the egress append to egress/*", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D22-connectors-dispatch");
    expect(audit).toContain("D22-egress-append");
  });

  test("I29: the D22 comment does not claim totality it cannot enforce", async () => {
    // D22 matches a literal string; it cannot see `inner.dispatch(action)`. Claiming otherwise is
    // the defect Phase 1 fixes — a label that leads its mechanism.
    const src = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(src).not.toContain("no escape hatch");
    expect(src).toContain("matches the literal string");
  });

  test("the egress append symbol is NOT referenced outside egress/* and executor.ts", async () => {
    // executor wires the SINK (makeEgressSink built in assemble), not appendEgressEntry directly.
    const exec = await read("packages/gateway/src/engine/executor.ts");
    expect(exec).toContain("EgressSink");
  });

  test("the executor's egress sink is a REQUIRED constructor parameter", async () => {
    // A required parameter makes an unwired sink a compile error rather than a silent no-op. The
    // named NULL_EGRESS_SINK keeps the "this executor performs no egress" decision on the record.
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toContain("private readonly egressSink: EgressSink,");
    expect(src).not.toContain("private readonly egressSink?: EgressSink,");
  });

  test("NULL_EGRESS_SINK leaves a real ledger untouched, where makeEgressSink writes", () => {
    // Asserts REAL behaviour against a real ledger — not that a spy counted a call. The two sinks
    // are handed the identical entry so the only variable is which sink received it.
    const entry = {
      timestamp: 1,
      sourceType: "task",
      sourceId: null,
      destination: "d",
      method: "m",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    } as const;

    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    NULL_EGRESS_SINK.append(entry);
    expect(egressHead(db).count).toBe(0);

    makeEgressSink(db).append(entry);
    expect(egressHead(db).count).toBe(1);
    db.close();
  });
});

describe("I30 — web-clipper token minting is fail-closed behind an owner-opened pairing window", () => {
  test("WRITE_ROUTE_ALLOWLIST is exactly the 12 sanctioned write routes (adds the 2 clip routes)", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("./ipc/http-write-routes.ts");
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(12);
    expect([...WRITE_ROUTE_ALLOWLIST]).toContain("POST /v1/clips");
    expect([...WRITE_ROUTE_ALLOWLIST]).toContain("POST /v1/clips/pair/confirm");
  });

  test("confirm with no open window mints nothing (fail-closed)", () => {
    const ctl = new PairingWindowController({ nowMs: () => 0, genCode: () => "111111" });
    expect(ctl.confirm("111111")).toBeNull(); // never opened
  });

  test("an expired window does not mint", () => {
    let now = 0;
    const ctl = new PairingWindowController({ nowMs: () => now, genCode: () => "111111" });
    ctl.open("dev");
    now = 200_000; // past the 120s TTL
    expect(ctl.confirm("111111")).toBeNull();
  });

  test("the pairing confirm route returns 403 (not 500/200) when no window is open", async () => {
    // mirror the http-write-routes.test.ts fail-closed case to prove the wiring, not just the unit
    const { dispatchWriteRoute } = await import("./ipc/http-write-routes.ts");
    let mintCalled = false;
    const surface = {
      pairing: new PairingWindowController({ nowMs: () => 0, genCode: () => "111111" }),
      verifyToken: async () => null,
      mintToken: async () => {
        mintCalled = true;
        return "SHOULD-NOT-BE-CALLED";
      },
      ingest: () => ({ id: "x", status: "created" as const }),
    };
    const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "111111" }),
    });
    const res = await dispatchWriteRoute(req, { ...baseInvariantWriteCtx(), clips: surface });
    expect(res.status).toBe(403);
    // The fail-closed witness: no token was minted (I30 is a security regression detector).
    expect(mintCalled).toBe(false);
  });
});
