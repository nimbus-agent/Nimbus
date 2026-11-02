// `nimbus eval --record` end to end: the REAL CLI spawns the REAL `__nimbus-eval` role over the
// shared eval fixture package (a real bundled MCP server under this OS's real sandbox), the role
// runs each recorded case twice from fresh stages, and the CLI writes a suite. That suite is then
// scored with `nimbus eval --package --suite`: every recorded case must pass. Gated exactly like
// eval-role.e2e: it runs only where the platform sandbox can confine a no-network policy, and
// fails by name on CI when it cannot.
//
// The role resolves its sandbox dir from the platform paths, so every spawn points LOCALAPPDATA /
// HOME / XDG_* at this file's temp dir: no stage is ever made under the real install.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvalSuite } from "@nimbus-dev/registry-format";

import {
  buildEvalFixturePackage,
  CLI_ENTRY,
  EVAL_FIXTURE_SUITE,
  evalSandboxAvailable,
  installDefaultHelper,
  REPO,
  runCommand,
} from "./_fixtures/eval-fixture-package.ts";

const IS_CI = process.env["CI"] === "true";
const RUN_TIMEOUT_MS = 240_000;

const sandboxAvailable = await evalSandboxAvailable("eval-record-e2e-probe");

describe.skipIf(sandboxAvailable || !IS_CI)("eval record e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the confined eval", () => {
    expect(
      "eval-record-e2e: CI precondition unmet -- the platform sandbox cannot confine a " +
        "no-network policy, so the eval child cannot be spawned.",
    ).toBeNull();
  });
});

/** Tools of the fixture package that answer the same on every run, with inputs from its suite. */
const RECORDED_NAMES = ["echo-exact", "echo-json-match", "fail-is-an-error", "structured-text"];

describe.skipIf(!sandboxAvailable)("nimbus eval --record over a real sandboxed extension", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-eval-record-e2e-"));
  const pkg = join(tmp, "pkg");
  const home = join(tmp, "home");
  const inputsFile = join(tmp, "inputs.json");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  let restoreHelper: () => void = () => {};

  const cli = (...args: string[]) =>
    runCommand(["bun", CLI_ENTRY, ...args], REPO, env, RUN_TIMEOUT_MS);

  beforeAll(async () => {
    for (const d of Object.values(env).filter((v) => v.startsWith(home))) {
      mkdirSync(d, { recursive: true });
    }
    await buildEvalFixturePackage(join(tmp, "scaffold"), pkg);
    // The suite the fixture ships is NOT recorded over: the golden file goes beside it.
    const cases = EVAL_FIXTURE_SUITE.cases
      .filter((c) => RECORDED_NAMES.includes(c.name))
      .map((c) => ({ name: c.name, tool: c.tool, input: c.input }));
    writeFileSync(inputsFile, JSON.stringify({ format: 1, name: "golden", cases }), "utf8");
    restoreHelper = installDefaultHelper();
  }, 180_000);

  afterAll(() => {
    restoreHelper();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test(
    "records the package's replies, then the written suite scores 100",
    async () => {
      const rec = await cli("eval", "--package", pkg, "--record", inputsFile);
      const context = `exit ${rec.code}\n${rec.stdout}\n--- stderr ---\n${rec.stderr.slice(-4000)}`;
      expect(rec.code, context).toBe(0);
      expect(rec.stdout).toContain(
        `wrote evals/golden.eval.json: ${RECORDED_NAMES.length} cases recorded, 0 skipped`,
      );
      const target = join(pkg, "evals", "golden.eval.json");
      expect(existsSync(target)).toBe(true);
      const suite = parseEvalSuite("golden", readFileSync(target));
      expect(suite.cases.map((c) => c.name)).toEqual(RECORDED_NAMES);

      const scored = await cli(
        "eval",
        "--package",
        pkg,
        "--suite",
        "evals/golden.eval.json",
        "--json",
      );
      expect(scored.code, `${scored.stdout}\n${scored.stderr.slice(-4000)}`).toBe(0);
      const doc = JSON.parse(scored.stdout.trim()) as {
        ok: boolean;
        report: { score: number; cases: number; passed: number };
      };
      expect(doc.ok).toBe(true);
      expect(doc.report).toMatchObject({
        score: 100,
        cases: RECORDED_NAMES.length,
        passed: RECORDED_NAMES.length,
      });
    },
    RUN_TIMEOUT_MS * 2 + 10_000,
  );

  test("an existing golden file is refused without --force, before any run", async () => {
    const again = await cli("eval", "--package", pkg, "--record", inputsFile);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("--force");
  });
});
