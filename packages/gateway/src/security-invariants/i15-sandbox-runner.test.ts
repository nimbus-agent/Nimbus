import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkWrapServerSpecInvariant } from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { REPO_ROOT, read } from "../../test/helpers/security-invariants.ts";

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

  test("no sandboxed spawn runs in the data or config directory", async () => {
    for (const rel of ["platform/assemble/team-credentials.ts", "connectors/lazy-mesh/mesh.ts"]) {
      const src = await read(`packages/gateway/src/${rel}`);
      expect(src).not.toMatch(/sandboxCwd:\s*paths\.dataDir/);
      expect(src).not.toMatch(/\bcwd:\s*paths\.(dataDir|configDir)/);
      expect(src).toMatch(/sandboxCwd:\s*paths\.sandboxDir/);
    }
    const wrap = await read("packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts");
    expect(wrap).toMatch(/sandboxCwdFor\(/);
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
    // The policy is always policyFromManifest(manifest), plus (only for wrapIacServerSpec) the one
    // `iacProfile` flag; nothing else is spread into it.
    expect(producer).toMatch(
      /\[SANDBOX_POLICY_ENV\]:\s*JSON\.stringify\(\{\s*\.\.\.policyFromManifest\(manifest\),\s*\.\.\.\(iacProfile \? \{ iacProfile: true \} : \{\}\),\s*\}\)/,
    );
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

  describe("the Obsidian write grant (Phase 9.7 B4b)", () => {
    /** The text of `function <name>(` up to the next top-level declaration, comments stripped. */
    function fnBody(src: string, name: string): string {
      const code = stripComments(src);
      const at = code.search(new RegExp(String.raw`(async\s+)?function ${name}\(`));
      expect(at).toBeGreaterThanOrEqual(0);
      const next = code.slice(at + 1).search(/\n(export\s+)?(async\s+)?function\s/);
      return next < 0 ? code.slice(at) : code.slice(at, at + 1 + next);
    }

    test("the write list is today's daily-note FILES behind the live approval, or nothing", async () => {
      const src = await read("packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts");
      const decide = fnBody(src, "obsidianWritePathsFor");
      // The approval is consulted first; without it the list is the empty literal.
      expect(decide).toMatch(
        /if \(deps === undefined \|\| !obsidianWriteGrantApproved\(ctx\)\) return \{ paths: \[\] \};/,
      );
      expect(decide).toMatch(/const grant = obsidianDailyNoteGrant\(roots, deps\);/);
      expect(decide).toMatch(/return \{ paths: grant\.files, day: grant\.day \};/);
      // The grant is files only: the daily-note module never hands out a vault (owner ruling).
      const dn = stripComments(
        await read("packages/gateway/src/connectors/lazy-mesh/obsidian-daily-note-grant.ts"),
      );
      expect(dn).toMatch(/if \("file" in r\) files\.push\(r\.file\);/);
      expect(dn).not.toMatch(/files\.push\(vault\)/);
      expect(dn).toMatch(
        /const CONFIG_DIRS: ReadonlySet<string> = new Set\(\["\.obsidian", "\.git"\]\);/,
      );
      const approved = fnBody(src, "obsidianWriteGrantApproved");
      expect(approved).toMatch(/ctx\.obsidianWriteGrantEnabled/);
      const start = fnBody(src, "startObsidianMcp");
      expect(start).toMatch(/const grant = obsidianWritePathsFor\(ctx, vaultPaths\);/);
      expect(start).toMatch(/const writePaths = grant\.paths;/);
      // The day-rollover refresh runs before the live-client reuse check.
      expect(start.indexOf("ctx.obsidianRefreshStale?.()")).toBeGreaterThan(0);
      expect(start.indexOf("ctx.obsidianRefreshStale?.()")).toBeLessThan(
        start.indexOf("ctx.getLazyClient(slotKey) !== undefined"),
      );
      expect(start).toMatch(/obsidianSpawnManifest\(vaultPaths, writePaths\)/);
      // The pre-spawn hook (the Windows revoke) is awaited BEFORE the client is created.
      expect(start.indexOf("await ctx.obsidianPreSpawn(")).toBeGreaterThan(0);
      expect(start.indexOf("await ctx.obsidianPreSpawn(")).toBeLessThan(
        start.indexOf("ctx.setLazyClient("),
      );
      const manifest = fnBody(src, "obsidianSpawnManifest");
      expect(manifest).toMatch(
        /write: \[\.\.\.obsidianBase\.permissions\.filesystem\.write, \.\.\.writePaths\]/,
      );
      expect(manifest).toMatch(
        /read: \[\.\.\.obsidianBase\.permissions\.filesystem\.read, \.\.\.roots\]/,
      );
    });

    test("every first-party manifest declares write: [] (derived from the table)", async () => {
      const { FIRST_PARTY_MANIFESTS } = await import(
        "../connectors/lazy-mesh/first-party-manifests.ts"
      );
      const entries = Object.entries(FIRST_PARTY_MANIFESTS);
      expect(entries.length).toBeGreaterThanOrEqual(50);
      expect(entries.filter(([, m]) => m.permissions.filesystem.write.length > 0)).toEqual([]);
    });

    test("the only spawn-time write additions under lazy-mesh are the filesystem dataDir, the Obsidian vaults and a user MCP server's prepared grant", async () => {
      const dir = resolve(REPO_ROOT, "packages/gateway/src/connectors/lazy-mesh");
      const files = (await readdir(dir, { recursive: true })).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
      );
      const additions: string[] = [];
      let literals = 0;
      for (const f of files) {
        const code = stripComments(await readFile(resolve(dir, f), "utf8"));
        if (f === "iac-runner.ts") {
          // D2: the iac profiles' write list is built in ONE function from three inputs only: the
          // approved canonical workdir, this run's staging directory and this call's scratch
          // directory. D3a: the `kube` profile writes its scratch directory ONLY (the fourth
          // entry: no owner directory, no kubeconfig directory). Every assignment of it is pinned
          // here instead of the literal scan below.
          expect([...code.matchAll(/\bwrite = ([^;]*);/g)].map((m) => m[1])).toEqual([
            "[...wd, ...(req.stagingDir === undefined ? [] : [req.stagingDir])]",
            "[...wd]",
            "req.scratchDir === undefined ? [] : [req.scratchDir]",
            "req.scratchDir === undefined ? [] : [req.scratchDir]",
          ]);
          continue;
        }
        // A write list that is not a literal would evade the element scan: refuse it outright.
        expect(code).not.toMatch(/\bwrite:\s*(?!\[)[\w.]/);
        for (const m of code.matchAll(/\bwrite:\s*\[([^\]]*)\]/g)) {
          literals += 1;
          for (const el of (m[1] ?? "").split(",").map((e) => e.trim())) {
            if (el === "" || /^\.\.\.[\w.]*permissions\.filesystem\.write$/.test(el)) continue;
            additions.push(`${f.replaceAll("\\", "/")}: ${el}`);
          }
        }
      }
      expect(literals).toBeGreaterThanOrEqual(50);
      expect(additions.sort()).toEqual([
        "connector-spawns.ts: ...writePaths",
        "mesh.ts: paths.dataDir",
        // AD5b: the ONE builder of a user MCP write grant. `grant.dirs` exists only on a
        // `PreparedUserMcpWriteGrant`, which only `prepareUserMcpWriteGrant` constructs.
        "user-mcp-write-grant.ts: ...grant.dirs",
        "user-mcp-write-grant.ts: ...parts.write",
      ]);
      // The user MCP spawn manifest takes its write list from those parts and nowhere else.
      const userMcp = stripComments(await readFile(resolve(dir, "user-mcp.ts"), "utf8"));
      expect(userMcp).toMatch(
        /const \{ read: readPaths, write, \.\.\.declared \} = userMcpWriteManifestParts\(read\.value, prepared\);/,
      );
      expect(userMcp).toMatch(/filesystem: \{ read: readPaths, write \},/);
    });

    test("assemble wires the live approval; the connector RPC wires the restart to the mesh", async () => {
      const meshSrc = "packages/gateway/src/platform/assemble/scheduler-mesh.ts";
      expect(stripComments(await read(meshSrc))).toMatch(
        /obsidianWriteGrantEnabled: \(\) => isObsidianWriteGrantApproved\(db\)/,
      );
      const rpc = stripComments(await read("packages/gateway/src/ipc/connector-rpc.ts"));
      expect(rpc).toMatch(/onObsidianGrantChanged: \(\) => connectorMesh\.restartObsidian\(\)/);
      const handler = stripComments(
        await read("packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts"),
      );
      expect(handler.match(/await deps\.onObsidianGrantChanged\?\.\(\)/g) ?? []).toHaveLength(2);
      const store = stripComments(
        await read("packages/gateway/src/connectors/connector-writes/enablement-store.ts"),
      );
      expect(store).toMatch(
        /getModelWriteEnablement\(db, "obsidian"\)\?\.approvedToolIds\.has\(OBSIDIAN_APPEND_TOOL_ID\) === true/,
      );
    });

    test("the sandbox wrapper refuses a pre-canonicalised write path that changed, BEFORE the runner", async () => {
      const w = stripComments(
        await read("packages/gateway/src/platform/sandbox/sandbox-wrapper.ts"),
      );
      const check = w.indexOf("canonicalWriteDrift(policy, canonicalPath)");
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(w.indexOf("createSandboxRunner("));
      expect(w.slice(check, check + 200)).toMatch(/if \(drifted !== undefined\) \{\s*fatal\(/);
    });

    // Phase 28 AD5b-1: the mechanism for a declared write DIRECTORY, with no producer yet.
    test("a declared write directory is checked by the wrapper BEFORE the runner, and nothing in production declares one", async () => {
      const w = stripComments(
        await read("packages/gateway/src/platform/sandbox/sandbox-wrapper.ts"),
      );
      const check = w.indexOf("writeDirGrantRefusal(policy)");
      expect(check).toBeGreaterThan(w.indexOf("writeFileDrift(policy,"));
      expect(check).toBeLessThan(w.indexOf("createSandboxRunner("));
      expect(w.slice(check, check + 120)).toMatch(
        /if \(badDir !== undefined\) \{\s*fatal\(badDir\);/,
      );
      // The one function checks the kind first and the tree second, and only `clean` passes.
      const g = stripComments(
        await read("packages/gateway/src/platform/sandbox/write-grant-check.ts"),
      );
      expect(g.indexOf("writeDirDrift(policy,")).toBeGreaterThan(0);
      expect(g.indexOf("writeDirDrift(policy,")).toBeLessThan(g.indexOf("scan(dir)"));
      expect(g).toMatch(/if \(verdict !== "clean"\) \{\s*return `refusing to spawn:/);
      // Every runner refuses a declared write path that no longer canonicalises to itself.
      const linux = stripComments(await read("packages/gateway/src/platform/sandbox/linux.ts"));
      expect(linux).toMatch(/assertDeclaredWriteGrantsUnchanged\(opts\.policy\);/);
      const canon = stripComments(
        await read("packages/gateway/src/platform/sandbox/canonical-path.ts"),
      );
      expect(canon).toMatch(/assertDeclaredWriteGrantsUnchanged\(policy, canonical\);\s*return \{/);
      // The spawn manifest takes its write list ONLY from the prepared grant, never from the row
      // (static D10 `user-write` holds the list of files that may name the declaration).
      const userMcp = stripComments(
        await read("packages/gateway/src/connectors/lazy-mesh/user-mcp.ts"),
      );
      expect(userMcp).toMatch(/userMcpWriteManifestParts\(read\.value, prepared\)/);
      expect(userMcp).not.toContain("write_paths_json");
      expect(userMcp).not.toContain("canonicalWriteDirs");
      // The Windows helper refuses a declared directory that is not a real one, then grants it
      // inheritably with no DELETE right.
      const helper = await read("packages/gateway/src-native/sandbox-helper-win32/main.c");
      expect(helper).toMatch(/rc = require_real_directory\(o->write_dirs\[k\]\);/);
      expect(helper).toMatch(
        /grant_path\(o->write_dirs\[k\], sid,\s*FILE_GENERIC_READ \| FILE_GENERIC_EXECUTE \| FILE_GENERIC_WRITE,\s*SUB_CONTAINERS_AND_OBJECTS_INHERIT\)/,
      );
      // No delete right is OR-ed into any grant (the names appear in comments only).
      expect(helper).not.toMatch(/\|\s*(?:DELETE|FILE_DELETE_CHILD)\b/);
    });

    // Phase 28 AD5b-2: the owner's write grant of a user MCP server.
    describe("a user MCP write grant (Phase 28 AD5b-2)", () => {
      test("the spawn manifest gets a write path ONLY from the prepared grant, and every spawn decision awaits the preparation first", async () => {
        const mesh = stripComments(await read("packages/gateway/src/connectors/lazy-mesh/mesh.ts"));
        // The two places a user MCP client is ever created, each behind the preparation.
        const calls = [...mesh.matchAll(/ensureUserMcpClient\(/g)];
        expect(calls).toHaveLength(2);
        for (const m of calls) {
          const before = mesh.slice(Math.max(0, m.index - 220), m.index);
          expect(before).toMatch(/const prepared = await this\.prepareUserMcpSpawn\(row\);/);
        }
        expect(mesh).toMatch(/ensureUserMcpClient\(this\.spawnContext, row, prepared\)/);
        // A refused preparation creates no client: `undefined` is skipped, never replaced.
        expect(mesh).toMatch(/if \(prepared === undefined\) return;/);
        expect(mesh).toMatch(/if \(prepared !== undefined\) ensureUserMcpClient\(/);
        const prepare = mesh.slice(mesh.indexOf("private prepareUserMcpSpawn("));
        const refusal = prepare.slice(0, prepare.indexOf("\n  }\n"));
        // A live client is left alone BEFORE anything is revoked or read.
        // Both must EXIST (a missing guard would be index -1 and pass a bare order check), the
        // guard must return before the builder is reached, and it comes first.
        const guard = refusal.indexOf(
          "getLazyClient(userMcpMeshKey(row.service_id)) !== undefined",
        );
        const builder = refusal.indexOf("prepareUserMcpWriteGrant(");
        expect(guard).toBeGreaterThan(0);
        expect(builder).toBeGreaterThan(0);
        expect(guard).toBeLessThan(builder);
        expect(refusal.slice(guard, builder)).toMatch(/return NO_USER_MCP_WRITE_GRANT;/);
        expect(refusal).toMatch(/return undefined;\s*\}\);/);
      });

      test("the one builder checks the stored list, the rule, the sandbox and the ledger in that order", async () => {
        const src = stripComments(
          await read("packages/gateway/src/connectors/lazy-mesh/user-mcp-write-grant.ts"),
        );
        const body = src.slice(src.indexOf("export async function prepareUserMcpWriteGrant("));
        const order = [
          "storedWriteDirs(row,",
          'writeDirRefusal(dir, "spawn", deps.writeDir)',
          "deps.canConfine(policyFor(",
          "await settleWindowsLedger(",
          "return { ok: true, grant };",
        ].map((needle) => body.indexOf(needle));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // The ledger: the revoke precedes the save, and a failed revoke returns before any save.
        const ledger = src.slice(src.indexOf("async function settleWindowsLedger("));
        expect(ledger.indexOf("await revoker.revoke(stale)")).toBeLessThan(
          ledger.indexOf("deps.ledger.save(next)"),
        );
        expect(ledger).toMatch(
          /await revoker\.revoke\(stale\);\s*\} catch \{\s*return USER_MCP_WRITE_GRANT_REFUSALS\.revokeFailed;/,
        );
        // The brand has no value outside the module: only `prepared(...)` makes one.
        expect(src).toMatch(/declare const PREPARED: unique symbol;/);
        expect([...src.matchAll(/as PreparedUserMcpWriteGrant/g)]).toHaveLength(1);
      });

      test("behavioural: the real rule refuses a directory that holds a marker folder and grants a clean one", async () => {
        const { prepareUserMcpWriteGrant } = await import(
          "../connectors/lazy-mesh/user-mcp-write-grant.ts"
        );
        const { productionWriteDirDeps } = await import(
          "../connectors/lazy-mesh/user-mcp-write-deps.ts"
        );
        const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i15-write-")));
        try {
          const out = join(root, "work", "out");
          mkdirSync(out, { recursive: true });
          const paths = {
            configDir: join(root, "n", "config"),
            dataDir: join(root, "n", "data"),
            logDir: join(root, "n", "log"),
            socketPath: join(root, "n", "sock"),
            extensionsDir: join(root, "n", "ext"),
            tempDir: join(root, "n", "tmp"),
            sandboxDir: join(root, "n", "cache", "sandbox"),
          };
          const calls: string[] = [];
          const deps = {
            writeDir: {
              ...productionWriteDirDeps({
                paths,
                platform: process.platform,
                listRows: () => [],
                iacWorkdirs: () => [],
                envVar: () => undefined,
              }),
              homeDir: join(root, "home"),
            },
            canConfine: () => {
              calls.push("canConfine");
              return null;
            },
            ledger: { load: () => ({}), save: () => calls.push("save") },
            revokerFor: () => ({ active: false, revoke: () => Promise.resolve() }),
          };
          const row = {
            service_id: "mcp_notes",
            command: process.execPath,
            args_json: "[]",
            created_at: 1,
            read_paths_json: "[]",
            net_hosts_json: "[]",
            model_access: 0,
            write_paths_json: JSON.stringify([out]),
          };
          const clean = await prepareUserMcpWriteGrant(row, [], [], deps);
          expect(clean.ok && clean.grant.dirs).toEqual([out]);
          expect(calls).toEqual(["canConfine"]);
          // A marker folder appears (a server planted it, or the owner ran git init): refused,
          // and the sandbox is never asked.
          mkdirSync(join(out, "sub", ".git", "hooks"), { recursive: true });
          calls.length = 0;
          const refused = await prepareUserMcpWriteGrant(row, [], [], deps);
          expect(refused.ok).toBe(false);
          expect(calls).toEqual([]);
          // Inside a Nimbus folder: refused.
          const inside = join(paths.dataDir, "x");
          mkdirSync(inside, { recursive: true });
          const protectedDir = await prepareUserMcpWriteGrant(
            { ...row, write_paths_json: JSON.stringify([inside]) },
            [],
            [],
            deps,
          );
          expect(protectedDir).toEqual({
            ok: false,
            reason: "the directory overlaps a folder Nimbus owns",
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      test("registration: the person-only and can-confine checks precede the prompt, the old grants are released after it and before the row", async () => {
        const rpc = stripComments(await read("packages/gateway/src/ipc/connector-rpc.ts"));
        const body = rpc.slice(rpc.indexOf("const resolved = resolveConnectorAddMcp(ctx);"));
        const order = [
          "assertWriteGrantRegistrable(ctx, resolved);",
          'toolExecutor.gate({ type: "connector.addMcp", payload })',
          // After the answer the registration must still resolve to what was approved.
          "assertRegistrationUnchanged(ctx, resolved);",
          "await assertUserMcpGrantsClean(ctx, resolved.serviceId);",
          "return handleConnectorAddMcp(ctx, resolved);",
        ].map((needle) => body.indexOf(needle));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        const config = stripComments(
          await read("packages/gateway/src/ipc/connector-rpc-handlers/config.ts"),
        );
        const registrable = config.slice(
          config.indexOf("export function assertWriteGrantRegistrable("),
        );
        expect(registrable).toMatch(/if \(resolved\.writePaths\.length === 0\) return;/);
        expect(registrable).toMatch(/APPROVER_BY_KIND\[ctx\.clientKind \?\? "unknown"\]/);
        expect(registrable).toMatch(/userMcpWriteConfineRefusal\(resolved,/);
        // The consent channel of a write-grant registration is the human-only one.
        const dispatchers = stripComments(
          await read("packages/gateway/src/ipc/server/dispatchers/platform-rpcs.ts"),
        );
        expect(dispatchers).toMatch(
          /method === "connector\.addMcp" && Array\.isArray\(writePathsParam\) && writePathsParam\.length > 0/,
        );
        expect(dispatchers).toMatch(/agentEnable \|\| writeGrantAdd\s*\? humanOnlyConsent\(/);
      });

      test("the prompt: a call whose server's write directories cannot be told is refused before anyone is asked, and an agent's call to a write-granted server is typed", async () => {
        const exec = stripComments(await read("packages/gateway/src/engine/executor.ts"));
        const confirm = exec.slice(
          exec.indexOf("private renderConfirmPhase(action: PlannedAction): ConfirmPlan {"),
        );
        const head = confirm.slice(0, confirm.indexOf("const rows = this.rows();"));
        expect(head).toMatch(
          /if \(userMcpDirs === "unknown"\) \{\s*return \{ kind: "refuse", reason: USER_MCP_WRITE_UNKNOWN_REASON \};/,
        );
        expect(head).toMatch(
          /isAgentOrigin\(action\) && userMcpDirs\.length > 0\s*\? \{ kind: "text", text: serviceOf\(action\.type\) \}\s*: NO_CONFIRM;/,
        );
        // An agent's call is judged by its own facts; with none it cannot be asked about.
        expect(exec).toMatch(
          /if \(isAgentOrigin\(action\)\) return action\.userMcpCall\?\.writePaths \?\? "unknown";/,
        );
        // Every turn executor is given the reader in the ONE shared construction.
        const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
        expect(runAsk).toMatch(/\{ \.\.\.extras, userMcpWriteGrants: p\.userMcpWriteGrants \}/);
      });

      test("V98: the column defaults to no grant, so no server that existed before gains one", async () => {
        const { USER_MCP_WRITE_V98_SQL } = await import("../index/user-mcp-write-v98-sql.ts");
        expect(USER_MCP_WRITE_V98_SQL).toContain(
          "ADD COLUMN write_paths_json TEXT NOT NULL DEFAULT '[]'",
        );
      });
    });

    test("the Windows revoke before a grant is the fail-closed one, never the best-effort release", async () => {
      const mesh = stripComments(await read("packages/gateway/src/connectors/lazy-mesh/mesh.ts"));
      expect(mesh).toMatch(
        /appContainerGrantRevokerFor\(platform, manifestForFirstParty\("obsidian"\)\.id\)/,
      );
      // A declared file is `file-write-data` on a literal on macOS (never file-write*), and a
      // non-inheritable ACE on Windows; macOS reads the declared kind, never the disk.
      const darwin = stripComments(await read("packages/gateway/src/platform/sandbox/darwin.ts"));
      expect(darwin).toMatch(/\.map\(\(p\) => `\(allow file-write-data \(literal "\$\{p\}"\)\)`\)/);
      expect(darwin).toMatch(/writeFiles: writeFilesOf\(policy\)/);
      // The declared kind comes from the shared `declaredWriteFiles` (both runners), which refuses
      // a declared file missing from the final write list instead of falling back.
      expect(darwin).toMatch(/return declaredWriteFiles\(policy\);/);
      expect(darwin).not.toMatch(/lstatSync|statSync/);
      const canon = stripComments(
        await read("packages/gateway/src/platform/sandbox/canonical-path.ts"),
      );
      expect(canon).toMatch(/export function declaredWriteFiles\(/);
      expect(canon).toMatch(/policy\.canonicalWriteFiles \?\? \[\]/);
      const helper = await read("packages/gateway/src-native/sandbox-helper-win32/main.c");
      // The kind is DECLARED, never probed: win32-argv passes --grant-write-file for each
      // canonicalWriteFiles entry; the helper refuses one that is not a regular file and grants
      // it with NO_INHERITANCE.
      const argv = stripComments(await read("packages/gateway/src/platform/sandbox/win32-argv.ts"));
      expect(argv).toMatch(/const files = declaredWriteFiles\(policy\);/);
      expect(argv).toMatch(/files\.has\(p\) \? "--grant-write-file" : "--grant-write"/);
      expect(helper).toMatch(/rc = require_regular_file\(o->write_files\[k\]\);/);
      expect(helper).toMatch(/grant_path\(o->write_files\[k\], sid,[\s\S]{0,120}NO_INHERITANCE\)/);
      expect(helper).not.toMatch(/inheritance_for/);
      const wrapper = stripComments(
        await read("packages/gateway/src/platform/sandbox/sandbox-wrapper.ts"),
      );
      expect(wrapper.indexOf("writeFileDrift(policy,")).toBeGreaterThan(0);
      expect(wrapper.indexOf("writeFileDrift(policy,")).toBeLessThan(
        wrapper.indexOf("createSandboxRunner("),
      );
      // The pre-spawn hook awaits the revoke-then-record step; the ledger is saved only AFTER the
      // revoke resolved (an entry leaves the ledger only once revoked), and before the spawn.
      expect(mesh).toMatch(/await this\.revokeObsidianGrants\(plan\.writePaths\);/);
      const step = mesh.slice(mesh.indexOf("private async revokeObsidianGrants("));
      expect(step.indexOf("await this.obsidianRevoker.revoke(")).toBeGreaterThan(0);
      expect(step.indexOf("await this.obsidianRevoker.revoke(")).toBeLessThan(
        step.indexOf("this.obsidianLedger.save(next)"),
      );
      // The restart detaches without waiting on the drain, then revokes in the same serial step.
      const restart = mesh.slice(mesh.indexOf("async restartObsidian()"));
      expect(restart).toMatch(
        /void this\.detachLazyClient\(LAZY_MESH\.obsidian\);\s*if \(this\.obsidianRevoker\.active\) await this\.revokeObsidianGrants\(\[\]\);/,
      );
      expect(mesh).not.toMatch(/releaseGrantsFor/);
      const revoke = stripComments(
        await read("packages/gateway/src/platform/sandbox/win32-grant-revoke.ts"),
      );
      expect(revoke).toMatch(/buildRevokeGrantsArgv\(policy, \{ cwd: first \}\)/);
      expect(revoke).toMatch(/if \(code !== 0\) \{\s*throw new Error\(/);
      expect(revoke).not.toMatch(/releaseGrantsFor|catch \{/);
    });

    test("behavioural: a Windows revoke that fails refuses the Obsidian spawn", async () => {
      const { mkdirSync, mkdtempSync, realpathSync, rmSync } = await import("node:fs");
      const { LazyConnectorMesh } = await import("../connectors/lazy-mesh/mesh.ts");
      const { LAZY_MESH } = await import("../connectors/lazy-mesh/keys.ts");
      const { createMockVault } = await import("../vault/mock.ts");
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i15-obs-")));
      try {
        const root = join(base, "notes");
        mkdirSync(join(root, "v", ".obsidian"), { recursive: true });
        const n = (p: string) => join(base, "nimbus", p);
        const m = new LazyConnectorMesh(
          {
            configDir: n("config"),
            dataDir: n("data"),
            logDir: n("log"),
            socketPath: n("sock"),
            extensionsDir: n("ext"),
            tempDir: n("tmp"),
            sandboxDir: n("sandbox"),
          },
          createMockVault(),
          {
            obsidianVaultPaths: [root],
            obsidianWriteGrantEnabled: () => true,
            obsidianGrantRevoker: {
              active: true,
              revoke: () => Promise.reject(new Error("helper exit 1")),
            },
          },
        );
        await m.ensureObsidianRunning();
        const slots = (m as unknown as { lazySlots: Map<string, { client: unknown }> }).lazySlots;
        expect(slots.get(LAZY_MESH.obsidian)?.client).toBeUndefined();
        await m.disconnect();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
