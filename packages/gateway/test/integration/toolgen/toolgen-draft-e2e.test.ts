import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../../../src/config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { createSandboxRunner } from "../../../src/platform/sandbox/sandbox-runner.ts";
import { ToolgenBroker } from "../../../src/toolgen/toolgen-broker.ts";
import {
  buildToolSpawnSpec,
  type GeneratedToolHandle,
  ioFromSpawnedChild,
  wireExitCallback,
  wireToolProtocol,
} from "../../../src/toolgen/toolgen-client.ts";
import { assertToolConfinement } from "../../../src/toolgen/toolgen-confinement.ts";
import {
  createDraftToolClosure,
  type DraftGeneration,
} from "../../../src/toolgen/toolgen-draft.ts";
import { createGeneratedTool, type ToolgenGateDeps } from "../../../src/toolgen/toolgen-gate.ts";
import { ToolgenRegistry } from "../../../src/toolgen/toolgen-registry.ts";
import { toolScriptDir, writeToolScript } from "../../../src/toolgen/toolgen-script-store.ts";
import type {
  CreateGeneratedToolRequest,
  ToolgenEnvelope,
  ToolInputSchema,
} from "../../../src/toolgen/toolgen-types.ts";

/**
 * The end-to-end proof that Task 11's WIRING PATTERN is sound: this drives the real
 * `createGeneratedTool` gate, the real sandbox (`SandboxRunner` + `assertToolConfinement`), and the
 * real broker (`ToolgenBroker.handleFetch`) with no mocks below the gate, and Case 1's `draftTool`
 * is built through `createDraftToolClosure` (`toolgen-draft.ts`) — the SAME factory
 * `platform/assemble.ts` calls to build its own `draftTool`, over a fake `generate`/`findEndpoints`
 * rather than a test-authored copy of the composition's shape.
 *
 * **Stated bound, precisely:** this file does NOT import or exercise `assemble.ts` itself, and its
 * `bindCredentials`/`revokeCredentials` are test-authored no-op stubs, not the
 * `writeToolCredential`/`deleteToolCredential`-backed ones `assemble.ts` wires (this suite never
 * supplies a credential, so there is nothing for them to do). Reverting `assemble.ts`'s
 * `bindCredentials`/`revokeCredentials` bodies would NOT change either test's outcome. What IS
 * proven, and reverting WOULD change: (a) `createDraftToolClosure(deps)` — the exact composition
 * `assemble.ts`'s `draftTool` is built from — produces a working, callable tool when driven by the
 * real gate/sandbox/broker (Case 1), and (b) the composition pattern the whole gate is built
 * around holds even when a `draftTool` bypasses the drafting ladder outright (Case 2). Only the
 * outermost network hop is swapped for a local stand-in, the same seam `toolgen-broker.test.ts`
 * itself uses (`doFetch`/`resolveHost` are legitimate injection points; `isForbiddenAddress`
 * refuses a loopback destination even for an approved host, so a loopback stub server can never be
 * the thing the broker is TOLD to dial — only what `doFetch` redirects to).
 *
 * Guard shape (Windows helper path override, set before any `createSandboxRunner()` call, and the
 * env-forwarding spawn helper below) is copied deliberately from
 * `toolgen-network-denied.test.ts`: under `bun test`, `process.execPath` resolves to the installed
 * `~/.bun/bin/bun.exe`, not this repo's `src-native` build output, and the runner captures the
 * probe result at construction. Like that file, this one does NOT skip on a missing prerequisite —
 * a skip here would prove nothing about whether the wired drafting path actually produces a
 * callable tool, so a missing sandbox helper fails loudly instead.
 *
 * NOTHING is substituted in the confinement step any more, and that is a CHANGE: this file used to
 * inject its own `inlineFsDeniedProbe` through `ToolConfinementDeps.spawnProbe`, because
 * `assertToolConfinement`'s default probe spawned the `@nimbus-dev/sdk` probe SCRIPT as a bare file
 * argument (`bun <probe.js> --probe=fs-denied`) — on Windows the exact "file entry point" shape
 * `toolgen-client.ts` documents as a measured dead end under the AppContainer
 * (`CouldntReadCurrentDirectory`), and, once switched to `-e`, a program living under
 * `node_modules/.bun/...`, a path no generated-tool manifest grants read to. That inline probe has
 * been MOVED INTO `toolgen-confinement.ts` (see its `INLINE_FS_DENIED_PROBE` docstring, which also
 * records why the target it reads is a caller-written sentinel rather than `/etc/passwd`), so the
 * default probe is now the one this suite drives. The test injection is gone with it: what runs
 * here is what production runs.
 *
 * This run ALSO surfaced, and this task fixes, a THIRD, genuinely production-blocking defect one
 * level up: `assertToolConfinement` runs BEFORE `writeScript` creates the tool's own script
 * directory (by design — nothing may be written before the owner approves), so its manifest names
 * a grant target that does not exist yet. `bwrap`/`sandbox-exec` tolerate that; the Windows
 * helper's ACL grant does not (`GetNamedSecurityInfoW` on a missing path fails with
 * `ERROR_PATH_NOT_FOUND`, exit 66) — meaning EVERY confinement check, and hence every
 * `nimbus tool create`, failed on Windows regardless of what probe ran. `toolgen-confinement.ts`
 * now creates the manifest's granted directories (empty — never the approved body) before probing;
 * see its own updated docstring. Every OTHER step — `canConfine`, the manifest, the approval gate,
 * the actual generated-tool spawn, the broker — is exercised completely unmocked.
 */

