/**
 * `score` with the REAL `__nimbus-eval` role: the e2e fixture package (the gateway's
 * `test/e2e/_fixtures/eval-fixture-package.ts`, the same package and suite eval-role.e2e scores)
 * is published into a real registry repository, and `runScore` runs the default role runner —
 * `spawn`, the minimal environment, the caps — against this checkout's gateway through a
 * wrapper script, so the confined extension really runs. The score must equal the e2e's numbers.
 *
 * Gated like the e2e files: only where the platform sandbox can confine a no-network policy, and
 * not on Windows (`spawn` cannot run a script wrapper there without a shell). On Linux CI an
 * unconfinable sandbox fails by name instead of skipping (a skip reads like a pass in a summary).
 *
 * The fixture module is imported by a computed path, so this package's test typecheck does not
 * follow it into the gateway's sources.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePublish } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import { roleRunner, runScore } from "./score.ts";
import {
  makeExtension,
  makeRegistryRepo,
  pushMaintainer,
  writePublish,
} from "./testing/registry-repo.ts";

interface EvalFixture {
  GATEWAY_ENTRY: string;
  EVAL_FIXTURE_SUITE: unknown;
  EVAL_FIXTURE_EXPECTED: {
    cases: number;
    passed: number;
    score: number;
    rubrics: Record<string, { cases: number; passed: number }>;
  };
  buildEvalFixturePackage: (scaffoldRoot: string, pkg: string) => Promise<void>;
  evalSandboxAvailable: (probeId: string) => Promise<boolean>;
}

const IS_CI = process.env["CI"] === "true";
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

const sandboxAvailable = await fx.evalSandboxAvailable("registry-score-real-probe");
const canRun = sandboxAvailable && process.platform !== "win32";

describe.skipIf(sandboxAvailable || !IS_CI || process.platform !== "linux")(
  "registry score (real role) — CI sandbox precondition",
  () => {
    test("fails loudly instead of silently skipping the real role run", () => {
      expect(
        "registry-action score.real: CI precondition unmet -- the platform sandbox cannot confine " +
          "a no-network policy, so the eval role cannot run. The job running these tests must " +
          "install bubblewrap (scripts/linux/install-sandbox-deps.sh).",
      ).toBeNull();
    });
  },
);

describe.skipIf(!canRun)("registry score over the real __nimbus-eval role", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-score-real-"));
  const scratch = join(tmp, "scratch");
  const out = join(tmp, "scores.json");
  const gateway = join(tmp, "nimbus-gateway");
  const summaries: string[] = [];
  const io: ActionIo = {
    annotate: () => {},
    summary: (md) => void summaries.push(md),
    log: () => {},
  };

  beforeAll(async () => {
    mkdirSync(scratch);
    const pkg = join(tmp, "pkg");
    await fx.buildEvalFixturePackage(join(tmp, "scaffold"), pkg);
    // The gateway "executable": this checkout's gateway entry under this very Bun, by absolute path.
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

  test("scores the fixture package with the e2e's numbers", async () => {
    const repo = await makeRegistryRepo(join(tmp, "reg"));
    const ext = await makeExtension(scratch, {
      id: "acme/evalecho",
      dist: readFileSync(join(tmp, "pkg", "dist", "index.js"), "utf8"),
      evals: { "basic.eval.json": JSON.stringify(fx.EVAL_FIXTURE_SUITE, null, 2) },
    });
    writePublish(repo.maintainer, ext);
    pushMaintainer(repo, "main", "publish acme/evalecho");

    const scores = await runScore(
      { workspace: repo.workspace, gateway, out },
      {
        git: gitTree,
        io,
        tmpdir: () => scratch,
        validate: validatePublish,
        runRole: roleRunner(),
        now: Date.now,
      },
    );

    const entry = scores["acme/evalecho@1.0.0"];
    if (entry === undefined || !("quality" in entry)) {
      throw new Error(`expected a quality: ${JSON.stringify(scores)}\n${summaries.join("\n")}`);
    }
    expect(entry.quality as unknown).toEqual({ scorer: 1, ...fx.EVAL_FIXTURE_EXPECTED });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(scores);
  }, 600_000);
});
