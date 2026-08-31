import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import {
  checkAgentEmitterImportConfinement,
  checkEgressChokepointConfinement,
  checkEmbeddingConstructorConfinement,
  checkWrapServerSpecInvariant,
} from "../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments, stripStringLiterals } from "../../../scripts/structure-audit/lib.ts";
import type { ExpertBrief } from "./agents/_lib/findings.ts";
import { type ApiScope, LEGACY_SCOPES } from "./clips/api-scopes.ts";
import { CLIP_TOKENS_VAULT_KEY, verifyApiToken } from "./clips/clip-token-store.ts";
import { PairingWindowController } from "./clips/pairing-window.ts";
import { CONNECTOR_WRITES } from "./connectors/connector-write-registry.ts";
import { COVERAGE_CLASSES, THIS_BINARY_COVERAGE } from "./egress/egress-coverage.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "./egress/egress-ledger.ts";
import { EGRESS_SOURCE_TYPES, MARKER_SOURCE_TYPES } from "./egress/egress-source-type.ts";
import { egressHead } from "./egress/egress-verify.ts";
import { HITL_REQUIRED } from "./engine/executor.ts";
import { CURRENT_SCHEMA_VERSION } from "./index/local-index.ts";
import { runIndexedSchemaMigrations } from "./index/migrations/runner.ts";
import { HttpWriteRateLimiter } from "./ipc/http-rate-limit.ts";
import { AnthropicProvider } from "./llm/anthropic-provider.ts";
import { GeminiProvider } from "./llm/gemini-provider.ts";
import { LlamaCppProvider } from "./llm/llamacpp-provider.ts";
import { OllamaProvider } from "./llm/ollama-provider.ts";
import { OpenAiProvider } from "./llm/openai-provider.ts";
import { XaiProvider } from "./llm/xai-provider.ts";
import { type LocalBaseline, PolicyGate } from "./policy/policy-gate.ts";
import { signPolicy } from "./policy/policy-signing.ts";
import { PolicyStore } from "./policy/policy-store.ts";
import { TribalClusterStore } from "./tribal/cluster-store.ts";
import { captureToKnowledgeBase } from "./tribal/tribal-write-gate.ts";
import type { NimbusVault } from "./vault/nimbus-vault.ts";

function baseInvariantWriteCtx() {
  return {
    writeDb: new Database(":memory:"),
    expectedToken: "",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1000,
    knownServices: () => [] as readonly string[],
  };
}

/** Minimal in-memory vault fake (get/set/delete/listKeys) — mirrors clip-token-store.test.ts. */
function fakeVault(seed: Record<string, string> = {}): NimbusVault {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

const SRC_ROOT = import.meta.dir;
const REPO_ROOT = resolve(SRC_ROOT, "..", "..", "..");

async function read(relPathFromRepoRoot: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relPathFromRepoRoot), "utf8");
}

/**
 * Concatenate the PRODUCTION TypeScript under a directory, recursively.
 *
 * Both qualifiers are load-bearing and both were missing. `readdir` without `recursive` cannot
 * see a subdirectory, so nesting a spawn file one level down removed it from every check built on
 * this helper; and including `*.test.ts` let test files count toward a production floor, so the
 * floor could be met by fixtures asserting that the production code is wrong.
 */
async function readDirConcat(relDirFromRepoRoot: string): Promise<string> {
  return (await readDirFiles(relDirFromRepoRoot)).map((f) => f.contents).join("\n");
}

/**
 * The same walk, but keeping each file separate.
 *
 * A concatenated blob forces any per-file exemption to be expressed as a per-SHAPE exemption, and
 * a shape exemption applies to every file in the scan. That is not hypothetical: exempting
 * `wrap-server-spec.ts`'s own env literal by its `{` shape also exempted every multi-line `env: {`
 * anywhere under lazy-mesh, including one spreading `process.env`.
 */
async function readDirFiles(
  relDirFromRepoRoot: string,
): Promise<{ rel: string; contents: string }[]> {
  const dir = resolve(REPO_ROOT, relDirFromRepoRoot);
  const entries = await readdir(dir, { recursive: true });
  const tsFiles = entries
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  return Promise.all(
    tsFiles.map(async (rel) => ({ rel, contents: await readFile(resolve(dir, rel), "utf8") })),
  );
}

