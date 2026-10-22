// Connector migration end-to-end (Readwise unbundling spec § 7.2, § 7.3's CLI bullet): a REAL
// gateway subprocess, over a REAL socket / named pipe.
//
// Part 1 (every machine): the four `migration.*` methods reach their handler through BOTH dispatcher
// layers. A unit test of `dispatchMigrationRpc` passes whether or not the outer routing exists; only
// a real socket tells "Method not found" from the handler's own answer.
//
// Part 2 (where this OS's real sandbox can confine): a user upgrading from a bundled connector. The
// gateway is booted with a FIXTURE built-in registry and a FIXTURE continuity entry, passed as
// `assemblePlatformServices` composition options by the runner (ruling B1 — never env, config or
// IPC as far as the gateway is concerned). The legacy id is `fixturewise`, which is NOT a bundled
// connector (ruling B3: the engine skips bundled ids by design), seeded with bundled-style items, a
// bundled-style scheduler row whose cursor is realistic stored bytes (ruling B4), and its legacy
// Vault key. Then:
//   - boot `evaluate()` prepares the migration, and `nimbus connector migrate list` shows the row;
//   - `nimbus connector migrate accept <id>`, driven in-process with a TTY on stdin and stdout and
//     answered "y" at the gateway's one `extension.migrate` prompt, installs, grants and resumes;
//   - the ONE sync that accept's `resume()` schedules (the seeded row came due while paused;
//     `connector.sync` cannot address a non-catalog fixture id) appends exactly ONE `sync.run` egress
//     row (I29), still one two seconds later, and updates the seeded items IN PLACE: same ids, same
//     count, nothing under the extension's own `ext_` id. The gateway is booted once as the
//     previous release first, so the upgrade boot has no fresh-install queue of bundled syncables
//     for `resume()` to land behind (`pendingRuns`).
//
// Sandbox seams — the same ones `extension-sync.e2e.test.ts` (PR 3) uses: the fixture's pages are
// produced INSIDE the extension, so the manifest declares no network at all (the Windows
// AppContainer cannot reach loopback, and a Linux network helper would be needed for a loopback
// fake); the suite self-validates `canConfine` over a no-network policy on THIS machine, fails by
// name on CI when that is unmet, and on Windows points the wrapper at the repo-built
// `nimbus-sandbox-helper.exe` beside `process.execPath`.
//
// The extension is built in-repo the way `extension-sync.e2e.test.ts` builds its own: the
// `nimbus scaffold mcp` output with its entry replaced by a `__nimbus_sync` tool, bundled with
// `bun build --target=bun`, then published into a signed fixture registry by
// `build-test-registry.ts`. Nothing depends on the nimbus-mcp-servers repo.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); search runs keyword-only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import {
  type MigrateIo,
  runConnectorMigrate,
} from "../../../cli/src/commands/connector-migrate.ts";
import { createIpcClient } from "../../../cli/src/lib/rpc-timeouts.ts";
import { buildTestRegistry } from "../../src/extensions/registry/__fixtures__/build-test-registry.ts";
import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";
import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

// ---------------------------------------------------------------------------------------------
// Part 1 — the namespace is wired through both dispatcher layers
// ---------------------------------------------------------------------------------------------