const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

const STUB_HOST = "api.example.com";
const STUB_PAYLOAD = { ok: true, value: 42 };

let server: ReturnType<typeof Bun.serve>;
let hits = 0;
// The URL the broker was TOLD to dial (before `doFetch` redirects it at the stub server). This is
// what makes an argument observable end to end: the stub answers every path identically, so
// without recording it, a body that ignored `args` entirely would look exactly the same.
let dialed = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => {
      hits += 1;
      return new Response(JSON.stringify(STUB_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

/**
 * Reimplements `spawnGeneratedTool`'s body (`toolgen-client.ts`) rather than calling it directly,
 * for exactly the reason `toolgen-network-denied.test.ts` does the same: `extensionProcessEnv`
 * deliberately does NOT forward `NIMBUS_SANDBOX_HELPER_PATH` (I1's baseline-key scoping), so the
 * spawned `__nimbus-sandbox` wrapper re-resolves the helper path in ITS OWN process and would miss
 * this repo's `src-native` build entirely under `bun test`. Every function called here
 * (`buildToolSpawnSpec`, `ioFromSpawnedChild`, `wireExitCallback`, `wireToolProtocol`) is the exact
 * production primitive `spawnGeneratedTool` itself calls — this only adds the one env key a test
 * run needs forwarded.
 */
async function spawnConfined(
  envelope: ToolgenEnvelope,
  broker: ToolgenBroker,
  cwd: string,
  onExit: () => void,
): Promise<GeneratedToolHandle> {
  const spec = buildToolSpawnSpec(envelope, cwd);
  const env = { ...spec.env };
  if (process.env["NIMBUS_SANDBOX_HELPER_PATH"] !== undefined) {
    env["NIMBUS_SANDBOX_HELPER_PATH"] = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
  const child = Bun.spawn<"pipe", "pipe", "inherit">([spec.command, ...spec.args], {
    env,
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const io = ioFromSpawnedChild(child);
  wireExitCallback(io, onExit);
  return wireToolProtocol(io, envelope, broker);
}

/**
 * A broker wired the same way `platform/assemble.ts` wires the real one, except for the two
 * network-hop seams `toolgen-broker.test.ts` itself uses: `resolveHost` answers a public-looking
 * address for the one approved host (so the broker's own loopback/RFC1918 address check — which
 * refuses a resolved loopback address EVEN FOR AN APPROVED HOST — has something to pass), and
 * `doFetch` redirects the actually-dialed request to the local stub server instead of the real
 * internet. Every other check (scheme, approved-host match, address validation, credential
 * attachment, the egress ledger append) is the real `ToolgenBroker.handleFetch`.
 */
function buildBroker(db: Database, registry: ToolgenRegistry): ToolgenBroker {
  return new ToolgenBroker({
    db,
    now: () => Date.now(),
    maxRequestsPerTool: DEFAULT_NIMBUS_TOOL_GENERATION_TOML.maxRequestsPerTool,
    requestTimeoutMs: DEFAULT_NIMBUS_TOOL_GENERATION_TOML.requestTimeoutMs,
    resolveHost: async (host) => (host === STUB_HOST ? ["93.184.216.34"] : []),
    readCredential: async () => null,
    approvedHostsFor: (toolId) => registry.get(toolId)?.artifact.approvedHosts ?? [],
    // No case in this file ever binds a credential -- an always-empty list mirrors
    // `approvedHostsFor`'s fail-closed `?? []` for a toolId with none.
    credentialHostsFor: (toolId) => registry.get(toolId)?.artifact.credentialHosts ?? [],
    doFetch: async (url, init) => {
      dialed = url;
      return fetch(`http://127.0.0.1:${server.port}/`, init);
    },
  });
}

interface Harness {
  readonly db: Database;
  readonly configDir: string;
  readonly registry: ToolgenRegistry;
  readonly broker: ToolgenBroker;
  gateDeps(opts: {
    readonly draftTool: ToolgenGateDeps["draftTool"];
    readonly onSpawned: (handle: GeneratedToolHandle) => void;
  }): ToolgenGateDeps;
  cleanup(): Promise<void>;
}

async function buildHarness(dirTag: string): Promise<Harness> {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const configDir = mkdtempSync(join(tmpdir(), `nimbus-toolgen-e2e-${dirTag}-`));
  const registry = new ToolgenRegistry();
  const broker = buildBroker(db, registry);
  const sandboxRunner = await createSandboxRunner();

  return {
    db,
    configDir,
    registry,
    broker,
    gateDeps: (opts) => ({
      db,
      config: { ...DEFAULT_NIMBUS_TOOL_GENERATION_TOML, enabled: true },
      enforced: { capabilitiesDisabled: new Set<string>() },
      registry,
      draftTool: opts.draftTool,
      // The REAL default probe — no `spawnProbe` injection. What runs here is what production runs.
      assertConfinement: (manifest) =>
        assertToolConfinement({ runner: sandboxRunner, manifest, cwd: configDir }),
      scriptDir: (toolId) => toolScriptDir(configDir, toolId),
      writeScript: (toolId, source) => writeToolScript(configDir, toolId, source),
      spawn: async (envelope) => {
        const handle = await spawnConfined(envelope, broker, dirname(envelope.scriptPath), () =>
          registry.markTerminated(envelope.artifact.toolId),
        );
        opts.onSpawned(handle);
        return handle;
      },
      requestApproval: async () => true,
      bindCredentials: async () => [],
      revokeCredentials: async () => {},
      now: () => Date.now(),
      newId: () => randomUUID(),
    }),
    cleanup: async () => {
      await registry.revokeAll();
      rmSync(configDir, { recursive: true, force: true });
      db.close();
    },
  };
}

function toolEgressRows(db: Database): { destination: string; result_status: string }[] {
  return db
    .query<{ destination: string; result_status: string }, []>(
      "SELECT destination, result_status FROM egress_ledger WHERE source_type = 'tool'",
    )
    .all();
}

describe("toolgen drafting end to end", () => {
  test("create → approve → call returns the stub host's payload", async () => {
    hits = 0;
    const h = await buildHarness("happy");
    let handle: GeneratedToolHandle | undefined;

    // `createDraftToolClosure` is the SAME factory `assemble.ts` calls to build its own
    // `draftTool` (see its docstring there) — this drives that literal function over a fake
    // `generate` (standing in for `createToolgenDraftLlm`'s router-backed one) and a fake
    // `findEndpoints` (standing in for `createEndpointFinder`'s index-backed one), not a
    // test-authored copy of its shape. The fake `generate` answer is what a real drafting model is
    // supposed to produce — a JSON envelope naming a body that calls `nimbusFetch`, never the
    // sandbox-refused raw `fetch()` — so it must pass every ladder rung (JSON envelope, restricted
    // schema, body syntax, forbidden-globals scan) exactly like a genuine model answer would.
    //
    // The schema declares ONE REQUIRED property and the body actually READS it, so the argument
    // travels the whole way: test -> `handle.call({ resource })` -> the sandboxed child's
    // `__invoke(args)` -> the URL it builds -> `nimbusFetch` -> the broker -> the stub server.
    // Case 1 used an EMPTY schema on both sides, which made the `describe()` echo assertion
    // (`toEqual({ type: "object", properties: {} })`) almost vacuous — it compared one empty object
    // against another and would have passed even if the schema had never been baked into the
    // emitted script at all.
    const fakeGenerate = async (_prompt: string): Promise<DraftGeneration | null> => ({
      text: JSON.stringify({
        inputSchema: {
          type: "object",
          properties: { resource: { type: "string", description: "the path segment to fetch" } },
          required: ["resource"],
        },
        body:
          'const res = await nimbusFetch("https://api.example.com/" + args.resource, { method: "GET" }); ' +
          "return JSON.parse(res.body);",
      }),
      isLocal: true,
    });
    const draftTool: ToolgenGateDeps["draftTool"] = createDraftToolClosure({
      generate: fakeGenerate,
      hasDraftRoute: async () => true,
      findEndpoints: async () => [],
    });

    const gateDeps = h.gateDeps({
      draftTool,
      onSpawned: (handle_) => {
        handle = handle_;
      },
    });

    const req: CreateGeneratedToolRequest = {
      sessionId: "s1",
      description: "fetch a JSON payload from the example API",
      hosts: [STUB_HOST],
    };

    try {
      const outcome = await createGeneratedTool(req, gateDeps);

      expect(outcome.status).toBe("registered");
      if (outcome.status !== "registered") throw new Error("unreachable");

      // Annotated, not inferred: without it TypeScript widens `type` to `string` and the
      // `toEqual` overload rejects it against `ToolInputSchema`'s literal `"object"` and scalar
      // union. `bun run typecheck` cannot see this file — no tsconfig `include` covers
      // `packages/gateway/test/**` — so only `typecheck:tests` catches it, and that gate is
      // advisory on Windows and Linux-authoritative in CI.
      const approvedSchema: ToolInputSchema = {
        type: "object",
        properties: { resource: { type: "string", description: "the path segment to fetch" } },
        required: ["resource"],
      };
      const envelope = h.registry.get(outcome.toolId);
      expect(envelope?.artifact.inputSchema).toEqual(approvedSchema);
      expect(envelope?.artifact.approvedHosts).toEqual([STUB_HOST]);

      // `describe()` crosses the SAME wire protocol a `toolgen.list`/agent-facing caller would —
      // it reports the APPROVED schema, not a caller-supplied one, because the child echoes back
      // exactly what `emitToolScript` baked into it from the artifact the owner approved. With a
      // non-empty schema this compares real structure — property name, type, description and
      // `required` — rather than one empty object against another.
      expect(handle).toBeDefined();
      const described = await handle?.describe();
      expect(described?.inputSchema).toEqual(approvedSchema);

      // The call travels: test → sandboxed child (`__invoke`) → `nimbusFetch` → stdio →
      // `wireToolProtocol` → `ToolgenBroker.handleFetch` → the stub server → back the same way.
      dialed = "";
      const result = await handle?.call({ resource: "data" });
      expect(result).toEqual(STUB_PAYLOAD);
      expect(hits).toBe(1);
      // The ARGUMENT actually travelled: the URL the broker was asked to dial was built inside the
      // sandboxed child from `args.resource`. The stub server answers every path identically, so
      // this — not the response body — is what distinguishes "the argument arrived" from "the body
      // ignored it".
      expect(dialed).toBe(`https://${STUB_HOST}/data`);

      // Exactly ONE `tool`-class row — the one call this test made, nothing more, nothing less.
      expect(toolEgressRows(h.db)).toEqual([
        { destination: STUB_HOST, result_status: "authorized" },
      ]);
    } finally {
      await handle?.close();
      await h.cleanup();
    }
  }, 30_000);

  describe("a body calling raw fetch() is blocked at the OS, not merely unreached", () => {
    // The SAME URL both the control and the confined case dial — THIS process's own local stub
    // server, the one `hits`/hit-counting already tracks. Earlier, this pointed the raw-`fetch()`
    // body at `STUB_HOST` ("api.example.com"), which `resolveHost` in this file answers with
    // `93.184.216.34` — a real public address the sandboxed child's raw `fetch()` never actually
    // reached, so `expect(hits).toBe(0)` passed whether the sandbox worked or not (and would have
    // failed for an unrelated reason — no outbound internet — on an air-gapped machine). Dialing
    // the REAL local stub directly is what makes a nonzero `hits` possible at all, and hence what
    // makes zero hits an informative result.
    const rawFetchUrl = (): string => `http://127.0.0.1:${server.port}/`;

    // POSITIVE CONTROL FIRST, mirroring `toolgen-network-denied.test.ts`. Without it, "zero
    // hits"/"the call rejected" passes for any reason at all — including a stub server that never
    // started, or (critically for THIS claim) a raw `fetch()` that was never going to reach
    // anything in the first place, sandboxed or not. Only a request proven to succeed unconfined,
    // then proven to fail confined, distinguishes "the sandbox blocked it" from "it was never
    // going to work".
    test("control: the SAME request succeeds UNCONFINED", async () => {
      hits = 0;
      const proc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const r = await fetch(${JSON.stringify(rawFetchUrl())}); console.log("REACHED:" + r.status); process.exit(0);`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(out).toContain("REACHED:200");
      expect(hits).toBe(1);
    });

    test("a body calling raw fetch() fails at the OS even though nothing scanned it", async () => {
      hits = 0;
      const h = await buildHarness("rawfetch");
      let handle: GeneratedToolHandle | undefined;

      // Bypasses `draftGeneratedTool`'s ladder entirely by returning a `DraftedTool` DIRECTLY —
      // `scanBodyForForbiddenGlobals` (rung 4) would refuse this body outright, so routing it
      // through the ladder could never reach the sandbox at all. Returning it straight from
      // `draftTool`, the same shape `toolgen-gate.test.ts`'s own fakes use, is what proves the CALL
      // itself fails — i.e. that the SANDBOX, not the scan, is the thing actually stopping this
      // (I39's "no other route exists" claim). The body targets `rawFetchUrl()` — the SAME address
      // the control above just proved reachable unconfined.
      const draftTool: ToolgenGateDeps["draftTool"] = async () => ({
        body: `const res = await fetch(${JSON.stringify(rawFetchUrl())}); return await res.text();`,
        inputSchema: { type: "object", properties: {} },
        grounding: { kind: "description_only" },
        attempts: 1,
        locality: "local",
      });

      const gateDeps = h.gateDeps({
        draftTool,
        onSpawned: (handle_) => {
          handle = handle_;
        },
      });

      const req: CreateGeneratedToolRequest = {
        sessionId: "s2",
        description: "raw fetch bypass probe",
        hosts: [STUB_HOST],
      };

      try {
        const outcome = await createGeneratedTool(req, gateDeps);

        expect(outcome.status).toBe("registered");
        expect(handle).toBeDefined();

        // The generated body's raw `fetch()` never reaches `nimbusFetch`/the broker at all — the
        // sandbox's empty `permissions.network` (built BY CONSTRUCTION, I39) denies the connection
        // at the OS, inside the confined child, before any wire message is ever sent.
        await expect(handle?.call({})).rejects.toThrow();

        // The stub server never saw a request, and no `tool`-class row exists — the broker was
        // never even asked, which is what distinguishes "blocked at the OS" from "refused by the
        // broker's own checks" (the latter DOES append a `blocked` row; see
        // `toolgen-broker.test.ts`). Informative now, not a foregone conclusion: the control above
        // just proved this exact URL WOULD have registered a hit had the request gone through.
        expect(hits).toBe(0);
        expect(toolEgressRows(h.db)).toEqual([]);
      } finally {
        await handle?.close();
        await h.cleanup();
      }
    }, 30_000);
  });
});