describe("I1 — extensionProcessEnv is the only env source for spawned MCP children", () => {
  test("lazy-mesh/ contains no `{ ...process.env` spread", async () => {
    // No closing brace in the pattern. `docs/SECURITY-INVARIANTS.md` writes the anti-pattern as
    // `spawn(..., { env: { ...process.env, EXTRA: ... } })` — and the previous regex,
    // /\{\s*\.\.\.process\.env\s*\}/, required `}` IMMEDIATELY after the spread, so it matched the
    // bare `{ ...process.env }` and missed the exact form the docs name. The leaking form is the
    // one with the comma: that is what a real regression looks like, because the site being
    // rewritten needs to add a variable or two alongside the inherited environment.
    const src = await readDirConcat("packages/gateway/src/connectors/lazy-mesh");
    expect(src).not.toMatch(/\{\s*\.\.\.process\.env\b/);
  });

  test("every env: in a lazy-mesh spawn spec comes from extensionProcessEnv", async () => {
    // Derived, not a hand-picked floor. This was `expect(callers.length).toBeGreaterThanOrEqual(20)`
    // against 80 actual call sites, so 60 of them could regress to a raw spread and the assertion
    // would still pass — and because the old readDirConcat swept in `*.test.ts`, fixtures counted
    // toward that floor too.
    //
    // The real property is not "enough calls exist", it is "no env: resolves to anything else", so
    // this enumerates every `env:` and classifies it. Written as what CANNOT pass: an unrecognised
    // shape fails and is named, rather than an expected shape being counted.
    // Per FILE, not one concatenated blob. `wrap-server-spec.ts` builds the sandbox hop's own env
    // as a multi-line object literal, and the only way to exempt that from a concatenated scan is
    // to exempt the SHAPE — a capture of exactly `{`. That exemption would then apply everywhere,
    // and since the capture stops at the first comma or newline, ANY multi-line env literal in ANY
    // file would match it, including `env: {\n  ...process.env,\n  EXTRA: x,\n}`. Exempting by file
    // keeps the wrapper out of the connector-spec classification without reopening the hole.
    const files = await readDirFiles("packages/gateway/src/connectors/lazy-mesh");
    const WRAPPER = "wrap-server-spec.ts";
    const unexplained: string[] = [];
    let wiredSites = 0;
    for (const f of files) {
      if (f.rel === WRAPPER) continue;
      wiredSites += (f.contents.match(/env\s*:\s*extensionProcessEnv\(/g) ?? []).length;
      const locals = new Set(
        [...f.contents.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*extensionProcessEnv\s*\(/g)].map(
          (m) => m[1] as string,
        ),
      );
      for (const m of f.contents.matchAll(/\benv\s*:\s*([^\n,]{1,60})/g)) {
        const v = (m[1] as string).trim();
        if (v.startsWith("extensionProcessEnv(")) continue;
        // `env: Record<string, string>` is a type annotation or a local builder whose result is
        // handed to extensionProcessEnv; it is never itself a spec's env.
        if (v.startsWith("Record<")) continue;
        // `env: outlookEnv` / `env: gitlabServerEnv` — a local bound to an extensionProcessEnv call
        // a few lines above. Resolved, not exempted: the binding must be in this same file.
        if (locals.has(v.replace(/,$/, ""))) continue;
        unexplained.push(`${f.rel}: env: ${v}`);
      }
    }
    expect(unexplained).toEqual([]);

    // Non-vacuity: the classifier above is satisfied by a scan that found no `env:` at all.
    expect(files.length).toBeGreaterThanOrEqual(13);
    expect(wiredSites).toBeGreaterThanOrEqual(70);
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
  /**
   * Files permitted to write `hitlStatus: "approved"` inline, each because the row RECORDS a
   * consent decision that a gate has already made on that exact path. Every entry was checked
   * against its gate, not assumed — an allowlist whose members were never verified is how a guard
   * becomes a laundering mechanism for the thing it polices.
   *
   * This is deliberately NOT the list of files that currently contain the string. `reindex.ts`
   * was on that list and is not here: its row sat on a path where the gate is structurally never
   * entered, so it was recording an approval that never happened. It now writes `not_required`.
   */
  const APPROVED_ROW_IS_EARNED: ReadonlyMap<string, string> = new Map([
    ["packages/gateway/src/egress/egress-prune.ts", "egress.prune ∈ HITL_REQUIRED (I2 frozen set)"],
    [
      "packages/gateway/src/extensions/install-from-local.ts",
      "extension.install_complete records the outcome of the install gate",
    ],
    [
      "packages/gateway/src/ipc/federation-rpc.ts",
      "federation.purge records the consent-broker HITL decision in the same handler",
    ],
    ["packages/gateway/src/share/share-gate.ts", "share.publish ∈ HITL_REQUIRED (I27 origin)"],
    [
      "packages/gateway/src/share/share-forward.ts",
      "share.publish ∈ HITL_REQUIRED (I27 re-forward)",
    ],
  ]);

  test('no production file outside the earned set hardcodes hitlStatus: "approved"', async () => {
    // The entire enforcement of I4 used to be one `read()` of `commands/data-delete.ts` and one
    // `not.toMatch`. Adding the string to ANY other file was invisible to CI — and one had:
    // `connectors/reindex.ts` forged an `approved` row on the ungated metadata_only path. There is
    // no static D-rule for I4 either, so that single grep was the whole of it.
    const offenders: string[] = [];
    for (const pkg of ["gateway", "cli", "ui"]) {
      const root = resolve(REPO_ROOT, "packages", pkg, "src");
      for (const f of await readdir(root, { recursive: true })) {
        const rel = `packages/${pkg}/src/${f.replaceAll("\\", "/")}`;
        // `.tsx` too. A `.ts`-only filter skipped 60 production files — 53 under `packages/ui/src`
        // and 7 under `packages/cli/src` — which is where an IPC-shaped audit row is most likely
        // to be hand-built in the first place.
        const isProdSource =
          (rel.endsWith(".ts") || rel.endsWith(".tsx")) &&
          !rel.endsWith(".test.ts") &&
          !rel.endsWith(".test.tsx") &&
          !rel.endsWith(".d.ts");
        if (!isProdSource) continue;
        if (APPROVED_ROW_IS_EARNED.has(rel)) continue;
        const src = await readFile(resolve(REPO_ROOT, rel), "utf8");
        // The union TYPE (`hitlStatus: "approved" | "rejected" | "not_required"`) is a declaration,
        // not an assignment, and appears in executor.ts / types.ts / local-index.ts by design.
        if (/hitlStatus:\s*"approved"(?!\s*\|)/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every earned entry still contains the row it is exempted for", async () => {
    // The other direction. An exemption for a file that no longer writes the row is dead weight
    // that quietly re-permits the string if the file is later reused for something else — the
    // same way a stale allowlist entry outlives the reason it was added.
    const stale: string[] = [];
    for (const [rel] of APPROVED_ROW_IS_EARNED) {
      const src = await readFile(resolve(REPO_ROOT, rel), "utf8");
      if (!/hitlStatus:\s*"approved"/.test(src)) stale.push(rel);
    }
    expect(stale).toEqual([]);
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

  test("FORBIDDEN_OVER_LAN blocks the whole exec namespace (S2 slice 1 / I33)", async () => {
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
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
    const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    // computer.act drives the owner's machine. computer.approvalRespond matters just as much:
    // admitting it would let a paired peer APPROVE an actuation on the owner's machine, defeating
    // the computer-use gate without ever calling computer.act over the wire.
    expect(() => checkLanMethodAllowed("computer.act", peer)).toThrow();
    expect(() => checkLanMethodAllowed("computer.approvalRespond", peer)).toThrow();
    // Namespace-level, so a future computer.* verb is forbidden by default rather than by memory.
    expect(() => checkLanMethodAllowed("computer.anythingAddedLater", peer)).toThrow();
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

  // (Task 12 review round 1, finding 4) A THIRD I11 wiring site: computer-use's model-callable
  // browser tools. This invariant's docs previously named only the two sites above; the wiring
  // landed without an update to either this file or SECURITY-INVARIANTS.md, which is exactly the
  // drift the triple rule (wiring + docs + test in one commit) exists to prevent.
  test("cu-tools.ts (computer-use) wraps textual tool results with envelope AND writes tool_call_log", async () => {
    const src = await read("packages/gateway/src/computer-use/cu-tools.ts");
    expect(src).toMatch(/wrapToolOutput\(/);
    expect(src).toMatch(/writeToolCallLog\(/);
  });

  test("cu-tools.ts's four textual browser tools each independently route through the shared runTextualAction wrap+log site", async () => {
    // Per-tool, not per-file, AND bounded to each tool's OWN block (fix round 2). A per-file
    // check (above) cannot catch ONE tool silently skipping the shared wrap+log helper while its
    // siblings still pass -- that motivated a per-tool check in round 1, but that check used a
    // non-greedy pattern that does not stop at the end of a tool's own block: it is satisfied by
    // ANY later tool's call site in source order, so mutating any tool but the LAST one
    // (browser_read) to bypass runTextualAction still passed. The fix here slices each tool's
    // block to end at the NEXT tool's own id declaration (or end of file), so the search can
    // never reach past a sibling tool's boundary.
    const src = stripComments(await read("packages/gateway/src/computer-use/cu-tools.ts"));
    const tools = ["browser_navigate", "browser_click", "browser_type", "browser_read"];
    for (const tool of tools) {
      const marker = `id: "${tool}"`;
      const start = src.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextIdx = src.indexOf('id: "', start + marker.length);
      const block = nextIdx === -1 ? src.slice(start) : src.slice(start, nextIdx);
      expect(block).toContain("runTextualAction(");
    }
  });

  test("cu-tools.ts's browser_screenshot is a DOCUMENTED I11 exception: no wrapToolOutput, but still writeToolCallLog", async () => {
    // The screenshot channel cannot be covered by a textual envelope (spec: the defense is
    // lexical, the attack is not) — this pins that the exception is real (no wrapToolOutput call
    // anywhere in that tool's own execute block) AND still forensically logged, AND that the file
    // says so out loud rather than silently under-covering.
    const src = await read("packages/gateway/src/computer-use/cu-tools.ts");
    const screenshotStart = src.indexOf('id: "browser_screenshot"');
    expect(screenshotStart).toBeGreaterThanOrEqual(0);
    const screenshotBlock = src.slice(screenshotStart);
    expect(screenshotBlock).not.toMatch(/wrapToolOutput\(/);
    expect(screenshotBlock).toMatch(/writeToolCallLog\(/);
    expect(src).toMatch(/no textual envelope can defend/i);
  });

  test("db/tool-call-log.ts exports writeToolCallLog and readToolCallLog", async () => {
    const src = await read("packages/gateway/src/db/tool-call-log.ts");
    expect(src).toMatch(/export function writeToolCallLog/);
    expect(src).toMatch(/export function readToolCallLog/);
  });

  test("every tool registered in agent.ts's baseTools goes through wrapToolForLlm", async () => {
    // The two tests above assert `wrapToolOutput(` / `wrapToolForLlm` appear SOMEWHERE in
    // agent.ts — a per-FILE check that cannot detect a missing (or typo'd) wrap on ONE of
    // several registered tools, since the file as a whole still matches. This derives the tool
    // list from the `baseTools` object literal itself, so a future tool added without a wrap
    // fails here rather than passing by virtue of its siblings being wrapped correctly.
    const src = stripComments(await read("packages/gateway/src/engine/agent.ts"));
    const startMarker = "const baseTools = {";
    const startIdx = src.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const braceStart = src.indexOf("{", startIdx);
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          braceEnd = i;
          break;
        }
      }
    }
    expect(braceEnd).toBeGreaterThan(braceStart);
    const block = src.slice(braceStart, braceEnd + 1);

    // Every top-level (or conditionally-spread) property key in the `baseTools` literal — a map
    // of tool name -> Mastra tool def, nothing else lives in it — is a registered tool and MUST
    // be wrapped.
    const keyPattern = /^\s*(\w+):\s*/gm;
    const registeredTools = [...block.matchAll(keyPattern)].map((m) => m[1] as string);
    expect(registeredTools.length).toBeGreaterThan(0);

    const unwrapped = registeredTools.filter(
      (key) => !new RegExp(`\\b${key}:\\s*wrapToolForLlm\\(`).test(block),
    );
    expect(unwrapped).toEqual([]);
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

  test("WRITE_ROUTE_ALLOWLIST is exactly the deployment + SCIM provisioning + admin-policy + teams-events + clip + brief + agent + items-fetch routes", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("./ipc/http-write-routes.ts");
    // The count IS the integrity check (see nimbus-http-write-surface). Adding a write route
    // requires bumping this assertion in the same commit. 1 deploy route + 3 SCIM routes +
    // 1 admin-console anchor-policy route (PUT /v1/admin/policy, Task 18b) +
    // 1 ChatOps Teams inbound route (POST /v1/messaging/teams/events, Slice 5 — Bot Framework JWT) +
    // 2 web-clipper routes (POST /v1/clips + POST /v1/clips/pair/confirm, I30) +
    // 4 research-brief routes (POST /v1/briefs + .../sources + .../run + .../save) +
    // 1 agent-invocation route (POST /v1/agents/{agent}, agents-scoped) +
    // 1 targeted-fetch route (POST /v1/items/fetch, fetch-scoped).
    //
    // The agent route is a WRITE by CLASSIFICATION, not because it mutates the index — it does not.
    // Listing it here is what subjects it to the bearer gate, the per-route body cap and the
    // per-token rate limiter; reclassifying it as a read to slip past this allowlist would be the
    // exact evasion the allowlist exists to prevent. The items-fetch route IS a write for the
    // ordinary reason too — it causes an outbound provider request and an index write — so it is
    // never modeled as a read that happens to have side effects.
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(14);
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
      "POST /v1/agents/{agent}",
      "POST /v1/items/fetch",
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

  test("the policy wire has ONE definition, so the producer and the wrapper cannot drift", async () => {
    // wrapServerSpec WRITES the policy env var; runSandboxWrapper READS it. They used to hardcode
    // the same string literal independently, which is two copies of one contract — and the drift
    // is silent in the worst direction: rename one side and the producer keeps setting a variable
    // nobody reads, while the wrapper aborts with "<name> not set", which reads as a misconfigured
    // environment rather than a broken build. Both now import the constant, so the mismatch is
    // unrepresentable rather than merely untested. Assert the IMPORT and the USE, not the literal —
    // matching the literal would pass on exactly the hardcoded copies this replaced.
    const producer = await read("packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts");
    const consumer = await read("packages/gateway/src/platform/sandbox/sandbox-wrapper.ts");
    for (const src of [producer, consumer]) {
      expect(src).toMatch(/SANDBOX_POLICY_ENV/);
      expect(src).toMatch(/SANDBOX_CWD_ENV/);
      expect(src).toMatch(/from "[^"]*sandbox-policy\.ts"/);
      // Strip comments: both files legitimately NAME the variable in prose while explaining it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/"NIMBUS_SANDBOX_(POLICY_JSON|CWD)"/);
    }
    expect(producer).toMatch(/\[SANDBOX_POLICY_ENV\]:\s*JSON\.stringify\(policyFromManifest\(/);
    expect(consumer).toMatch(/process\.env\[SANDBOX_POLICY_ENV\]/);
  });

  test("the wrapper VALIDATES the policy it receives, never casts it", async () => {
    // The payload crosses a process boundary, so it is `unknown` (non-negotiable 7) regardless of
    // who set it. A bare `as SandboxPolicy` let a malformed permission field reach the runner and
    // surface as a raw TypeError from inside decideNetworkMode — fail-closed, but diagnosing the
    // wrong layer. The negative assertion is the load-bearing half: parseSandboxPolicy could be
    // imported and then not used on this path.
    const src = await read("packages/gateway/src/platform/sandbox/sandbox-wrapper.ts");
    expect(src).toMatch(/parseSandboxPolicy\(policyJson\)/);
    expect(src).not.toMatch(/JSON\.parse\([^)]*\)\s+as\s+SandboxPolicy/);
  });

  test("wrapServerSpec routes the sandbox hop through selfSpawn, carrying the inner command", async () => {
    // The I15 wrapper used to be `process.execPath` + a path to sandbox-wrapper.ts, which does not
    // exist inside a compiled binary. It now re-executes the gateway in its `__nimbus-sandbox`
    // role. Assert the new mechanism so a regression to a source-path spawn fails here, not in a
    // released binary.
    const src = await read("packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts");
    expect(src).toMatch(
      /selfSpawn\(\s*"sandbox"\s*,\s*\[\s*spec\.command\s*,\s*\.\.\.spec\.args\s*\]/,
    );
    // Strip comments before the negative assertion: the docblock legitimately NAMES the old
    // sandbox-wrapper.ts path while explaining why it is gone. Asserting against prose would fail
    // on an accurate comment and pass on a regression that quietly restored the source-path spawn.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/sandbox-wrapper\.ts/);
  });

  test("every ServerSpec literal under lazy-mesh is enclosed by a wrapping call", async () => {
    // This used to be a four-file loop asserting `expect(src).toMatch(/wrapServerSpec\s*\(/)` —
    // one TOKEN, anywhere in the file. Two things were wrong with it.
    //
    // Granularity: `connector-spawns.ts` funnels 26 MCPClient spawns through a single `wrap`
    // helper, so its `wrapServerSpec(` token survives ANY per-site removal. Dropping the wrapper
    // from one connector left the file matching, the static D10 rule matching (it short-circuited
    // per file too), and that connector's spawner test green — none of the 15 affected spawner
    // describes assert `.command`. The child would run with a live OAuth token in its env and no
    // landlock/seccomp/seatbelt profile, past three green gates.
    //
    // Coverage: the hardcoded four omitted `chatops-bot-spawn.ts`, which has two real spawn sites.
    // A hand-maintained file list is a second thing to keep in sync, and it had already drifted.
    //
    // So this now derives the sites and delegates to the same per-site checker the static rule
    // uses, over every production file in the directory — including any added later.
    const dir = resolve(REPO_ROOT, "packages/gateway/src/connectors/lazy-mesh");
    const files = (await readdir(dir, { recursive: true })).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    const entries = await Promise.all(
      files.map(async (f) => ({
        relPath: `packages/gateway/src/connectors/lazy-mesh/${f.replaceAll("\\", "/")}`,
        contents: await readFile(resolve(dir, f), "utf8"),
      })),
    );

    // Non-vacuity first: an empty or mis-globbed scan satisfies `toHaveLength(0)` just as well as
    // a compliant tree, and the whole point of this block is that a silently-empty check reads
    // identical to a passing one.
    const specSites = entries.reduce(
      (n, e) => n + (e.contents.match(/\.\.\.\s*connectorSpawn\s*\(/g) ?? []).length,
      0,
    );
    expect(entries.length).toBeGreaterThanOrEqual(13);
    expect(specSites).toBeGreaterThanOrEqual(70);

    expect(checkWrapServerSpecInvariant(entries)).toEqual([]);
  });
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

  test("allowlist_exact_size assertion is 105", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*105\s*\)/);
  });

  test("connector.list stays absent; connector.listStatus is the served one", async () => {
    // By NAME, because the count cannot protect a removal: swapping `connector.list` back in for
    // any other entry keeps the length at 105 and sails through. It was allowlisted with no
    // handler behind it from the day it was added, so the desktop got -32601 on every call; the
    // live resolution test in ipc/allowlist-resolves.test.ts is what caught it, and this pins the
    // specific regression that test would then have to re-catch.
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toMatch(/^\s*"connector\.list",\s*$/m);
    expect(rust).toMatch(/^\s*"connector\.listStatus",\s*$/m);
  });

  // The count above is NOT sufficient on its own — a one-for-one substitution (e.g.
  // agents.ownership swapped out for the LAN-forbidden ownership.refresh, which clears and
  // re-derives every ownership edge) leaves the count unchanged and would sail through. Name
  // the methods, mirroring the Rust-side `allowlist_ownership_brief_only` test.
  test("S1 ownership: agents.ownership is renderer-exposed; ownership.refresh stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toContain("agents.ownership");
    expect(rust).not.toMatch(/^\s*"ownership\.refresh",\s*$/m);
  });

  // The count above is NOT sufficient on its own. A change that removes
  // agents.decisions and adds decisions.refresh — LAN-forbidden, and the verb
  // that can clear the whole decision store via decisions.rebuild — leaves the
  // count unchanged and would sail through. Name the methods.
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

  // The count above is NOT sufficient on its own — a one-for-one substitution (e.g.
  // agents.premortem swapped out for the LAN-forbidden premortem.refresh, which has no rebuild
  // counterpart) leaves the count unchanged and would sail through. Name the methods, mirroring
  // the Rust-side `allowlist_premortem_brief_only` test.
  test("S1 pre-mortem: agents.premortem is renderer-exposed; premortem.refresh stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/^\s*"agents\.premortem",\s*$/m);
    expect(rust).not.toMatch(/^\s*"premortem\.refresh",\s*$/m);
    // …and the Rust side asserts the same thing at runtime, not just by count.
    expect(rust).toContain(`assert!(is_method_allowed("agents.premortem"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("premortem.refresh"));`);
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
  test("the federated gate CALLS isOperatorValid, and the RPC layer supplies it", async () => {
    // This was `read("federation/query-gate.ts")` + `expect(gate).toContain("isOperatorValid")`,
    // and the only occurrence of that string in `query-gate.ts` is its ctx TYPE field:
    //
    //   readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
    //
    // A type declaration, not a call. The assertion therefore held while the consult and its
    // wiring both lived in files the test never opened, and deleting the one line that supplies
    // `ctx.identity` left it green — query-gate.ts would be byte-identical.
    //
    // So: assert the CALL where it actually is, and the WIRING that feeds it.
    const commons = await read("packages/gateway/src/federation/_lib/gate-commons.ts");
    expect(commons).toMatch(
      /ctx\.identity\?\.enabled === true && !ctx\.identity\.isOperatorValid\(\)/,
    );

    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toMatch(/identity:\s*ctx\.identityGuard/);
  });

  test("the OVER-THE-WIRE federation path is given an identity guard, not just local IPC", async () => {
    // The gap this closes. `ctx.identity` reaches a federated gate from exactly two producers:
    // `ipc/server/dispatchers.ts` (local IPC) and `federation/federation-server.ts` (the LAN wire,
    // fed by `buildFederationLanServer`'s options in `platform/assemble.ts`). Only the first wired
    // it. So `undefined?.enabled === true` was false on every peer-facing answer and the check
    // never ran — a deprovisioned operator's gateway kept serving `federation.query`,
    // `auditExport`, `invoke` and `preflight` instead of failing closed. The guard fired only for
    // the owner querying their own machine, which is the one case it is not needed for.
    const assemble = await read("packages/gateway/src/platform/assemble.ts");
    // The LAN server's options object must carry it...
    expect(assemble).toMatch(/identityGuard:\s*\{\s*\n\s*enabled:\s*true,/);
    // ...and it must be LATE-BOUND. Identity boots after federation, so a captured store/issuer
    // would be permanently undefined; the holder is what makes it resolvable at call time.
    expect(assemble).toContain("identityBootRefHolder.current");

    const dispatchers = await read("packages/gateway/src/ipc/server/dispatchers.ts");
    expect(dispatchers).toContain("identityGuard");
  });

  test("the ONLY place an ID token is validated is identity/verifier.ts", async () => {
    // The other half of the test's own title, which previously asserted nothing at all: there is
    // no assertion about `verifier.ts`, `validateIdToken`, or the absence of a second validator
    // anywhere in the block. A title that promises a property the body does not check is worse
    // than a missing test — it reads, in a review, as covered.
    // Anchor on what the implementation ACTUALLY uses. The first version of this scan looked for
    // `jwtVerify(`, `verifyIdToken(` and `createRemoteJWKSet(` — jose's API, which this codebase
    // does not use. All three have zero production hits, so the scan could not fail: an inert
    // guard, added in the very change meant to remove inert guards. `verifier.ts` verifies RS256
    // through Bun WebCrypto, so `crypto.subtle.verify(` is the primitive that matters.
    const verifier = await read("packages/gateway/src/identity/verifier.ts");
    expect(verifier).toMatch(/export function isOperatorValid\b/);
    expect(verifier).toContain("validateIdToken(");
    expect(verifier).toContain("crypto.subtle.verify(");

    const offenders: string[] = [];
    const root = resolve(REPO_ROOT, "packages/gateway/src");
    for (const f of await readdir(root, { recursive: true })) {
      const rel = `packages/gateway/src/${f.replaceAll("\\", "/")}`;
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      if (rel.startsWith("packages/gateway/src/identity/")) continue;
      const src = await readFile(resolve(REPO_ROOT, rel), "utf8");
      // Verifying a token signature outside identity/ is the regression: a second validator with
      // its own idea of issuer, audience and clock skew is how one of them ends up laxer. The
      // WebCrypto primitive is listed first because it is the one in use; the jose spellings are
      // kept so adopting that library later cannot quietly open a second path.
      if (
        /crypto\.subtle\.verify\s*\(|\bjwtVerify\s*\(|\bverifyIdToken\s*\(|createRemoteJWKSet\s*\(/.test(
          src,
        )
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
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

  /**
   * Production `.ts` under `dir`, RECURSIVELY, as repo-relative-ish paths.
   *
   * Recursive on purpose, and shared on purpose. (b) walked subdirectories and (c) did not,
   * for no reason either invariant states — same regex, same tool ids, same D17 rule. `tribal/`
   * happens to be flat today, so (c) was complete by accident rather than by construction: one
   * `tribal/<anything>/foo.ts` and a `slack_chat_post` there would have walked straight past the
   * guard. A scan whose correctness depends on a directory staying flat is a scan that stops
   * working the day someone tidies up.
   */
  async function productionTsUnder(dir: string): Promise<{ rel: string; abs: string }[]> {
    const out: { rel: string; abs: string }[] = [];
    async function walk(d: string, rel: string): Promise<void> {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
        if (ent.isDirectory()) {
          await walk(resolve(d, ent.name), childRel);
          continue;
        }
        if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
        out.push({ rel: childRel, abs: resolve(d, ent.name) });
      }
    }
    await walk(dir, "");
    return out;
  }

  /** The two connector post tools D17 confines. */
  const POST_TOOLS = /\b(?:slack_chat_post|teams_chat_post)\b/;

  test("(b) no chatops module outside reply-dispatcher/transport references the connector post tools (D17)", async () => {
    const files = (await productionTsUnder(resolve(import.meta.dir, "chatops"))).filter(
      ({ rel }) => rel !== "reply-dispatcher.ts" && !rel.startsWith("transport/"),
    );
    const offenders: string[] = [];
    for (const { rel, abs } of files) {
      if (POST_TOOLS.test(await readFile(abs, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // Guard the guard, as I17's `toContain("query-gate.ts")` and D22's `_lib` floor already do:
    // every exclusion here is a filter, and a filter that swallowed the whole directory would
    // leave `offenders` empty and this test green while checking nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  test("(c) no tribal module references the connector post tools — suggestions only via the injected I23 send seam (D17)", async () => {
    const files = await productionTsUnder(resolve(import.meta.dir, "tribal"));
    const offenders: string[] = [];
    for (const { rel, abs } of files) {
      if (POST_TOOLS.test(await readFile(abs, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(5);
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
    capabilitiesDisabled: new Set(),
  };

  function gateWith(toml: string, sig: string, pubkeyB64: string): PolicyGate {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(pubkeyB64, "manual", 1);
    store.persist({ toml, sig, org: "acme", version: 1, source: "peer", fetchedAt: 1 });
    return new PolicyGate(store, baseline);
  }

  // The ai_v2 capability lockoff rides on I22's enforced view, so it needs I22's coverage too.
  test("(cap-1) a SIGNATURE-VERIFIED policy disabling code_execution reaches EnforcedPolicy", () => {
    const kp = generateEd25519Keypair();
    const toml = `[policy]
version=1
org="acme"
[policy.capabilities.ai_v2]
code_execution=false
`;
    const gate = gateWith(
      toml,
      signPolicy(toml, encodeBase64(kp.privkey)),
      encodeBase64(kp.pubkey),
    );
    expect(gate.enforced().capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("(cap-2) a TAMPERED policy cannot disable a capability", () => {
    // Same signature, body flipped. Rejected wholesale, so the gate falls back to the baseline
    // rather than honouring any value the forged body carried.
    const kp = generateEd25519Keypair();
    const good = `[policy]
version=1
org="acme"
[policy.capabilities.ai_v2]
code_execution=false
`;
    const sig = signPolicy(good, encodeBase64(kp.privkey));
    const forged = good.replace("version=1", "version=2");
    const gate = gateWith(forged, sig, encodeBase64(kp.pubkey));
    expect(gate.enforced().capabilitiesDisabled.has("code_execution")).toBe(false);
  });

  test("(cap-3) a capability disabled in the LOCAL baseline survives any policy", () => {
    // Resolution is a union, so no value a policy can carry removes an entry -- including a validly
    // signed `= true`, which parses to "disables nothing" rather than to a grant.
    const kp = generateEd25519Keypair();
    const toml = `[policy]
version=1
org="acme"
[policy.capabilities.ai_v2]
code_execution=true
`;
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 1,
      source: "peer",
      fetchedAt: 1,
    });
    const locked = new PolicyGate(store, {
      ...baseline,
      capabilitiesDisabled: new Set(["code_execution"]),
    });
    expect(locked.enforced().capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("(a) a tampered policy is rejected; the gate stays ungoverned (falls back to baseline)", () => {
    const kp = generateEd25519Keypair();
    const good = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(good, encodeBase64(kp.privkey));
    const tampered = good.replace("min_days=30", "min_days=99");
    const gate = gateWith(tampered, sig, encodeBase64(kp.pubkey));
    expect(gate.status().signatureValid).toBe(false);
    expect(gate.enforced().retentionDays).toBe(7); // baseline, NOT 99
  });

  test("(c) every production ToolExecutor is handed a policy overlay — none defaults silently", async () => {
    // I22's resolution has always been correct and, until 2026-08-16, entirely unread:
    // `EnforcedPolicy.hitlRequired` was computed as a monotonic union and `isHitlRequiredByPolicy`
    // existed to read it, with ZERO production callers. An admin could sign
    // `[policy.hitl] require = [...]`, watch it verify, and get no gate — the B1
    // "defined but never wired" shape, on a documented invariant.
    //
    // Now that `gate()` consults it, the risk moves to partial wiring: one executor built without
    // the overlay is a hole that looks exactly like the rest of the system working. So this pins
    // that EVERY production construction site states its choice — the real overlay, or the named
    // `NO_POLICY_OVERLAY`. Same reason `NULL_EGRESS_SINK` is named rather than `undefined` (I29):
    // a site that simply forgot should be visible, not defaulted.
    const root = resolve(REPO_ROOT, "packages/gateway/src");
    const sites: { file: string; args: string }[] = [];
    for (const f of await readdir(root, { recursive: true })) {
      const rel = `packages/gateway/src/${f.replaceAll("\\", "/")}`;
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      // Comments stripped first. Without it the sweep matches `executor.ts`'s own doc comment,
      // which SAYS `new ToolExecutor(...)` while explaining this very rule — a source-scanning
      // guard reporting on prose about itself. (It did, on the first run.)
      const src = stripComments(await readFile(resolve(REPO_ROOT, rel), "utf8"));
      let at = src.indexOf("new ToolExecutor(");
      while (at !== -1) {
        // Balanced scan: the argument list routinely contains nested calls such as
        // `makeEgressSink(index.getDatabase())`, which a non-nesting regex truncates.
        let depth = 0;
        let end = at + "new ToolExecutor".length;
        for (; end < src.length; end++) {
          const c = src[end];
          if (c === "(") depth++;
          else if (c === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        sites.push({ file: rel, args: src.slice(at, end + 1) });
        at = src.indexOf("new ToolExecutor(", end);
      }
    }

    // Non-vacuity: an empty sweep satisfies the filter below just as well as full compliance.
    expect(sites.length).toBeGreaterThanOrEqual(11);

    const unwired = sites
      .filter((s) => !/NO_POLICY_OVERLAY|policyHitl|isHitlRequiredByPolicy/.test(s.args))
      .map((s) => s.file);
    expect(unwired).toEqual([]);
  });

  test("(d) gate() ORs the overlay with the frozen set — it can add, never replace", async () => {
    // The behavioural proof lives in engine/executor-policy-hitl.test.ts. This is the shape
    // assertion that catches the refactor that would invert it: an `&&`, a ternary, or an
    // assignment would each turn a tighten-only ratchet into something a policy can loosen, which
    // is precisely what I2 says must be impossible.
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toContain(
      "const requiresHITL = HITL_REQUIRED.has(action.type) || this.requiredByPolicy(action.type);",
    );
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

describe("I33 — user code executes only behind the exec gate", () => {
  // The runtime complement to static rule D23. A second caller of `runConfined` would be a second
  // path from user-supplied code to a running process, which is the whole of what I33 forbids.
  test("runConfined is called only from exec-gate.ts (and defined in exec-run.ts)", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => /\brunConfined\s*\(/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(callers).toEqual([
      "packages/gateway/src/exec/exec-gate.ts",
      "packages/gateway/src/exec/exec-run.ts",
    ]);
  });

  // On Windows `degradedReason()` is non-null even when the runner is fully active -- it reports
  // the accepted per-host-filtering caveat. A gate keyed on it would refuse every Windows
  // execution forever: fail-closed, but total.
  test("the gate keys confinement on canConfine(policy), not a policy-independent probe", async () => {
    const code = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/exec/exec-gate.ts"), "utf8"),
    );
    // Ask "can you confine THIS policy?" -- neither policy-independent probe is correct.
    // `isFullyActive()` is wrong on Linux, where it reports a helper used ONLY for per-host
    // network filtering that a no-network policy never touches; gating on it made the capability
    // unusable on every Linux box lacking that helper, CI included.
    expect(code).toContain("canConfine(policy)");
    expect(code).not.toMatch(/degradedReason\(\)\s*===\s*null/);
    expect(code).not.toMatch(/!\s*deps\.runner\.isFullyActive\(\)/);
  });

  // The Linux relaxation must stay policy-AWARE in the direction that matters: a network-bearing
  // policy still requires the helper. If canConfine collapses to `return null`, "no network needs
  // no helper" has silently become "nothing is ever checked".
  test("Linux still requires the helper for a network-bearing policy", async () => {
    const code = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/platform/sandbox/linux.ts"), "utf8"),
    );
    expect(code).toMatch(/canConfine[\s\S]{0,400}permissions\.network\.length === 0/);
    expect(code).toMatch(/canConfine[\s\S]{0,400}helper\.available/);
  });

  // Empty-by-construction is the property; a caller-supplied network list must be REFUSED, not
  // quietly dropped, or "no network" becomes a convention rather than a guarantee.
  test("exec-policy refuses a requested network grant rather than dropping it", async () => {
    const { buildExecPolicy } = await import("./exec/exec-policy.ts");
    const abs = process.platform === "win32" ? "C:\\tmp" : "/tmp";
    expect(() =>
      buildExecPolicy("i33", { fsRead: [abs], fsWrite: [], network: ["x.com"] }),
    ).toThrow();
    expect(buildExecPolicy("i33", { fsRead: [abs], fsWrite: [] }).permissions.network).toEqual([]);
  });

  // `not_required` on a code.execute row would read as "this ran without needing approval".
  test("the gate never records a code.execute row as not_required", async () => {
    const code = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/exec/exec-gate.ts"), "utf8"),
    );
    expect(code).not.toContain('"not_required"');
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

  test("D22 confines connectors.dispatch to executor.ts, the egress append to egress/*, the agent brief append to agents-rpc.ts, emitter imports to agents-rpc.ts, and registerRoute to llm/registry.ts", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D22-connectors-dispatch");
    expect(audit).toContain("D22-egress-append");
    expect(audit).toContain("D22-agent-brief-egress");
    expect(audit).toContain("D22-agent-emitter-import");
    // (e) — the route-table chokepoint. Unlike (a), this one does NOT rest on its own name alone:
    // the "checker actually rejects an unwrapped route registration" test below drives
    // `checkEgressChokepointConfinement` directly, so a deleted rule body fails there too.
    expect(audit).toContain("D22-register-route");

    // The five assertions above are string-presence checks, and all five of those strings are
    // `rule:` literals INSIDE the check functions — so they scan for a token that lives in the
    // definition being scanned for. Deleting the `run()` block that INVOKES the checks leaves
    // every one of them green while `audit:invariants` stops executing D22 entirely.
    //
    // Rules (b), (c) and (e) survive that by luck or by design: (b) and (c) each have an
    // independent tree-scan further down this file, and (e) is driven directly through
    // `checkEgressChokepointConfinement` by the "rejects an unwrapped route registration" test.
    // Rule (a), the `connectors.dispatch` confinement, has none — so its only enforcement is
    // the invocation, and its only assertion was the presence of its own name.
    //
    // Same wiring shape as the scan-floor assertion in the audit script's own suite: prove the
    // function is CALLED, not merely that it exists.
    // Assert the INDEX, not the slice. `indexOf` returning -1 makes `slice(-1)` the last character
    // of the file — non-empty, so `expect(runBody).not.toBe("")` passes and the failure that
    // follows reads as "the invocation is missing" when the real cause is that `run` was renamed
    // or removed.
    const runAt = audit.indexOf("async function run(");
    expect(runAt).toBeGreaterThan(-1);
    const runBody = audit.slice(runAt);
    for (const invocation of [
      "checkEgressChokepointConfinement(files)",
      "checkAgentEmitterImportConfinement(files)",
      // D10-wrap-spec is per-SITE as of #1219, which makes its invocation worth pinning too:
      // it is the only thing standing between a dropped `wrap(` and an unsandboxed MCP child.
      "checkWrapServerSpecInvariant(files)",
    ]) {
      expect(runBody).toContain(invocation);
    }
  });

  test("D22(d): the emitter-import rule flags ALL THREE module-resolution forms", async () => {
    // Rule (c) pins the CALLER of the appender, which catches a second file ACQUIRING the appender
    // — but not a second file that serves a brief WITHOUT calling it. That path spells nothing (c)
    // matches: it would append no row, serve the brief, and leave audit:invariants green. This file
    // predicted that gap in prose before it was closed; rule (d) closes it.
    //
    // Both forms are required. A static-only regex is defeated by the one-character change from
    // `import x from "…"` to `await import("…")` — a bypass hiding in plain sight, and the reason
    // this asserts the two constants exist rather than trusting one pattern to cover both.
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D22_EMITTER_STATIC_RE");
    expect(audit).toContain("D22_EMITTER_DYNAMIC_RE");
    // `require` is the third spelling, and Bun honours it from a .ts module — a rule matching only
    // the two `import` forms reported green while that door stood open.
    expect(audit).toContain("D22_EMITTER_REQUIRE_RE");

    // ...and the rule is exercised, not merely declared. A name-presence assertion passes for a
    // regex that is defined and never wired into the check, which is exactly the state this rule
    // was in before the `require` gap was closed. Each form is planted and the audit must flag it.
    for (const contents of [
      'import { emitWhyBrief } from "../agents/why.ts";',
      'const m = await import("../agents/why.ts");',
      'const m = require("../agents/why.ts");',
    ]) {
      const violations = checkAgentEmitterImportConfinement([
        { relPath: "packages/gateway/src/ipc/http-server.ts", contents: `${contents}\n` },
      ]);
      expect({ contents, flagged: violations.map((v) => v.rule) }).toEqual({
        contents,
        flagged: ["D22-agent-emitter-import"],
      });
    }
    // The negative control: the allowed door and the excluded `_lib` path must NOT be flagged, or
    // the loop above would pass for a rule that simply rejects everything.
    expect(
      checkAgentEmitterImportConfinement([
        {
          relPath: "packages/gateway/src/ipc/agents-rpc.ts",
          contents: 'import { emitWhyBrief } from "../agents/why.ts";\n',
        },
        {
          relPath: "packages/gateway/src/federation/peer-fanout.ts",
          contents: 'import type { GapNote } from "../agents/_lib/findings.ts";\n',
        },
      ]),
    ).toEqual([]);
    expect(audit).toContain("checkAgentEmitterImportConfinement");
  });

  test("D22(d): agents/_lib re-exports no emitter — the gap the import regex cannot see", async () => {
    // A regex over import SPECIFIERS does not follow re-export chains. Were an emitter re-exported
    // through `agents/_lib/`, a file could import it from the EXCLUDED path and rule (d) would miss
    // — the same shape as D22's recorded wrapper/façade limit. That gap is closed by ASSERTION
    // here, not by trusting the import rule to cover something it structurally cannot.
    //
    // Resolved from REPO_ROOT (which derives from import.meta.dir), never the process CWD: a
    // CWD-relative read passes from the repo root and throws ENOENT under CI's sharded runner,
    // which is how a guard ends up dead in the only place it has to work.
    const libDir = resolve(REPO_ROOT, "packages/gateway/src/agents/_lib");
    const entries = await readdir(libDir);
    const offenders: string[] = [];
    for (const f of entries) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = await readFile(resolve(libDir, f), "utf8");
      // Any re-export whose specifier climbs out of _lib and back into agents/ itself.
      if (/export\s[^;]*from\s+["'`]\.\.\/[A-Za-z][\w-]*\.ts["'`]/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    // Guard the guard: if the directory scan finds nothing, the assertion above is vacuous.
    expect(entries.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(5);
  });

  test("I29: the D22 comment does not claim totality it cannot enforce", async () => {
    // D22 matches a literal string; it cannot see `inner.dispatch(action)`. Claiming otherwise is
    // the defect Phase 1 fixes — a label that leads its mechanism.
    const src = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(src).not.toContain("no escape hatch");
    expect(src).toContain("matches the literal string");
  });

  test("appendEgressEntry( is called only from files under packages/gateway/src/egress/", async () => {
    // A source scan of the CALL form, not the bare identifier: matching `appendEgressEntry\(`
    // (with the open paren) means an import (`import { appendEgressEntry } from ...`) or a
    // comment mentioning the name cannot satisfy — or falsely trip — this guard. Only an actual
    // invocation counts. Scans production `.ts` AND `.tsx` (fix 4 — `packages/gateway/src` has no
    // `.tsx` today, so this is forward-looking hardening; without it, a future `appendEgressEntry(`
    // call in a production `.tsx` outside `egress/` would silently bypass this guard by extension
    // alone) and excludes `.test.ts`/`.test.tsx`. The relative path is derived via `relative()` +
    // `sep` from `node:path` rather than manual slicing/backslash normalization, so it holds up
    // across platforms. Mirrors the production D22 static audit's scope
    // (`checkEgressChokepointConfinement` in check-nimbus-invariants.ts), which also exempts
    // test files — egress-adjacent tests (e.g. `ipc/egress-rpc.test.ts`) legitimately call
    // it directly to seed fixture rows.
    const dir = resolve(REPO_ROOT, "packages/gateway/src");
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isSourceFile = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
      const isTestFile = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
      if (!isSourceFile || isTestFile) continue;
      const parentDir = "path" in entry && typeof entry.path === "string" ? entry.path : dir;
      const abs = resolve(parentDir, entry.name);
      const relFromGatewaySrc = relative(dir, abs).split(sep).join("/");
      const contents = await readFile(abs, "utf8");
      if (contents.includes("appendEgressEntry(") && !relFromGatewaySrc.startsWith("egress/")) {
        offenders.push(relFromGatewaySrc);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("I29/D22(c): recordAgentBriefEgress is named by exactly two production files", async () => {
    // The MCP brief chokepoint is TOTAL only if the appender has one caller. Scanned the same way
    // as the `appendEgressEntry(` guard above — a `readdir` walk of production `.ts`/`.tsx` under
    // `packages/gateway/src`, with `relative()` + `sep` so the paths hold up on every platform —
    // rather than shelling out to `rg`, which is not guaranteed present on a CI runner.
    //
    // The BARE identifier is matched, not the call form: a file that merely imports the appender
    // has already acquired the capability. That is the same regex the production D22 rule (c)
    // uses, with ONE deliberate difference — the static audit strips comments first, this scan
    // does not. So naming the appender in a doc comment elsewhere fails HERE and not there. That
    // asymmetry is the conservative direction and is kept on purpose (it also keeps this guard
    // free of a comment-stripper of its own to drift); refer to the module path
    // `egress/agent-brief-egress.ts` in prose rather than the bare symbol.
    const dir = resolve(REPO_ROOT, "packages/gateway/src");
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const namers: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isSourceFile = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
      const isTestFile = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
      if (!isSourceFile || isTestFile) continue;
      const parentDir = "path" in entry && typeof entry.path === "string" ? entry.path : dir;
      const abs = resolve(parentDir, entry.name);
      const contents = await readFile(abs, "utf8");
      if (contents.includes("recordAgentBriefEgress")) {
        namers.push(relative(dir, abs).split(sep).join("/"));
      }
    }
    expect(namers.sort()).toEqual(["egress/agent-brief-egress.ts", "ipc/agents-rpc.ts"]);
  });

  test("I29: the MCP brief append runs BEFORE the dispatch and is not swallowed", async () => {
    // Ordering and the absence of a try/catch are the whole property: an append that runs after
    // the handler, or one whose failure is caught, records a brief that has already been served.
    //
    // The scanned region runs from the FUNCTION HEADER to the dispatch, not from the append to the
    // dispatch. An append-to-dispatch window plus a `catch` check was evadable twice over: a `try
    // {` opened before the append with its `catch` placed after the dispatch sits entirely outside
    // such a window at both ends, so neither the opener nor the handler is ever looked at. Widening
    // the region is what makes the added `try` assertion bite; the `try` assertion alone on the
    // narrow window would have proved nothing.
    const src = await read("packages/gateway/src/ipc/agents-rpc.ts");
    const fnAt = src.indexOf("export async function dispatchAgentsRpc(");
    const appendAt = src.indexOf("recordAgentBriefEgress(ctx.db");
    const dispatchAt = src.indexOf("dispatchByMethod<AgentsRpcContext>");
    expect(fnAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(fnAt).toBeLessThan(appendAt);
    expect(appendAt).toBeLessThan(dispatchAt);
    const guardedRegion = src.slice(fnAt, dispatchAt);
    expect(guardedRegion).not.toContain("catch");
    expect(guardedRegion).not.toContain("try");
    // The ledgered set is the SERVED set: the append is gated on membership of the handler map the
    // dispatch itself consumes, never on the `agents.` namespace prefix. Prefix-gating appended an
    // `authorized` row for an unrecognised method that then failed -32601, so `nimbus prove`
    // over-counted, and it admitted an unbounded caller-controlled `method` into a hashed,
    // append-only column (`payload_summary` is capped at 256 bytes; `method` is not).
    expect(guardedRegion).toContain("Object.hasOwn(AGENTS_RPC_HANDLERS, method)");
    expect(guardedRegion).not.toContain('method.startsWith("agents.")');
    // The caller kind is server-derived (`ctx.caller`), never read out of the RPC params. The
    // condition is a lookup over a TOTAL map rather than an equality on one transport, so a new
    // client kind is a compile error rather than a silently unledgered surface — see
    // egress/egress-bearing-kinds.ts.
    expect(src).toContain("egressSourceTypeForClientKind(ctx.caller?.kind)");
    // ...and the kind is never reconstructed from the payload. Asserted as an absence because the
    // presence check above would still pass if a params-derived fallback were added beside it.
    expect(src).not.toMatch(/params\s*\.\s*kind/);
    expect(src).not.toMatch(/\bp\.kind\b/);
  });

  test("I29: COVERAGE_CLASSES is exactly the non-marker source types", () => {
    // The two lists are separate declarations, so a tenth source type can land in one and not the
    // other. That mismatch is silent: an egress-bearing class with no coverage entry is never
    // claimed and never noticed. This is the assertion that makes adding a class a deliberate act.
    // Compared as plain strings: the two arrays have different (deliberately non-overlapping)
    // literal-union element types, so `toEqual` would not typecheck on the narrow types.
    const nonMarker: string[] = EGRESS_SOURCE_TYPES.filter((t) => !MARKER_SOURCE_TYPES.has(t));
    const classes: string[] = [...COVERAGE_CLASSES];
    expect(classes.sort()).toEqual(nonMarker.sort());
  });

  test("I29: every coverage class claiming non-none has a landed appender", () => {
    // `mcp` and `http` are per-call because recordAgentBriefEgress serves BOTH transports and its
    // dispatcher condition ships in the same commit as this claim. `sync` is now `per-run`: BOTH of
    // its injection seams (`sync/scheduler.ts`'s `appendSyncEgress`, `sync/targeted-fetch.ts`'s
    // `appendEgress`) are wired in the same commit as this raise — `platform/assemble.ts`'s only
    // production `new SyncScheduler(...)` passes `appendSyncEgress`, and it is the sole builder of
    // `targetedFetch`'s deps — both closures around ONE appender, `egress/sync-egress.ts`'s
    // `recordSyncEgress`. `per-run`, not `per-call`, because the scheduler side appends ONE row per
    // paginated run (many upstream calls), the weaker of the two shapes this class actually backs.
    // `model` is now the FIFTH non-`none` class, backed by THREE appenders: the route-table
    // provider wrapper (`egress/model-egress.ts`'s `wrapLedgeredProvider`, applied at
    // `LlmRegistry.addRoute`, covering `LlmRouter.generate`/`generateMarkdown`/every
    // `selectProvider()` caller — synthesis among them, via `agents/_lib/synthesis-llm.ts` under
    // `[agents] synthesis = "local"` or `"allow-remote"`, reached in production from
    // `ipc/server/dispatchers.ts` and `agent-runs/agent-http-invoke.ts`'s
    // `buildAgentSynthesisRunner`); the Mastra engine agent (`egress/mastra-model-egress.ts`'s
    // `wrapLedgeredMastraModel`, since that agent resolves its model through `@mastra/core` outside
    // the route table entirely); and remote embeddings (`egress/embedding-egress.ts`'s
    // `wrapLedgeredEmbedder`, applied at each of the embedding pipeline's three construction sites).
    // The local-vs-remote split is enforced INSIDE each wrapper — derived from `provider.isLocal` /
    // the embedder's own locality, never a caller-supplied boolean — so a wiring mistake at a call
    // site cannot fabricate a `model` row for a local generation or embed. It is `per-call` over all
    // three, and the class now carries no NAMED exclusion: a local provider, a locally-run Mastra
    // model, or a local embedder (MiniLM) each append nothing by design, not as a gap — that is the
    // bound that survives, not a claim that no vector or prompt can ever leave unrecorded.
    // `chatops` is now the SIXTH non-`none` class, per-call, and unlike `mcp`/`http` it is NOT
    // narrower than its name: its appender (`egress/chatops-egress.ts`'s `buildLedgeredChatPosts`)
    // decorates the single `post` closure that every chat consumer shares, so one row is appended
    // per outbound post regardless of which consumer sent it.
    // `browser` stays `none`, DELIBERATELY, even though its appender is written and tested
    // (`egress/browser-egress.ts`'s `wrapLedgeredBrowserContext`, a decorator over the driven
    // `BrowserContext`). It has NO production caller: the computer-use browser driver that would
    // construct a `BrowserContext` is deferred (re-planned against raw CDP after `playwright-core`
    // failed a `bun build --compile` gate — invariant I35). Raising this entry ahead of that
    // landing would be precisely the defect this vector exists to prevent — the same rule every
    // other class here follows, applied to this one instead of an exception to it. (An earlier
    // version of this test DID raise it early, on the reasoning that the appender's own commit
    // would follow immediately; it did not, because the driver task was re-planned mid-slice. The
    // fix restores `browser` to `none` here; raising it again is conditioned on a real caller,
    // landed in the same commit, exactly like `peer`/`session` below.)
    // `peer`/`session` stay `none` until THEIR appenders land — raising an
    // entry without a landed appender behind it is a review moment, not a test to re-bank. (An
    // earlier version of this comment pointed to an `EgressCompleteness.tier` #1057 note in
    // `egress/egress-verify.ts` for whoever landed the fifth class to read; that field existed and
    // was removed in #1057 per `docs/CHANGELOG.md`'s 2026-08-11 entry — "`EgressCompleteness.tier`
    // is gone; the coverage vector is the only claim" — so the pointer was stale, not fictional, and
    // there was nothing left in that file to settle or re-defer.)
    const claimed = COVERAGE_CLASSES.filter((c) => THIS_BINARY_COVERAGE[c] !== "none");
    expect([...claimed].sort()).toEqual(["chatops", "http", "mcp", "model", "sync", "task"]);
  });

  test("the executor's egress sink is a REQUIRED constructor parameter", async () => {
    // A required parameter makes an unwired sink a compile error rather than a silent no-op. The
    // named NULL_EGRESS_SINK keeps the "this executor performs no egress" decision on the record.
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toContain("private readonly egressSink: EgressSink,");
    expect(src).not.toContain("private readonly egressSink?: EgressSink,");
  });

  test("I29: runAsk's egress sink is a REQUIRED field, and the getDatabase-guarded NULL_EGRESS_SINK fallback is gone", async () => {
    // runAsk is the agent-action path (nimbus ask / agent.invoke / the ChatOps read path) — the
    // most dispatch-capable path in the product, and the one `nimbus prove` itself exercises. It
    // used to silently substitute NULL_EGRESS_SINK whenever `p.localIndex.getDatabase` wasn't a
    // function, which meant a real dispatch could execute with zero ledger rows and no signal.
    // `RunAskParams.egressSink` is now a required field, consumed directly (`p.egressSink`) — the
    // file no longer imports `makeEgressSink`/`NULL_EGRESS_SINK` as VALUES (only `EgressSink` as a
    // type) or constructs a sink itself, so it cannot silently manufacture a no-op fallback.
    const src = await read("packages/gateway/src/engine/run-ask.ts");
    expect(src).toContain("egressSink: EgressSink;");
    expect(src).not.toContain("egressSink?: EgressSink");
    expect(src).toContain("p.egressSink");
    // Neither NULL_EGRESS_SINK nor makeEgressSink is imported as a VALUE from egress-ledger.ts —
    // only the EgressSink TYPE is imported — so the file has nothing to build a fallback sink from.
    // (Matched against the import line specifically: both names legitimately appear in doc-comment
    // prose above, e.g. "a caller ... must pass `NULL_EGRESS_SINK` explicitly".)
    expect(src).not.toMatch(
      /import\s*\{[^}]*(NULL_EGRESS_SINK|makeEgressSink)[^}]*\}\s*from\s*"\.\.\/egress\/egress-ledger\.ts"/,
    );
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

  // The route table is the boundary the model-class appender sits on. A file that calls
  // `registerRoute` directly enters that table WITHOUT `addRoute`'s `wrapLedgeredProvider`,
  // so its provider would generate with no ledger row -- I29's `model` class silently
  // incomplete, with the static audit green.
  test("I29/D22(e): registerRoute is named only by registry.ts and its own definition", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => /\bregisterRoute\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(callers).toEqual([
      "packages/gateway/src/llm/registry.ts",
      "packages/gateway/src/llm/router.ts",
    ]);
  });

  // D22(e) stops a SECOND file entering the route table unwrapped. This stops the ONE
  // permitted file entering it with nothing to ledger to: `addRoute` hands `this.db` to
  // `wrapLedgeredProvider`, so an optional `db` meant a registry could exist that could not
  // record egress. That was a runtime refusal until 2026-08-28 and is now a type error --
  // asserted here on the SOURCE, because a type error is invisible to a runtime suite and
  // would otherwise be pinned nowhere the invariant's own tests can see.
  test("I29: LlmRegistryOptions.db is non-optional, so an unledgerable registry cannot exist", async () => {
    // Resolved from REPO_ROOT, never cwd — every other file-reading helper here does the
    // same. A bare relative path passes locally (repo root) and fails in the coverage step,
    // which runs with a different working directory: ENOENT, not a real invariant breach.
    const src = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/llm/registry.ts"), "utf8"),
    );
    const optionsBlock = /export type LlmRegistryOptions = \{([\s\S]*?)\}/.exec(src)?.[1] ?? "";
    expect(optionsBlock).not.toBe("");
    // The whole assertion: `db: Database`, never `db?: Database`.
    expect(/\bdb\s*\?\s*:/.test(optionsBlock)).toBe(false);
    expect(/\bdb\s*:\s*Database\b/.test(optionsBlock)).toBe(true);
  });

  test("I29: the checker actually rejects an unwrapped route registration", () => {
    const violations = checkEgressChokepointConfinement([
      {
        relPath: "packages/gateway/src/platform/assemble.ts",
        contents: "router.registerRoute(provider, 'm');",
      },
    ]);
    expect(violations.map((v) => v.rule)).toContain("D22-register-route");
  });

  test("I29: every remote-embedder construction site wraps with the appender", async () => {
    // Rule (f) stops a NEW file calling the appender; this stops an EXISTING construction site
    // quietly dropping it. Asserted on source because the sites build real network clients.
    //
    // A plain `toContain("createOpenAIEmbedder")` + `toMatch(/wrapLedgeredEmbedder\(/)` pair --
    // the previous shape of this test -- proves only CO-OCCURRENCE: a SECOND, unwrapped
    // `createOpenAIEmbedder(...)` added anywhere else in the same file would satisfy both
    // assertions while the second call shipped un-ledgered. Delegating to
    // `checkEmbeddingConstructorConfinement` proves ASSOCIATION instead -- every call is
    // paren-matched as textually nested inside a `wrapLedgeredEmbedder(...)` argument list --
    // against the REAL file contents, so this fails the moment a real site regresses.
    const sites = [
      "packages/gateway/src/embedding/create-routing-runtime.ts",
      "packages/gateway/src/embedding/create-embedding-runtime.ts",
      "packages/gateway/src/ipc/index-reembed-rpc.ts",
    ];
    for (const rel of sites) {
      const contents = await readFile(resolve(REPO_ROOT, rel), "utf8");
      const violations = checkEmbeddingConstructorConfinement([{ relPath: rel, contents }]);
      expect(violations).toEqual([]);
    }
  });

  test("I29: an unwrapped createOpenAIEmbedder call in an approved file is still caught", () => {
    // The regression this closes: the allow-list used to skip ALL checking once a file's path
    // matched, so a SECOND, bare `createOpenAIEmbedder(...)` added to an already-approved file
    // -- as opposed to a brand-new file -- was invisible to every guard. This fixture is exactly
    // that shape: a real appender call earns the file its place on the allow-list, and a second,
    // unwrapped construction sits right beside it, unassociated with any `wrapLedgeredEmbedder`.
    const unwrappedFixture = [
      "const wrapped = wrapLedgeredEmbedder(db, await createOpenAIEmbedder({ apiKey }));",
      "const rogue = await createOpenAIEmbedder({ apiKey: other });",
    ].join("\n");
    const violations = checkEmbeddingConstructorConfinement([
      {
        relPath: "packages/gateway/src/embedding/create-routing-runtime.ts",
        contents: unwrappedFixture,
      },
    ]);
    expect(violations.map((v) => v.rule)).toEqual(["embedding-constructor-confined"]);
    expect(violations[0]?.snippet).toContain("rogue");
  });
});

describe("I34 — locality is declared once, and a cloud adapter can never claim to be local", () => {
  // Air-gap refusal AND the I29 `model` appender both read `provider.isLocal`. A wrong
  // `true` is one word and silent in both directions: the prompt leaves under a setting
  // that promised it would not, and no ledger row records that it did.

  test("a local runtime pointed at a LAN box is NOT local", () => {
    // Slice 1's fix. `base_url` is user-configurable and `[llm.local.*]` accepts a remote
    // host, so a hardcoded `true` here defeated `enforce_air_gap` entirely.
    expect(new OllamaProvider("http://192.168.1.50:11434", "m").isLocal).toBe(false);
    expect(new LlamaCppProvider("http://192.168.1.50:8080", "m").isLocal).toBe(false);
  });

  test("a local runtime on loopback IS local", () => {
    expect(new OllamaProvider("http://127.0.0.1:11434", "m").isLocal).toBe(true);
    expect(new LlamaCppProvider("http://localhost:8080", "m").isLocal).toBe(true);
  });

  test("locality is derived from the base URL, never from a vendor id", async () => {
    // One definition site. Three copies of this fact is what produced the hardcoded-env
    // bug in the Windows sandbox work; `LOCAL_PROVIDER_IDS` and its two duplicates were
    // deleted in slice 1 and must not come back.
    const files = await readDirFiles("packages/gateway/src");
    const offenders = files
      .filter((f) => /LOCAL_PROVIDER_IDS|LOCAL_PROVIDERS\s*=/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("every cloud adapter reports isLocal === false, even on a loopback base_url", () => {
    // The INVERSE of the local-runtime rule above, and the case slice 2a could not write because
    // no cloud adapter existed. A LiteLLM-style proxy on 127.0.0.1 FORWARDS to the vendor, so
    // deriving locality from the URL here would reopen the air-gap bypass slice 1 closed --
    // through the opposite door.
    const apiKey = async (): Promise<string | undefined> => "k";
    const baseUrl = "http://127.0.0.1:4000";
    expect(new AnthropicProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
    expect(new OpenAiProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
    expect(new GeminiProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
    expect(new XaiProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
  });

  test("no cloud adapter derives locality from the base URL", async () => {
    // Structural complement to the four value assertions above: a future adapter that imported
    // `isLoopbackBaseUrl` would be DERIVING locality, which is exactly the mistake I34 names.
    // Scoped to the cloud adapters -- the two local runtimes import it correctly and by design.
    const files = await readDirFiles("packages/gateway/src/llm");
    const offenders = files
      .filter((f) => /-provider.ts$/.test(f.rel) && !/^(ollama|llamacpp)-/.test(f.rel))
      .filter((f) => /isLoopbackBaseUrl/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("isLoopbackBaseUrl has exactly one definition site", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const definers = files
      .filter((f) => /export function isLoopbackBaseUrl\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`);
    expect(definers).toEqual(["packages/gateway/src/llm/base-url-locality.ts"]);
  });
});

describe("I30 — web-clipper token minting is fail-closed behind an owner-opened pairing window", () => {
  test("WRITE_ROUTE_ALLOWLIST is exactly the 14 sanctioned write routes (still includes the 2 clip routes)", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("./ipc/http-write-routes.ts");
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(14);
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
    ctl.open("dev", ["clip"]);
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

  test("the confirm route mints exactly the scopes recorded at open() — never from the request body", async () => {
    // Proves the minted scopes are server-derived from the pairing window, not caller-suppliable.
    // The confirming request carries only a `code`; if `runClipPairConfirmRoute` ever read scopes
    // from the request body (or hardcoded a list) instead of `confirmed.scopes`, this fails.
    const { dispatchWriteRoute } = await import("./ipc/http-write-routes.ts");
    const ctl = new PairingWindowController({ nowMs: () => 0, genCode: () => "222222" });
    ctl.open("dev-laptop", ["agents", "resolve"]);
    const mintCalls: Array<{ label: string; scopes: readonly ApiScope[] }> = [];
    const surface = {
      pairing: ctl,
      verifyToken: async () => null,
      mintToken: async (label: string, scopes: readonly ApiScope[]) => {
        mintCalls.push({ label, scopes });
        return "MINTED-TOKEN";
      },
      ingest: () => ({ id: "x", status: "created" as const }),
    };
    // The request body deliberately names a DIFFERENT scope set than the window holds, so a
    // regression that reads scopes from the body (instead of the window) is caught.
    const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "222222",
        scopes: ["clip", "briefs", "agents", "resolve", "fetch"],
      }),
    });
    const res = await dispatchWriteRoute(req, { ...baseInvariantWriteCtx(), clips: surface });
    expect(res.status).toBe(200);
    expect(mintCalls).toEqual([{ label: "dev-laptop", scopes: ["agents", "resolve"] }]);
  });

  test("a legacy bare-string vault entry verifies to exactly LEGACY_SCOPES", async () => {
    // Proves the read-time upgrade path: a pre-scopes token (a bare string in the vault map) must
    // verify to exactly clip+briefs — no more, no less.
    const vault = fakeVault({
      [CLIP_TOKENS_VAULT_KEY]: JSON.stringify({ chrome: "tok-legacy" }),
    });
    const verified = await verifyApiToken(vault, "tok-legacy");
    expect(verified).not.toBeNull();
    expect(verified?.scopes).toEqual(LEGACY_SCOPES);
  });
});

describe("I31 — disclosure integrity: a synthesized brief never says less than the deterministic one", () => {
  test("I31: a rewrite that drops every reserved section still ships them", async () => {
    const { synthesize } = await import("./agents/_lib/synthesize.ts");
    const brief: ExpertBrief = {
      kind: "expert",
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [{ category: "empty_index", detail: "I31-DISCLOSURE-SENTINEL" }],
      query: { topicOrFile: "src/x.ts" },
      ranked: [],
    };
    const runner = {
      run: async (_prompt: string) => ({
        ok: true as const,
        markdown: "# Expert\n\nEverything is fine and nothing is missing.",
        model: "test-model",
        remote: false,
      }),
    };
    const out = await synthesize(brief, { runner });
    expect(out.markdown).toContain("I31-DISCLOSURE-SENTINEL");
  });

  test("I31: the reserved registry is total over the brief union", async () => {
    // A fifteenth brief kind must be a compile error in `reserved-sections.ts`, not a silent
    // empty list. The runtime half of that claim: the registry has one entry per kind the
    // synthesize dispatch handles.
    const { RESERVED_HEADINGS_BY_KIND } = await import("./agents/_lib/reserved-sections.ts");
    const src = await read("packages/gateway/src/agents/_lib/synthesize.ts");
    const dispatched = [...src.matchAll(/brief\.kind === "([a-z]+)"/g)]
      .map((m) => m[1])
      .filter((kind): kind is string => kind !== undefined);
    const kinds = new Set(dispatched);
    expect(Object.keys(RESERVED_HEADINGS_BY_KIND).sort()).toEqual([...kinds].sort());
  });

  test("I31: every interleaved disclosure's anchor occurs in the line the renderer emits", async () => {
    // The Layer 2 (anchor-phrase) half of this invariant, for the disclosures that sit inside
    // prose the model rewrites and so cannot be held back as a whole section. Its failure mode
    // is an INERT anchor: a required phrase that no rendered line contains rejects every
    // synthesis of that brief, and one drawn from text the renderer no longer emits guards
    // nothing. Both are impossible only while the anchor is a substring of the line the SAME
    // constant produces, which is what this asserts — for every disclosure at once, rather
    // than per-site where a new one can be added without a matching check.
    const d = await import("./agents/_lib/brief-disclosures.ts");
    const { normalizeSectionText } = await import("./agents/_lib/markdown-sections.ts");
    const evidence = { refs: [], total: 0 };
    const ownership = d.negotiateOwnershipDisclosures({
      services: [],
      directories: [],
      lastPassAt: null,
      truncated: true,
      unmappedIdentitiesInIndex: 0,
    });
    const disclosures = [
      d.negotiateNotComputedDisclosure("Tickets"),
      d.negotiateWindowDisclosure(86_400_000, 0),
      ownership.truncation,
      ownership.accountability,
      d.negotiateIncidentsDisclosure({
        resolved: 0,
        assigned: 0,
        unattributable: 1,
        errorIssuesAssigned: 0,
        evidence,
      }),
      d.negotiateDecisionsDisclosure(
        { authored: 0, unattributable: 1, evidence },
        { personId: "p-1", source: "git", displayName: "Ann", isOther: false },
      ),
      d.glossaryProvenanceDisclosure("CDR", "snippet"),
      d.glossaryProvenanceDisclosure("CDR", "manual"),
      d.whyChangeSubjectDisclosure(),
    ].filter((x) => x !== undefined);
    // Fixture integrity: a builder whose predicate stops firing would drop out of this list
    // silently and the loop below would assert over fewer disclosures, still green.
    expect(disclosures).toHaveLength(9);
    for (const disclosure of disclosures) {
      // EVERY anchor must occur in its own line, not just the first (F27). An entry carrying two
      // sentences and one anchor was how a rewrite kept sentence 1, dropped sentence 2 and
      // shipped — the anchor it satisfied was not in the sentence that went missing.
      expect(disclosure.anchors.length).toBeGreaterThan(0);
      for (const anchor of disclosure.anchors) {
        expect(normalizeSectionText(disclosure.line)).toContain(normalizeSectionText(anchor));
      }
    }
  });

  test("I31: reserved blocks are constructed, never recovered by parsing the render", async () => {
    // The anti-pattern this invariant forbids. `reserved-sections.ts` must not scan rendered
    // markdown for its own headings — that is what makes untrusted brief content harmless.
    const src = await read("packages/gateway/src/agents/_lib/reserved-sections.ts");
    expect(src).not.toContain("sectionBody");
    expect(src).not.toContain("stripSections");
  });
});

describe("I32 — clip source metadata is whitelist-constructed, so a page cannot deny ingestion of its own clip", () => {
  const CLIP_BASE = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    capturedAt: 1750000000000,
  };

  test("an unrecognised sibling key is discarded, and the clip still ingests", async () => {
    const { ingestClip, validateClipInput } = await import("./clips/clip-ingest.ts");
    const { LocalIndex } = await import("./index/local-index.ts");
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const input = validateClipInput({
        ...CLIP_BASE,
        source: { author: "A", junk: "x".repeat(70_000) },
      });
      const res = ingestClip(db, input);
      expect(res.status).toBe("created");
      const row = db.query("SELECT metadata FROM item WHERE id = ?").get(res.id) as {
        metadata: string;
      };
      const stored = (JSON.parse(row.metadata) as { source: Record<string, unknown> }).source;
      expect(stored).toEqual({ author: "A" });
      expect(Object.keys(stored)).toEqual(["author"]);
    } finally {
      db.close();
    }
  });

  test("the discarded payload genuinely exceeds the store's ceiling (the counterfactual)", async () => {
    // The assertion that makes the test above a DENIAL fence rather than a shape check.
    // Without it, a junk blob UNDER RAW_META_MAX_BYTES would still satisfy `toEqual` while
    // proving nothing — which is exactly what an earlier draft of #1285 shipped, at 60 KB
    // (60,112 bytes against a 65,536 ceiling). Pin the arithmetic, not the intent.
    const { RAW_META_MAX_BYTES } = await import("./index/constants.ts");
    const junk = "x".repeat(70_000);
    const hadTheWhitelistNotRun = {
      tags: [],
      mode: "article",
      wordCount: 3,
      clippedAt: CLIP_BASE.capturedAt,
      source: { author: "A", junk },
    };
    const bytes = Buffer.byteLength(JSON.stringify(hadTheWhitelistNotRun), "utf8");
    expect(bytes).toBeGreaterThan(RAW_META_MAX_BYTES);
  });

  test("upsertIndexedItem really does throw above the ceiling (the mechanism is not assumed)", async () => {
    // Proves the denial is real end-to-end: hand the store the metadata the whitelist withheld
    // and watch it refuse. If the 64 KB guard were ever removed, this test goes green-by-absence
    // of a throw and fails — which is the regression this invariant exists to detect.
    const { upsertIndexedItem } = await import("./index/item-store.ts");
    const { LocalIndex } = await import("./index/local-index.ts");
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      expect(() =>
        upsertIndexedItem(db, {
          service: "nimbus",
          type: "web_clip",
          externalId: "clip:i32-counterfactual",
          title: "Hello",
          body: "The body text",
          modifiedAt: CLIP_BASE.capturedAt,
          syncedAt: CLIP_BASE.capturedAt,
          metadata: { source: { author: "A", junk: "x".repeat(70_000) } },
        }),
      ).toThrow(/exceeds 64 KB limit/);
    } finally {
      db.close();
    }
  });

  test("the validator CONSTRUCTS the source; it never passes the caller's object through", async () => {
    // The static half. A refactor that reintroduces a passthrough (`...o`, `...raw`, a cast of
    // the caller object to ClipSource, or `delete` on it) restores the un-ingestable-clip denial
    // even though every per-field bound still reads correctly.
    const src = stripComments(await read("packages/gateway/src/clips/clip-ingest.ts"));
    const fn = src.slice(src.indexOf("function validateClipSource"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("const source: ClipSource = {");
    expect(body).not.toContain("...o");
    expect(body).not.toContain("...raw");
    expect(body).not.toContain("delete ");
    expect(body).not.toMatch(/as ClipSource/);
  });

  test("every ClipSource field is read by name and bounded", async () => {
    // A sixth field added to the interface but never read here would be silently dropped —
    // annoying but safe. A field read WITHOUT a bound is the unsafe direction, so assert each
    // of the five goes through one of the three bounding helpers.
    const src = stripComments(await read("packages/gateway/src/clips/clip-ingest.ts"));
    expect(src).toMatch(/const author = boundedProse\(o\["author"\], SOURCE_PROSE_MAX\)/);
    expect(src).toMatch(/const siteName = boundedProse\(o\["siteName"\], SOURCE_PROSE_MAX\)/);
    expect(src).toMatch(/const lang = boundedExact\(o\["lang"\], SOURCE_LANG_MAX\)/);
    expect(src).toMatch(
      /const leadImage = boundedExact\(o\["leadImage"\], SOURCE_LEAD_IMAGE_MAX\)/,
    );
    expect(src).toMatch(/const publishedAt = epochMs\(o\["publishedAt"\]\)/);
  });
});

describe("I35 — computer-use actuation only inside an approved envelope", () => {
  test("performActuation is called only from cu-gate.ts (and defined ONCE in cu-actuate.ts)", async () => {
    // Review finding: the earlier version collected DISTINCT FILE PATHS containing a match, not
    // OCCURRENCE COUNTS — so a second, illegitimate direct call added anywhere else inside
    // `cu-actuate.ts` (which is already expected to appear once, for its own declaration) would
    // leave the file SET unchanged and this test would stay green. Counting matches per file, not
    // just membership, closes that — matching the same fix just applied to the static audit
    // (`check-nimbus-invariants.ts`'s `checkActuationConfinement`).
    const files = await readDirFiles("packages/gateway/src");
    const matchesByFile = new Map<string, number>();
    for (const f of files) {
      const n = (stripComments(f.contents).match(/\bperformActuation\s*\(/g) ?? []).length;
      if (n > 0) matchesByFile.set(`packages/gateway/src/${f.rel}`, n);
    }
    expect(Object.fromEntries(matchesByFile)).toEqual({
      "packages/gateway/src/computer-use/cu-actuate.ts": 1, // the declaration, exactly once
      "packages/gateway/src/computer-use/cu-gate.ts": 1, // the one legitimate call
    });
  });

  test("performActuation is never IMPORTED outside cu-gate.ts, under any alias", async () => {
    // Second review finding on the same test: a call-text scan (however precisely counted) is
    // defeated by an ALIASED import — `import { performActuation as invoke }` followed by
    // `invoke(lane, req)` contains no `performActuation(` call-shaped text anywhere, so the test
    // above would stay green while a second, unauthorized path to the host exists. Closed at the
    // IMPORT, not the call: no file other than the gate may import the symbol under any local
    // name — if it can never enter scope elsewhere, there is no alias left to call it through.
    // Same fix mirrored onto the static audit's `checkActuationConfinement`.
    const files = await readDirFiles("packages/gateway/src");
    const importers = files
      .filter((f) => f.rel !== "computer-use/cu-gate.ts")
      .filter((f) =>
        /\bimport\s*\{[^}]*\bperformActuation\b[^}]*\}\s*from/.test(stripComments(f.contents)),
      )
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(importers).toEqual([]);
  });

  test("no browser-driver import exists outside cu-lanes/", async () => {
    // `computer-use/cu-lanes/` (the browser driver's deferred home, see plan Task 9) does not
    // exist yet -- its library failed a compile gate and is being re-planned against raw CDP -- so
    // today's honest claim is narrower than "the driver is imported only under cu-lanes/": no
    // file ANYWHERE imports a playwright driver at all. Filtering to offenders OUTSIDE cu-lanes/,
    // rather than asserting a fixed non-empty allow-list, keeps this assertion true both now (zero
    // importers) and once the driver lands (one importer, correctly confined) -- it need not be
    // rewritten the day `cu-lanes/browser.ts` is created, only re-read to confirm it still holds.
    const files = await readDirFiles("packages/gateway/src");
    const offenders = files
      .filter((f) => !f.rel.startsWith("computer-use/cu-lanes/"))
      .filter((f) =>
        /(?:from\s*|import\s*\(\s*)["']playwright(?:-core)?["']/.test(stripComments(f.contents)),
      )
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(offenders).toEqual([]);
  });

  test("the classifier takes no model-supplied field", async () => {
    // I3 transplanted: the gate reads a property the gateway derived, never one the caller supplied.
    //
    // This scan has failed three different ways across three rounds, each a smarter version of the
    // last, each defeated by a different quoting construct. Recorded here so a future "simplify
    // this" pass does not reintroduce any of them:
    //
    //   1. A naive `indexOf("}", ...)` truncated at an inline object type's own closing brace
    //      (e.g. `readonly bounds: { w: number };`), ending the slice before a banned field that
    //      followed it.
    //   2. A brace-depth counter over RAW source fixed (1), but a `}` written inside PROSE (a
    //      JSDoc comment describing "the closing token `}`", say) still incremented the raw
    //      scanner's depth, ending the slice early the same way.
    //   3. A brace-depth counter over `stripComments`-only source fixed (2), but `stripComments`
    //      deliberately PRESERVES string-literal contents (a different helper's job), so a `}`
    //      inside a string literal (`readonly tag: "a}b";`) still closed the scan early.
    //
    // The fix composes the repo's own two strippers rather than hand-rolling string-awareness of
    // a fourth kind: `stripStringLiterals(stripComments(src))` removes comment text AND blanks
    // every quoted/template string body (preserving only `${...}` substitutions, which are real
    // code and whose braces must stay balanced) before the depth counter ever runs. This is "the
    // guard" the docs call out by name (a TS interface cannot be reflected at runtime), so its own
    // blind spots matter more than most -- do not narrow this composition back to one stripper.
    const rawSrc = await read("packages/gateway/src/computer-use/cu-classify.ts");
    const src = stripStringLiterals(stripComments(rawSrc));
    const start = src.indexOf("interface BrowserActionInput");
    const openBrace = src.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(-1);
    const iface = src.slice(start, end);
    // ALLOWLIST, not a denylist: red-proved that a denylist is the wrong shape for this guard.
    // `not.toContain("intent:")` (an earlier version of this check) is defeated by
    // `readonly modelIntent?: string;`, which contains `Intent:` — capital I, never matched by a
    // lowercase, colon-anchored substring search — and a denylist can only ever enumerate the
    // field NAMES someone already thought to ban, never the ones nobody has invented yet. This
    // repo's own rule is to write a guard as what CANNOT pass: parse the field names the interface
    // actually declares and assert the set is EXACTLY the five permitted ones. Any new field —
    // whatever it is called, whatever it is cased — fails until someone consciously widens the
    // allowlist below, which is the point: adding a model-controllable field is a decision, not an
    // accident this scan lets slide.
    //
    // Field names are read off `^\s*readonly (\w+)\??:` lines within the brace-depth-bounded
    // interface body — the same slice the old denylist scanned — so a JSDoc block that merely
    // MENTIONS a field name inside prose (e.g. "the closing brace `}`" or a `{@link foo}`) cannot
    // masquerade as a declared field: `stripComments` has already removed comment text from `src`
    // before this slice was taken, and the regex additionally requires the `readonly NAME?:`
    // shape a JSDoc construct never produces.
    const fields = [...iface.matchAll(/^\s*readonly (\w+)\??:/gm)]
      .map((m) => m[1] as string)
      .sort();
    expect(fields).toEqual(["currentOrigin", "kind", "node", "submitsForm", "targetOrigin"].sort());
  });

  test("no computer.* method is exposed to the Tauri renderer (I7)", async () => {
    const rs = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rs).not.toContain("computer.");
  });

  test("the browser lane never writes a screenshot to disk", async () => {
    // Spec § 7. The property this test is NAMED for is that captured screenshot bytes never reach
    // a persisting API anywhere in the file — not merely that one particular `screenshot(` call
    // site lacks a `path:` option. An earlier version of this test scanned only a 400-byte window
    // after the first `indexOf("screenshot(")` hit and asserted the window lacked `path:`; that
    // is redundant with the type system today (`BrowserLane.screenshot()` takes no parameters, so
    // a `path:` option there is already a compile error) and blind to the real hazard, red-proved
    // by inserting `await Bun.write("/tmp/leak.png", bytes);` right after the captured bytes and
    // returning their digest as before — the old test stayed green because the write sat past the
    // 400-byte window and the returned bytes were never the thing being scanned.
    //
    // This version scans the WHOLE file for every persisting API this repo uses to write bytes to
    // disk — `Bun.write`, `writeFile`/`writeFileSync`, `createWriteStream`, and any `fs.`-prefixed
    // write call — rather than a slice following one call site. `cu-lanes/browser.ts` (the
    // deferred driver, see plan Task 9) does not exist yet, so today's honest scan target is
    // `cu-actuate.ts`, the only file in the shipped surface that touches screenshot bytes at all.
    // Once the real driver lands at `cu-lanes/browser.ts`, this picks it up automatically and must
    // be re-verified there.
    //
    // `stripStringLiterals(stripComments(src))` is applied before scanning: `cu-actuate.ts`'s own
    // doc comment quotes `lane.screenshot(); return null;` as an example of a fixed defect, and a
    // raw-source scan for a persisting-API name could be defeated by exactly that kind of comment
    // (or by one hiding inside a string literal) — this repo has been bitten by that exact class of
    // false-negative three times over in the sibling classifier-field test below, which is why both
    // strippers are composed here too rather than a bespoke one-off check.
    // Absolute (REPO_ROOT-anchored), not a bare relative string: CI's coverage job `cd`s into
    // `packages/gateway` before running `bun test`, so a relative `Bun.file("packages/...")` call
    // resolves against the WRONG cwd there (ENOENT) even though it resolves fine from repo root —
    // exactly the failure this file's own `read()` helper exists to avoid everywhere else.
    const laneFile = resolve(REPO_ROOT, "packages/gateway/src/computer-use/cu-lanes/browser.ts");
    const target = (await Bun.file(laneFile).exists())
      ? laneFile
      : resolve(REPO_ROOT, "packages/gateway/src/computer-use/cu-actuate.ts");
    const rawSrc = await Bun.file(target).text();
    const src = stripStringLiterals(stripComments(rawSrc));
    // Sanity guard: the scan target must actually mention `screenshot(` at all, or this test would
    // vacuously pass against a file that no longer captures screenshot bytes.
    expect(src).toContain("screenshot(");
    const persistingApis = [
      /\bBun\.write\s*\(/,
      /\bwriteFileSync\s*\(/,
      /\bwriteFile\s*\(/,
      /\bcreateWriteStream\s*\(/,
      /\bfs\.\w*[Ww]rite\w*\s*\(/,
    ];
    for (const pattern of persistingApis) {
      expect(src).not.toMatch(pattern);
    }
  });
});