describe("migration.* over a real socket", () => {
  test(
    "all four methods reach their handler through both dispatcher layers",
    async () => {
      const gw = await startRealGateway("migration");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);

        // Runner default composition: no built-in registry (the runner passes `builtin: null`, so
        // nothing reaches the real official host) and the production continuity table, so boot
        // evaluation prepared nothing and retry prepares nothing (ruling B1).
        const list = await client.raw("migration.list", {});
        expect(list.error).toBeUndefined();
        expect(list.result).toEqual({ migrations: [] });

        const retry = await client.raw("migration.retry", {});
        expect(retry.error).toBeUndefined();
        expect(retry.result).toEqual({ migrations: [] });

        // The handler's own refusals (never -32601 "Method not found").
        for (const method of ["migration.accept", "migration.decline"]) {
          const reply = await client.raw(method, { id: "no-such-migration" });
          expect(reply.error?.code, method).toBe(-32000);
          expect(reply.error?.message, method).toContain("ERR_EXTENSION_MIGRATION_NOT_FOUND");
          const bad = await client.raw(method, {});
          expect(bad.error?.code, method).toBe(-32602);
        }
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// Part 2 — an upgrading user's bundled connector moves to its signed extension
// ---------------------------------------------------------------------------------------------

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
const IS_CI = process.env["CI"] === "true";

const LEGACY = "fixturewise";
const LEGACY_KEY = "fixturewise.token";
const EXTENSION_ID = "com.example.fixturewise";
const CODE_SERVER_ID = "ext_com_example_fixturewise";
/** PR 4 R7 / ruling B4: the bytes a bundled-style scheduler row stores for its resting cursor. */
const SEEDED_CURSOR = "nimbus-readwise1:eyJwYXNzIjoxfQ";
/** A per-run value, so a marker can only match if THIS value reached the child. */
const TOKEN = `e2e-migration-token-${randomUUID()}`;
const TOKEN_MARKER = createHash("sha256").update(TOKEN).digest("hex").slice(0, 16);
const SEEDED_ITEMS = [
  { type: "highlight", externalId: "101", title: "old 101" },
  { type: "highlight", externalId: "102", title: "old 102" },
  { type: "book", externalId: "book/7", title: "old book" },
];

const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

/** Self-validating, exactly as in extension-sync.e2e: asked of THIS machine's real sandbox. */
const sandboxAvailable = await (async () => {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "migration-e2e-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
})();

/** As in extension-sync.e2e: the wrapper resolves the helper beside `process.execPath`. */
function installDefaultHelper(): () => void {
  if (process.platform !== "win32") return () => {};
  const defaultHelper = join(dirname(process.execPath), "nimbus-sandbox-helper.exe");
  if (existsSync(defaultHelper) || !existsSync(WIN_BUILT_HELPER)) return () => {};
  copyFileSync(WIN_BUILT_HELPER, defaultHelper);
  return () => {
    try {
      rmSync(defaultHelper, { force: true });
    } catch {
      /* best-effort -- a locked file here must not mask the test's real outcome */
    }
  };
}

function installedPackageDir(pkg: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
  }
}

describe.skipIf(sandboxAvailable || !IS_CI)("migration e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the confined migration sync", () => {
    expect(
      "migration-e2e: CI precondition unmet -- the platform sandbox cannot confine a no-network " +
        "policy, so the migrated extension cannot be spawned for sync. Install this platform's " +
        "sandbox dependency (scripts/linux/install-sandbox-deps.sh on Linux, " +
        "build:sandbox-helper:win32 on Windows).",
    ).toBeNull();
  });
});

/**
 * The fixture extension's entry: the scaffold's server plus `__nimbus_sync`. It returns the three
 * items the bundled connector indexed, under the SAME external ids, with titles that carry the
 * cursor it was handed and a digest of its credential env var (never the value). The cursor is
 * echoed back, so the stored one stays byte-identical.
 */
const ENTRY_TS = `import { createHash } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "./server.ts";

const marker = createHash("sha256")
  .update(process.env.FIXTUREWISE_TOKEN ?? "<unset>")
  .digest("hex")
  .slice(0, 16);

const server = createServer();
server.registerTool(
  "__nimbus_sync",
  {
    description: "sync v1",
    inputSchema: {
      cursor: z.string().nullable(),
      depth: z.string(),
      historyFloorMs: z.number().optional(),
    },
  },
  async ({ cursor }) => {
    const seen = cursor ?? "<none>";
    const now = Date.now();
    const item = (type: string, externalId: string) => ({
      type,
      externalId,
      title: "migrated " + externalId + " " + marker + " from " + seen,
      modifiedAt: now,
      metadata: {},
    });
    const page = {
      status: "ok",
      items: [item("highlight", "101"), item("highlight", "102"), item("book", "book/7")],
      cursor,
      hasMore: false,
    };
    return { content: [{ type: "text", text: JSON.stringify(page) }] };
  },
);
await server.connect(new StdioServerTransport());
`;

const MANIFEST_EXTRA = {
  name: "Fixturewise",
  permissions: { network: [], filesystem: { read: [], write: [] } },
  credentials: { token: { env: "FIXTUREWISE_TOKEN" } },
  sync: { contract: "1", intervalSeconds: 3600, itemTypes: ["highlight", "book"] },
};

