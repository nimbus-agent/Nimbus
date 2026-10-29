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
// Embeddings are skipped (startRealGateway sets NIMBUS_SKIP_EMBEDDING_RUNTIME=1).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe.skipIf(!sandboxAvailable)("extension.eval over a real gateway", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-evalext-e2e-"));
  const pkg = join(tmp, "pkg");
  const client = new TinyIpcClient();
  let gw: Awaited<ReturnType<typeof startRealGateway>> | undefined;
  let restoreHelper: () => void = () => {};

  /** Every consent prompt the gateway raised, and the answer the next one gets. */
  const prompts: Array<{ prompt: string }> = [];
  let approve = true;

  /** The `eval-*` stage directories currently under the gateway's sandbox dir. */
  function evalStages(): string[] {
    const root = join(gw?.sandboxDir ?? "", EXTENSION_STAGE_DIR_NAME);
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((n) => n.startsWith("eval-"));
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
      const out = await client.call<{ results: EvalResult[] }>("extension.eval", {
        ids: [EVAL_FIXTURE_ID],
      });
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
    // The approved run above staged under this root, so it exists; a stage made and removed again
    // would still change its mtime, which a listing alone could not see.
    const root = join(gw?.sandboxDir ?? "", EXTENSION_STAGE_DIR_NAME);
    expect(existsSync(root)).toBe(true);
    const stagesBefore = evalStages();
    const mtimeBefore = statSync(root).mtimeMs;
    const before = prompts.length;
    approve = false;
    try {
      const reply = await client.raw("extension.eval", { ids: [EVAL_FIXTURE_ID] });
      expect(reply.result).toBeUndefined();
      expect(reply.error?.code).toBe(-32603);
      expect(reply.error?.message).toContain("ERR_EXTENSION_EVAL_NOT_APPROVED");
    } finally {
      approve = true;
    }
    expect(prompts.length).toBe(before + 1);
    // Nothing ran: no stage appeared, and none was made and removed.
    expect(evalStages().filter((n) => !stagesBefore.includes(n))).toEqual([]);
    expect(statSync(root).mtimeMs).toBe(mtimeBefore);
    // Positive control: making an entry there DOES move the mtime on this filesystem.
    const probe = join(root, `probe-${process.pid}`);
    mkdirSync(probe);
    rmSync(probe, { recursive: true, force: true });
    expect(statSync(root).mtimeMs).not.toBe(mtimeBefore);
  }, 60_000);
});
