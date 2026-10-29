// The `__nimbus-eval` role end to end: a REAL extension package (the `nimbus scaffold mcp` output
// plus four tools, bundled to `dist/index.js` by the shared `_fixtures/eval-fixture-package.ts`)
// is evaluated by a REAL role process, which stages it and spawns it under this OS's REAL sandbox
// (`network: []`, zero filesystem grants, identity `eval.<serviceId>`). Every other eval
// test drives the runtime with a fake client; only this one proves the whole path — the document on
// stdout, the score over real MCP replies, the network denial inside the confined child, a server
// that dies at startup or mid-call, determinism across two runs, and where the child's stderr goes.
//
// The role resolves its sandbox dir from the platform paths, so every spawn of it points
// LOCALAPPDATA / HOME / XDG_CACHE_HOME at this file's temp dir: no stage is ever made under the
// real install.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXTENSION_STAGE_DIR_NAME } from "../../src/platform/sandbox/sandbox-cwd.ts";
import {
  buildEvalFixturePackage,
  type CommandResult,
  EVAL_FIXTURE_EXPECTED,
  EVAL_FIXTURE_ID,
  EVAL_FIXTURE_STDERR_MARKER,
  EVAL_FIXTURE_SUITE,
  evalSandboxAvailable,
  GATEWAY_ENTRY,
  installDefaultHelper,
  REPO,
  runCommand,
} from "./_fixtures/eval-fixture-package.ts";

const IS_CI = process.env["CI"] === "true";

const EXTENSION_ID = EVAL_FIXTURE_ID;
const STDERR_MARKER = EVAL_FIXTURE_STDERR_MARKER;
/** CI runners are 13-18x slower than a dev machine at temp-dir work; one role run stays well inside. */
const ROLE_TIMEOUT_MS = 240_000;

const sandboxAvailable = await evalSandboxAvailable("eval-role-e2e-probe");

/** A skip and a pass read the same in a CI summary; on CI an unconfinable sandbox fails by name. */
describe.skipIf(sandboxAvailable || !IS_CI)("eval role e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the confined eval", () => {
    expect(
      "eval-role-e2e: CI precondition unmet -- the platform sandbox cannot confine a " +
        "no-network policy, so the eval child cannot be spawned. Install this platform's sandbox " +
        "dependency (scripts/linux/install-sandbox-deps.sh on Linux, build:sandbox-helper:win32 " +
        "on Windows).",
    ).toBeNull();
  });
});

type RoleResult = CommandResult;

type CaseResult = {
  suite: string;
  case: string;
  rubric: string;
  pass: boolean;
  reason: string | null;
};
type Report = {
  scorer: number;
  score: number;
  cases: number;
  passed: number;
  rubrics: Record<string, { cases: number; passed: number }>;
  results: CaseResult[];
};
type RoleDocument =
  | { ok: true; extensionId: string; version: string; report: Report }
  | { ok: false; error: { code: string; message: string } };

/** Exactly one JSON line on stdout, and nothing else; the stderr tail on failure. */
function documentOf(r: RoleResult): RoleDocument {
  const context = `exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr (tail) ---\n${r.stderr.slice(-6000)}`;
  if (r.code !== 0) throw new Error(`role failed: ${context}`);
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== 1 || !r.stdout.endsWith("\n")) {
    throw new Error(`expected exactly one stdout line: ${context}`);
  }
  return JSON.parse(lines[0] ?? "") as RoleDocument;
}

