/**
 * `liveness-check` with the REAL `__nimbus-eval` role (suite and baseline), to show the role call
 * shape is the one `score` uses. Gated exactly like `score.real.test.ts`: only where the platform
 * sandbox can confine a no-network policy, and not on Windows. The host probe is faked: no test
 * reaches the network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { signIndex, validatePublish } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import { runLivenessCheck } from "./liveness-check.ts";
import { baselineRoleRunner } from "./score-baseline.ts";
import { roleRunner } from "./score-role.ts";
import { runSign } from "./sign.ts";
import {
  makeExtension,
  makeRegistryRepo,
  pushMaintainer,
  ROOT_KEY_INPUT,
  writePublish,
} from "./testing/registry-repo.ts";

interface EvalFixture {
  GATEWAY_ENTRY: string;
  EVAL_FIXTURE_SUITE: unknown;
  EVAL_FIXTURE_EXPECTED: { cases: number; passed: number };
  buildEvalFixturePackage: (scaffoldRoot: string, pkg: string) => Promise<void>;
  evalSandboxAvailable: (probeId: string) => Promise<boolean>;
}

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const FIXTURE_PATH = join(
  REPO,
  "packages",
  "gateway",
  "test",
  "e2e",
  "_fixtures",
  "eval-fixture-package.ts",
);
const fx = (await import(pathToFileURL(FIXTURE_PATH).href)) as EvalFixture;

const canRun =
  (await fx.evalSandboxAvailable("registry-liveness-real-probe")) && process.platform !== "win32";

describe.skipIf(!canRun)("registry liveness-check over the real __nimbus-eval role", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-liveness-real-"));
  const scratch = join(tmp, "scratch");
  const out = join(tmp, "liveness-results.json");
  const gateway = join(tmp, "nimbus-gateway");
  const io = { annotate: () => {}, summary: () => {}, log: () => {} };

  beforeAll(async () => {
    mkdirSync(scratch);
    const pkg = join(tmp, "pkg");
    await fx.buildEvalFixturePackage(join(tmp, "scaffold"), pkg);
    writeFileSync(
      gateway,
      `#!/bin/sh\nexec "${process.execPath}" "${fx.GATEWAY_ENTRY}" "$@"\n`,
      "utf8",
    );
    chmodSync(gateway, 0o755);
  }, 300_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the fixture package's suites and baseline come back through the real role", async () => {
    const repo = await makeRegistryRepo(join(tmp, "reg"));
    const ext = await makeExtension(scratch, {
      id: "acme/evalecho",
      network: [],
      dist: readFileSync(join(tmp, "pkg", "dist", "index.js"), "utf8"),
      evals: { "basic.eval.json": JSON.stringify(fx.EVAL_FIXTURE_SUITE, null, 2) },
    });
    writePublish(repo.maintainer, ext);
    pushMaintainer(repo, "main", "publish acme/evalecho");
    await runSign(
      { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
      { validate: validatePublish, sign: signIndex, git: gitTree, io, tmpdir: () => scratch },
    );

    const r = await runLivenessCheck(
      { workspace: repo.workspace, gateway, nimbusVersion: "10.14.1", out },
      {
        git: gitTree,
        io,
        tmpdir: () => scratch,
        runRole: roleRunner(),
        runBaseline: baselineRoleRunner(),
        probe: {
          lookup: async () => {
            throw new Error("no host is declared, so none is looked up");
          },
          connect: async () => false,
        },
        now: Date.now,
      },
    );
    const entry = r.extensions["acme/evalecho@1.0.0"];
    expect(entry?.tests).toEqual({
      cases: fx.EVAL_FIXTURE_EXPECTED.cases,
      passed: fx.EVAL_FIXTURE_EXPECTED.passed,
    });
    expect(entry?.baseline?.passed).toBe(true);
    expect(entry?.hosts).toBeUndefined();
  }, 600_000);
});
