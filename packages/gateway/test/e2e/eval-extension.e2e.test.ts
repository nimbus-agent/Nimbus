// `extension.eval` end to end (invariant I49, the gateway-hosted half): the shared eval fixture
// package is INSTALLED into a REAL gateway subprocess (`extension.install`, HITL), then evaluated
// through `extension.eval` over a REAL socket / named pipe, with the eval child spawned under this
// OS's REAL sandbox. Every other test of the installed path drives `evaluateInstalledExtensions`
// in process with a fake MCP client; only this one proves the routing, the consent round trip on
// the calling client, the score over real MCP replies, and that a DENIED approval makes no stage.
//
// The numbers are the ones eval-role.e2e holds the `--package` path to: the same package and the
// same suite, so the two paths cannot drift apart unseen.
//
// LAN: `extension.eval` is LAN-forbidden (`ipc/lan-rpc.ts`), but this runner never opens a LAN
// listener (no `[lan]` config, and pairing needs a second peer), so that refusal is held by the
// I5/I49 unit tests, not here.
//
// The last two tests drive `nimbus eval --installed` (the CLI's `runEvalInstalled`, in process:
// the CLI binary refuses a non-TTY) over this file's client, against the fixture plus a second
// installed extension with no `evals/`. The test tree may import CLI source (the
// gateway-no-import-cli-ui rule covers `packages/gateway/src` only; migration.e2e does the same).
//
// Embeddings are skipped (startRealGateway sets NIMBUS_SKIP_EMBEDDING_RUNTIME=1).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runEvalInstalled } from "../../../cli/src/commands/eval-installed.ts";
import { EXTENSION_STAGE_DIR_NAME } from "../../src/platform/sandbox/sandbox-cwd.ts";
import {
  buildEvalFixturePackage,
  EVAL_FIXTURE_EXPECTED,
  EVAL_FIXTURE_ID,
  evalSandboxAvailable,
  installDefaultHelper,
} from "./_fixtures/eval-fixture-package.ts";
import { startRealGateway, TinyIpcClient } from "./_fixtures/real-gateway-client.ts";

const IS_CI = process.env["CI"] === "true";
/** CI runners are 13-18x slower than a dev machine; one 7-case eval (with a crash) stays inside. */
const EVAL_TIMEOUT_MS = 240_000;

const sandboxAvailable = await evalSandboxAvailable("eval-extension-e2e-probe");

/** A skip and a pass read the same in a CI summary; on CI an unconfinable sandbox fails by name. */
describe.skipIf(sandboxAvailable || !IS_CI)("eval extension e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the confined eval", () => {
    expect(
      "eval-extension-e2e: CI precondition unmet -- the platform sandbox cannot confine a " +
        "no-network policy, so the eval child cannot be spawned. Install this platform's sandbox " +
        "dependency (scripts/linux/install-sandbox-deps.sh on Linux, build:sandbox-helper:win32 " +
        "on Windows).",
    ).toBeNull();
  });
});

type EvalResult =
  | {
      id: string;
      version: string;
      ok: true;
      report: {
        cases: number;
        passed: number;
        score: number;
        rubrics: Record<string, { cases: number; passed: number }>;
        results: Array<{ case: string; pass: boolean; reason: string | null }>;
      };
    }
  | { id: string; version: string | null; ok: false; error: { code: string; message: string } };

/** A second installed extension with NO `evals/`: `--installed` must report it, never prompt for it. */
const NO_SUITES_ID = "e2e.nosuites";

/** One `--installed --json` result row (the fields this file asserts). */
type InstalledJsonRow = {
  id: string;
  version: string | null;
  local: number | null;
  registry: { name: string; score: number } | null;
  registryNote?: string;
  delta: number | null;
  status: string;
};