async function run(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  ms = 60_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type RowView = { id: string; state: string; error: string | null; [k: string]: unknown };
type StatusRow = {
  serviceId: string;
  status: string;
  nextSyncAt: number | null;
  healthState: string;
  [k: string]: unknown;
};
/** The scheduler's `SKIP_HEALTH_STATES`: a service in one is never dispatched by a tick. */
const HEALTH_SKIPPED: ReadonlySet<string> = new Set(["rate_limited", "unauthenticated", "paused"]);
type IndexedItem = { id?: unknown; externalId?: unknown; name?: unknown; title?: unknown };

describe.skipIf(!sandboxAvailable)(
  "an upgrading user's bundled connector moves to its extension",
  () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-migration-e2e-"));
    const scaffoldRoot = join(tmp, "scaffold");
    const project = join(scaffoldRoot, "fixturewise_ext");
    const bundle = join(tmp, "bundle", "index.js");
    const registryDir = join(tmp, "official");
    const paths = {
      configDir: join(tmp, "config"),
      dataDir: join(tmp, "data"),
      logDir: join(tmp, "logs"),
      socketPath:
        process.platform === "win32"
          ? `\\\\.\\pipe\\nimbus-migration-${process.pid}-${randomUUID().slice(0, 8)}`
          : join(tmp, "gw.sock"),
      extensionsDir: join(tmp, "extensions"),
      tempDir: join(tmp, "tmp"),
      sandboxDir: join(tmp, "sandbox"),
    };
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let gatewayLog = "";
    let restoreHelper: () => void = () => {};
    const client = new TinyIpcClient();
    let migrationId = "";
    let idsBefore: string[] = [];
    const prompts: string[] = [];

    /** The CLI's own command, given a TTY it controls and a terminal that answers "y". */
    function ttyIo(lines: string[]): MigrateIo {
      return {
        stdinIsTty: true,
        stdoutIsTty: true,
        open: async (timeoutMs) => {
          const c = createIpcClient(paths.socketPath, timeoutMs);
          await c.connect();
          return c;
        },
        confirm: async ({ message }) => {
          prompts.push(message);
          return true;
        },
        log: (l) => lines.push(l),
      };
    }

    async function call<T>(method: string, params: unknown): Promise<T> {
      try {
        return await client.call<T>(method, params);
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-8000)}`,
        );
      }
    }

    async function items(service: string): Promise<IndexedItem[]> {
      return call<IndexedItem[]>("index.searchRanked", { service, semantic: false, limit: 50 });
    }

    function idOf(i: IndexedItem): string {
      return String(i.id ?? i.externalId ?? "");
    }

    async function syncRows(destination: string): Promise<number> {
      const out = await call<{ rows: Array<{ destination: string; method: string }> }>(
        "egress.list",
        { limit: 10_000 },
      );
      return out.rows.filter((r) => r.destination === destination && r.method === "sync.run")
        .length;
    }

    /**
     * Every OTHER service whose next run is owed now: due, and neither paused, failed hard nor in
     * one of the scheduler's health-skip states (`SKIP_HEALTH_STATES` in `src/sync/scheduler.ts`).
     * A finished run of any kind moves `nextSyncAt` into the future, so these are the runs queued
     * (or about to be) ahead of a service resumed now — `resume()` appends to the BACK of the queue.
     *
     * Why it matters: a FRESH gateway registers every bundled syncable (about ninety) due at once
     * and runs them three at a time. On Windows that drains in under a second. On Linux it is far
     * slower — most syncables start their MCP server before finding no credential, the cloud ones
     * (aws, azure, gcp, bigquery, athena, cloudwatch) slowest of all — and on the CI runner the
     * queue outlasted the 60 s wait, so the run under test never started. An upgrading user is not a fresh install, which is why
     * `beforeAll` boots the previous release first; this asserts that precondition.
     */
    async function pendingRuns(): Promise<string[]> {
      const now = Date.now();
      const rows = await call<StatusRow[]>("connector.listStatus", {});
      return rows
        .filter(
          (s) =>
            s.serviceId !== LEGACY &&
            s.status !== "paused" &&
            s.status !== "error" &&
            !HEALTH_SKIPPED.has(s.healthState) &&
            s.nextSyncAt !== null &&
            s.nextSyncAt <= now,
        )
        .map((s) => s.serviceId);
    }

    /** Boots the runner over `paths` (one data dir across boots) and waits for it to bind. */
    async function bootGateway(fixtureEnv: Record<string, string>): Promise<void> {
      gatewayLog = "";
      proc = Bun.spawn(["bun", RUNNER], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...(process.env as Record<string, string>),
          NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
          ...fixtureEnv,
          NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
          NIMBUS_NOTIFICATIONS: "off",
        },
      });
      const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) gatewayLog += decoder.decode(chunk);
      };
      void collect(proc.stderr as ReadableStream<Uint8Array>);
      void collect(proc.stdout as ReadableStream<Uint8Array>);
      try {
        await until(
          async () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
          "gateway bind",
        );
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
        );
      }
    }

    async function stopGateway(): Promise<void> {
      proc?.kill();
      await proc?.exited.catch(() => {});
      proc = undefined;
    }

    beforeAll(async () => {
      // 1. The extension: scaffold, replace the entry, bundle into one file.
      mkdirSync(scaffoldRoot, { recursive: true });
      const scaffold = await run(
        ["bun", CLI_ENTRY, "scaffold", "mcp", "fixturewise_ext"],
        scaffoldRoot,
      );
      if (scaffold.code !== 0) {
        throw new Error(
          `scaffold exited ${scaffold.code}:\n${scaffold.stdout}\n${scaffold.stderr}`,
        );
      }
      mkdirSync(join(project, "node_modules", "@modelcontextprotocol"), { recursive: true });
      symlinkSync(
        realpathSync(
          installedPackageDir("@modelcontextprotocol/sdk", join(REPO, "packages", "cli")),
        ),
        join(project, "node_modules", "@modelcontextprotocol", "sdk"),
        "junction",
      );
      symlinkSync(
        realpathSync(installedPackageDir("zod", join(REPO, "packages", "cli"))),
        join(project, "node_modules", "zod"),
        "junction",
      );
      writeFileSync(join(project, "src", "index.ts"), ENTRY_TS, "utf8");
      const build = await run(
        ["bun", "build", "src/index.ts", "--target=bun", "--outfile", bundle],
        project,
      );
      if (build.code !== 0) {
        throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
      }

      // 2. The official registry: signed by the fixture root key, publishing that bundle.
      const built = await buildTestRegistry(registryDir, {
        id: EXTENSION_ID,
        versions: [{ version: "1.0.0" }],
        publisherId: "nimbus",
        manifestExtra: MANIFEST_EXTRA,
        entrySource: readFileSync(bundle, "utf8"),
      });
      const migrationFixture = {
        builtin: { url: registryDir, rootKey: built.rootKey },
        continuityTable: [
          {
            legacyServiceId: LEGACY,
            extensionId: EXTENSION_ID,
            publisherKey: built.publisherKey,
            sourceRootFingerprint: publisherKeyFingerprint(built.rootKey),
            credentials: { token: LEGACY_KEY },
            expectedPermissions: { network: [], read: [], write: [] },
            itemTypes: ["highlight", "book"],
            displayName: "Fixturewise",
          },
        ],
      };

      // 3. The release the user upgrades FROM: one plain boot, so every bundled syncable has the
      // scheduler row a previous run leaves. Without it this would be a fresh install, whose first
      // boot queues all ~90 bundled syncables at once (see `pendingRuns`). On the upgrade boot,
      // `start()` moves each overdue row out by its own interval (`catchUpOnRestart: false`), as
      // it does for every real user's restart, so nothing is queued ahead of the resumed service.
      restoreHelper = installDefaultHelper();
      for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
      await bootGateway({});
      await stopGateway();

      // 4. The upgrade: the bundled-style state, booted with the fixture composition.
      const now = Date.now();
      await bootGateway({
        NIMBUS_E2E_SEED_VAULT_JSON: JSON.stringify({ [LEGACY_KEY]: TOKEN }),
        NIMBUS_E2E_MIGRATION_FIXTURE_JSON: JSON.stringify(migrationFixture),
        NIMBUS_E2E_SEED_LEGACY_JSON: JSON.stringify({
          serviceId: LEGACY,
          items: SEEDED_ITEMS,
          // Last synced 15 minutes ago, so its next run came due while the migration kept it
          // paused: the scheduler runs it once as soon as accept resumes it, and then not again
          // for the extension's hour-long interval.
          scheduler: {
            cursor: SEEDED_CURSOR,
            intervalMs: 600_000,
            lastSyncAt: now - 900_000,
            nextSyncAt: now - 300_000,
          },
        }),
      });
      await client.connect(paths.socketPath);
    }, 240_000);

    afterAll(async () => {
      client.disconnect();
      await stopGateway();
      restoreHelper();
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* Windows handle race; harmless */
      }
    });

    test(
      "boot evaluation prepares the migration and `migrate list` shows the row",
      async () => {
        const row = await until(async () => {
          const out = await call<{ migrations: RowView[] }>("migration.list", {});
          const r = out.migrations[0];
          if (r?.state === "failed") throw new Error(`migration failed: ${r.error ?? ""}`);
          return r?.state === "awaiting_approval" ? r : undefined;
        }, "the migration to be prepared");
        migrationId = row.id;
        expect(row).not.toHaveProperty("stagePath");
        expect(JSON.stringify(row)).not.toContain(tmp);

        const lines: string[] = [];
        await runConnectorMigrate(["list"], ttyIo(lines));
        const text = lines.join("\n");
        expect(text).toContain(
          `${migrationId}  ${LEGACY} -> ${EXTENSION_ID} 1.0.0  awaiting_approval`,
        );
        expect(text).toContain(`nimbus connector migrate accept ${migrationId}`);

        // The legacy service is paused while the owner decides; nothing is installed yet.
        const installed = await call<Array<{ id: string }>>("extension.list", {}).then(
          (r) => (r as unknown as { extensions?: Array<{ id: string }> }).extensions ?? r,
        );
        expect(JSON.stringify(installed)).not.toContain(EXTENSION_ID);
        idsBefore = (await items(LEGACY)).map(idOf).sort();
        expect(idsBefore).toHaveLength(SEEDED_ITEMS.length);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "`migrate accept` answered y on a TTY installs, grants and resumes in ONE prompt",
      async () => {
        expect(migrationId).not.toBe("");
        const lines: string[] = [];
        // An upgraded gateway, not a fresh one: nothing is queued ahead of the run accept resumes.
        expect(await pendingRuns()).toEqual([]);
        await runConnectorMigrate(["accept", migrationId], ttyIo(lines));
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("extension.migrate");
        expect(prompts[0]).toContain("Fixturewise");
        expect(prompts[0]).not.toContain(TOKEN);
        expect(lines.join("\n")).toContain(
          `${LEGACY} now runs as the extension ${EXTENSION_ID} 1.0.0`,
        );

        const out = await call<{ migrations: RowView[] }>("migration.list", {});
        expect(out.migrations.map((m) => [m.id, m.state])).toEqual([[migrationId, "approved"]]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the resumed sync runs once, appends exactly ONE sync.run row and updates the items in place",
      async () => {
        // `connector.sync` admits catalog, gateway, user-MCP and `ext_` ids only, and the fixture's
        // legacy id is none of those (a real legacy id, `readwise`, is a catalog id). So the run
        // under test is the one accept's resume schedules: the row came due while paused.
        const migrated = (i: IndexedItem): boolean =>
          String(i.name ?? i.title ?? "").startsWith("migrated ");
        await until(async () => {
          const now = await items(LEGACY);
          return now.length > 0 && now.every(migrated) ? true : undefined;
        }, "the resumed sync to update the items").catch(async (e: unknown) => {
          const legacy = (await call<StatusRow[]>("connector.listStatus", {})).find(
            (s) => s.serviceId === LEGACY,
          );
          throw new Error(
            `${e instanceof Error ? e.message : String(e)}; ${LEGACY}: ${JSON.stringify(legacy)}; ` +
              `still due ahead of it: ${(await pendingRuns()).join(", ")}\n` +
              `--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
          );
        });
        expect(await syncRows(LEGACY)).toBe(1);
        // …and it stays one: nothing else runs within the extension's hour-long interval.
        await new Promise((r) => setTimeout(r, 2_000));
        expect(await syncRows(LEGACY)).toBe(1);
        expect(await syncRows(CODE_SERVER_ID)).toBe(0);

        const after = await items(LEGACY);
        // Same ids, same count: updated in place, never duplicated.
        expect(after.map(idOf).sort()).toEqual(idsBefore);
        // Written by the extension, which got the legacy Vault credential (no re-entry) and the
        // bundled connector's stored cursor.
        for (const i of after) {
          const title = String(i.name ?? i.title ?? "");
          expect(title).toContain(`migrated`);
          expect(title).toContain(TOKEN_MARKER);
          expect(title).toContain(`from ${SEEDED_CURSOR}`);
        }
        expect(await items(CODE_SERVER_ID)).toEqual([]);
        expect(gatewayLog).not.toContain(TOKEN);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