describe.skipIf(!sandboxAvailable)("the __nimbus-eval role over a real sandboxed extension", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-eval-e2e-"));
  const scaffoldRoot = join(tmp, "scaffold");
  const pkg = join(tmp, "pkg");
  const deadPkg = join(tmp, "dead-pkg");
  const home = join(tmp, "home");
  /** Every platform-path root the role could resolve its sandbox dir from, inside `tmp`. */
  const roleEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  let restoreHelper: () => void = () => {};
  let first: RoleResult | undefined;

  function evalRole(dir: string): Promise<RoleResult> {
    return runCommand(
      ["bun", GATEWAY_ENTRY, "__nimbus-eval", "--package", dir],
      REPO,
      roleEnv,
      ROLE_TIMEOUT_MS,
    );
  }

  beforeAll(async () => {
    for (const d of Object.values(roleEnv).filter((v) => v.startsWith(home))) {
      mkdirSync(d, { recursive: true });
    }
    // 1-4. The shared fixture package (scaffold, link, bundle, manifest + suite).
    await buildEvalFixturePackage(scaffoldRoot, pkg);

    // 5. A package whose server exits before it ever answers.
    mkdirSync(join(deadPkg, "dist"), { recursive: true });
    mkdirSync(join(deadPkg, "evals"), { recursive: true });
    writeFileSync(join(deadPkg, "dist", "index.js"), "process.exit(3);\n", "utf8");
    writeFileSync(
      join(deadPkg, "nimbus.extension.json"),
      JSON.stringify({ id: "e2e.evaldead", version: "1.0.0", entry: "dist/index.js" }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(deadPkg, "evals", "basic.eval.json"),
      JSON.stringify(EVAL_FIXTURE_SUITE, null, 2),
      "utf8",
    );

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
    "scores the package: one JSON line, 7 cases, 5 passed, 71",
    async () => {
      first = await evalRole(pkg);
      const doc = documentOf(first);
      if (!doc.ok) throw new Error(`eval error: ${JSON.stringify(doc.error)}\n${first.stderr}`);
      expect(doc.extensionId).toBe(EXTENSION_ID);
      expect(doc.version).toBe("1.0.0");
      // On a mismatch the role's stderr (the extension child's included) is the only clue on a CI leg.
      if (doc.report.passed !== 5) console.error(first.stderr);
      // 7 cases, 5 passed, score floor(5 * 100 / 7) = 71: the same numbers eval-extension.e2e
      // holds the gateway's installed path to.
      expect(doc.report).toMatchObject(EVAL_FIXTURE_EXPECTED);
      const byName = new Map(doc.report.results.map((r) => [r.case, r]));
      for (const r of doc.report.results) expect(r.suite).toBe("evals/basic.eval.json");
      expect(byName.get("echo-exact")).toMatchObject({ pass: true, reason: null });
      expect(byName.get("echo-json-match")).toMatchObject({ pass: true, reason: null });
      expect(byName.get("fail-is-an-error")).toMatchObject({ pass: true, reason: null });
      expect(byName.get("structured-text")).toMatchObject({ pass: true, reason: null });
      // The server exited mid-call (twice: @mastra/mcp's one in-place retry) and the run went on.
      expect(byName.get("die-is-a-crash")).toMatchObject({ pass: false, reason: "crash" });
      expect(byName.get("echo-deliberately-wrong")).toMatchObject({
        rubric: "exact",
        pass: false,
        reason: "text differs",
      });
      // The confined child could NOT fetch: its reply took the error branch (`fetched: false`).
      // Windows (AppContainer without internetClient), macOS (SBPL) and Linux (bwrap
      // --unshare-net) fail it differently, so only the branch is asserted, never the message.
      expect(byName.get("net-is-blocked")).toMatchObject({ rubric: "one-of", pass: true });
    },
    ROLE_TIMEOUT_MS + 10_000,
  );

  test("the child's stderr reaches the role's stderr, never its stdout", () => {
    if (first === undefined) throw new Error("the scoring test did not run");
    expect(first.stdout).not.toContain(STDERR_MARKER);
    expect(first.stderr).toContain(STDERR_MARKER);
  });

  test(
    "a second run produces the identical report",
    async () => {
      if (first === undefined) throw new Error("the scoring test did not run");
      const a = documentOf(first);
      expect(a.ok).toBe(true);
      const b = documentOf(await evalRole(pkg));
      expect(b).toEqual(a);
    },
    ROLE_TIMEOUT_MS + 10_000,
  );

  test(
    "a server that exits at startup is ERR_EVAL_START_FAILED",
    async () => {
      const doc = documentOf(await evalRole(deadPkg));
      expect(doc.ok).toBe(false);
      if (doc.ok) return;
      expect(doc.error.code).toBe("ERR_EVAL_START_FAILED");
    },
    ROLE_TIMEOUT_MS + 10_000,
  );

  test("every eval stage was made under the redirected sandbox dir, and none is left behind", () => {
    if (first === undefined) throw new Error("the scoring test did not run");
    const stageRoots = [
      join(roleEnv["LOCALAPPDATA"] ?? "", "Nimbus", "sandbox"),
      join(home, "Library", "Caches", "Nimbus", "sandbox"),
      join(roleEnv["XDG_CACHE_HOME"] ?? "", "nimbus", "sandbox"),
    ].map((root) => join(root, EXTENSION_STAGE_DIR_NAME));
    const used = stageRoots.filter((dir) => existsSync(dir));
    // Positive control: the role really resolved its sandbox dir inside this file's temp dir.
    expect(used.length).toBe(1);
    for (const dir of used) {
      expect(readdirSync(dir).filter((n) => n.startsWith("eval-"))).toEqual([]);
    }
  });
});