describe.skipIf(!sandboxAvailable)("extension.eval over a real gateway", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-evalext-e2e-"));
  const pkg = join(tmp, "pkg");
  const client = new TinyIpcClient();
  let gw: Awaited<ReturnType<typeof startRealGateway>> | undefined;
  let restoreHelper: () => void = () => {};

  /** Every consent prompt the gateway raised, and the answer the next one gets. */
  const prompts: Array<{ prompt: string }> = [];
  let approve = true;

  /** The root the gateway stages evals under: `<its own sandboxDir>/ext-stage`. */
  function stageRoot(): string {
    if (gw === undefined) throw new Error("gateway not started");
    return join(gw.sandboxDir, EXTENSION_STAGE_DIR_NAME);
  }

  /** Every entry currently under the stage root, sorted. */
  function stageEntries(): string[] {
    const root = stageRoot();
    return existsSync(root) ? readdirSync(root).sort() : [];
  }

  /**
   * Polls the stage root while a call is in flight and records every `eval-*` entry it sees, so a
   * stage made and removed again during the call is still caught. The approved test proves this
   * watcher sees the gateway's real stages; the denial test relies on that.
   */
  function watchEvalStages(): { stop: () => string[] } {
    const seen = new Set<string>();
    const look = (): void => {
      for (const n of stageEntries()) if (n.startsWith("eval-")) seen.add(n);
    };
    look();
    const timer = setInterval(look, 5);
    return {
      stop: () => {
        clearInterval(timer);
        look();
        return [...seen];
      },
    };
  }

  function outputTail(): string {
    return `\n--- gateway output (tail) ---\n${(gw?.output() ?? "").slice(-8000)}`;
  }

  beforeAll(async () => {
    await buildEvalFixturePackage(join(tmp, "scaffold"), pkg);
    restoreHelper = installDefaultHelper();
    gw = await startRealGateway("evalext");
    await client.connect(gw.socketPath);
    client.onNotification("consent.request", (params) => {
      prompts.push({ prompt: String(params["prompt"] ?? "") });
      void client.raw("consent.respond", { requestId: params["requestId"], approved: approve });
    });
  }, 240_000);

  afterAll(async () => {
    client.disconnect();
    await gw?.stop();
    restoreHelper();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("extension.install installs the fixture package behind the owner's approval", async () => {
    const before = prompts.length;
    await client.call("extension.install", { sourcePath: pkg });
    expect(prompts.length).toBeGreaterThan(before);
  }, 60_000);

  test("an unknown id is refused per id before any prompt", async () => {
    const before = prompts.length;
    const out = await client.call<{ results: EvalResult[] }>("extension.eval", {
      ids: ["e2e.not-installed"],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: "e2e.not-installed", ok: false });
    expect(prompts.length).toBe(before);
  }, 60_000);

  test(
    "an approved extension.eval scores the installed package: 7 cases, 5 passed, 71",
    async () => {
      const before = prompts.length;
      const watch = watchEvalStages();
      let staged: string[];
      let out: { results: EvalResult[] };
      try {
        out = await client.call<{ results: EvalResult[] }>("extension.eval", {
          ids: [EVAL_FIXTURE_ID],
        });
      } finally {
        staged = watch.stop();
      }
      // Positive control for the denial test below: the gateway really stages under the root this
      // file watches, and the watcher sees those stages while the call is in flight.
      expect(staged.length).toBeGreaterThan(0);
      // Exactly ONE approval for the call, and it named the extension.
      const raised = prompts.slice(before);
      expect(raised).toHaveLength(1);
      expect(raised[0]?.prompt).toContain("extension.eval");
      expect(raised[0]?.prompt).toContain(EVAL_FIXTURE_ID);

      expect(out.results).toHaveLength(1);
      const r = out.results[0];
      if (r?.ok !== true)
        throw new Error(`expected a report, got ${JSON.stringify(r)}${outputTail()}`);
      expect(r.id).toBe(EVAL_FIXTURE_ID);
      expect(r.version).toBe("1.0.0");
      if (r.report.passed !== EVAL_FIXTURE_EXPECTED.passed) console.error(outputTail());
      expect(r.report).toMatchObject(EVAL_FIXTURE_EXPECTED);
      const byName = new Map(r.report.results.map((c) => [c.case, c]));
      expect(byName.get("die-is-a-crash")).toMatchObject({ pass: false, reason: "crash" });
      // The confined child could NOT reach the network (the reply took the error branch).
      expect(byName.get("net-is-blocked")).toMatchObject({ pass: true });
    },
    EVAL_TIMEOUT_MS + 10_000,
  );

  test("the evaluation granted nothing: the extension still has no run grant", async () => {
    const out = await client.call<{ extensions: Array<{ id: string; runState: string }> }>(
      "extension.list",
      {},
    );
    expect(out.extensions.find((e) => e.id === EVAL_FIXTURE_ID)?.runState).toBe("no_grant");
  }, 60_000);

  test("a denied extension.eval is ERR_EXTENSION_EVAL_NOT_APPROVED and makes no stage", async () => {
    // The same root the approved test above saw the gateway stage under (its positive control).
    mkdirSync(stageRoot(), { recursive: true });
    const entriesBefore = stageEntries();
    const before = prompts.length;
    approve = false;
    const watch = watchEvalStages();
    let staged: string[];
    try {
      const reply = await client.raw("extension.eval", { ids: [EVAL_FIXTURE_ID] });
      expect(reply.result).toBeUndefined();
      expect(reply.error?.code).toBe(-32603);
      expect(reply.error?.message).toContain("ERR_EXTENSION_EVAL_NOT_APPROVED");
    } finally {
      approve = true;
      staged = watch.stop();
    }
    expect(prompts.length).toBe(before + 1);
    // Nothing ran: no eval stage was seen during the call, and the root's entries are unchanged.
    expect(staged.filter((n) => !entriesBefore.includes(n))).toEqual([]);
    expect(stageEntries()).toEqual(entriesBefore);
  }, 60_000);

  /** `runEvalInstalled`'s deps over this file's client, recording every method it calls. */
  function installedDeps(): {
    deps: Parameters<typeof runEvalInstalled>[1];
    methods: string[];
    out: string[];
    errs: string[];
  } {
    const methods: string[] = [];
    const out: string[] = [];
    const errs: string[] = [];
    return {
      methods,
      out,
      errs,
      deps: {
        call: <T>(method: string, params: Record<string, unknown>): Promise<T> => {
          methods.push(method);
          return client.call<T>(method, params);
        },
        log: (s) => out.push(s),
        err: (s) => errs.push(s),
      },
    };
  }

  test("a second extension with no evals/ installs as a local package", async () => {
    // The fixture's own bundle under another id, with no suites: a real install, no stand-in row.
    const pkg2 = join(tmp, "pkg-nosuites");
    cpSync(join(pkg, "dist"), join(pkg2, "dist"), { recursive: true });
    writeFileSync(
      join(pkg2, "nimbus.extension.json"),
      JSON.stringify({ id: NO_SUITES_ID, version: "1.0.0", entry: "dist/index.js" }, null, 2),
      "utf8",
    );
    const before = prompts.length;
    await client.call("extension.install", { sourcePath: pkg2 });
    expect(prompts.length).toBeGreaterThan(before);
    const out = await client.call<{
      extensions: Array<{ id: string; enabled: number; source_registry: string | null }>;
    }>("extension.list", {});
    expect(out.extensions.map((e) => e.id).sort()).toEqual([NO_SUITES_ID, EVAL_FIXTURE_ID].sort());
    for (const e of out.extensions) {
      expect(e.enabled).toBe(1);
      expect(e.source_registry).toBeNull();
    }
  }, 60_000);

  test(
    "eval --installed: ONE prompt naming only the fixture, its score 71, the other no-suites, exit 0",
    async () => {
      const before = prompts.length;
      const watch = watchEvalStages();
      const run = installedDeps();
      let code: number;
      try {
        code = await runEvalInstalled({ threshold: 5, json: true }, run.deps);
      } finally {
        watch.stop();
      }
      if (code !== 0) console.error(`${run.errs.join("\n")}${outputTail()}`);
      expect(code).toBe(0);
      // extension.list, ONE extension.eval, and no registry read (both are local installs).
      expect(run.methods).toEqual(["extension.list", "extension.eval"]);

      const raised = prompts.slice(before);
      expect(raised).toHaveLength(1);
      expect(raised[0]?.prompt).toContain("extension.eval");
      expect(raised[0]?.prompt).toContain(EVAL_FIXTURE_ID);
      expect(raised[0]?.prompt).not.toContain(NO_SUITES_ID);

      expect(run.out).toHaveLength(1);
      const doc = JSON.parse(run.out[0] ?? "") as {
        threshold: number;
        results: InstalledJsonRow[];
      };
      expect(doc.threshold).toBe(5);
      const byId = new Map(doc.results.map((r) => [r.id, r]));
      expect(doc.results).toHaveLength(2);
      expect(byId.get(EVAL_FIXTURE_ID)).toEqual({
        id: EVAL_FIXTURE_ID,
        version: "1.0.0",
        local: EVAL_FIXTURE_EXPECTED.score,
        registry: null,
        registryNote: "local install",
        delta: null,
        status: "no-registry-score",
      });
      expect(byId.get(NO_SUITES_ID)).toMatchObject({
        id: NO_SUITES_ID,
        local: null,
        registry: null,
        registryNote: "local install",
        delta: null,
        status: "no-suites",
      });
    },
    EVAL_TIMEOUT_MS + 10_000,
  );

  test("eval --installed denied: exit 2, ERR_EXTENSION_EVAL_NOT_APPROVED, nothing evaluated", async () => {
    mkdirSync(stageRoot(), { recursive: true });
    const entriesBefore = stageEntries();
    const before = prompts.length;
    approve = false;
    const watch = watchEvalStages();
    const run = installedDeps();
    let code: number;
    let staged: string[];
    try {
      code = await runEvalInstalled({ threshold: 5, json: false }, run.deps);
    } finally {
      approve = true;
      staged = watch.stop();
    }
    expect(code).toBe(2);
    expect(run.methods).toEqual(["extension.list", "extension.eval"]);
    const raised = prompts.slice(before);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.prompt).toContain(EVAL_FIXTURE_ID);
    expect(raised[0]?.prompt).not.toContain(NO_SUITES_ID);
    // No table: a whole-run failure on stderr, naming the code once.
    expect(run.out).toEqual([]);
    expect(run.errs).toHaveLength(1);
    expect(run.errs[0]).toStartWith("eval failed: ");
    expect(run.errs[0]).toContain("ERR_EXTENSION_EVAL_NOT_APPROVED");
    expect(staged.filter((n) => !entriesBefore.includes(n))).toEqual([]);
    expect(stageEntries()).toEqual(entriesBefore);
  }, 60_000);
});
