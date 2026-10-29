// The `__nimbus-eval` role end to end: a REAL extension package (the `nimbus scaffold mcp` output
// plus four tools, bundled to `dist/index.js` exactly as extension-runtime.e2e builds its
// fixture) is evaluated by a REAL role process, which stages it and spawns it under this OS's REAL
// sandbox (`network: []`, zero filesystem grants, identity `eval.<serviceId>`). Every other eval
// test drives the runtime with a fake client; only this one proves the whole path — the document on
// stdout, the score over real MCP replies, the network denial inside the confined child, a server
// that dies at startup or mid-call, determinism across two runs, and where the child's stderr goes.
//
// The role resolves its sandbox dir from the platform paths, so every spawn of it points
// LOCALAPPDATA / HOME / XDG_CACHE_HOME at this file's temp dir: no stage is ever made under the
// real install.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { EXTENSION_STAGE_DIR_NAME } from "../../src/platform/sandbox/sandbox-cwd.ts";
import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
const GATEWAY_ENTRY = join(REPO, "packages", "gateway", "src", "index.ts");
const IS_CI = process.env["CI"] === "true";

const EXTENSION_ID = "e2e.evalecho";
const STDERR_MARKER = "NIMBUS-EVAL-E2E-STDERR-MARKER";
/** CI runners are 13-18x slower than a dev machine at temp-dir work; one role run stays well inside. */
const ROLE_TIMEOUT_MS = 240_000;

/** The nearest `node_modules/<pkg>` at or above `from` (see user-mcp.e2e.test.ts). */
function installedPackageDir(pkg: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed at or above ${from}`);
  }
}

/** The helper CI (and `bun run build:sandbox-helper:win32`) builds in this checkout. */
const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

/** Whether this platform's sandbox can confine a no-network policy here (see user-mcp.e2e). */
const sandboxAvailable = await (async () => {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "eval-role-e2e-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
})();

/**
 * The eval child is spawned through `wrapServerSpecInCwd`'s `__nimbus-sandbox` re-exec, whose env
 * (I1) never carries `NIMBUS_SANDBOX_HELPER_PATH`, so the wrapper resolves the helper next to
 * `process.execPath`. As in extension-runtime.e2e, the checkout's helper is copied there for this
 * file's lifetime only, and removed afterwards only if this file put it there.
 */
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

/**
 * The entry: the scaffold's server (whose `echo` returns its input text) plus `fail` (an MCP
 * error reply, after writing a marker to stderr), `net` (a real fetch, reported as JSON so a
 * suite can match the error branch by path), `structured` (an `outputSchema` tool replying with
 * `structuredContent` AND a text block: through the real `@mastra/mcp` that reply is reshaped,
 * so only this case proves the runtime recovers the text the tool sent) and `die` (the server
 * process exits inside the call). `@mastra/mcp` reconnects once on a dropped transport and retries
 * the call on a new child from the same spec: `die` dies again, so the case is scored `crash`, and
 * the cases after it run on a fresh spawn from a fresh stage. This pins that v1 bound.
 */
const ENTRY_TS = `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "./server.ts";

const server = createServer();
server.registerTool(
  "fail",
  { description: "Always fails", inputSchema: {} },
  async () => {
    process.stderr.write("${STDERR_MARKER}\\n");
    return { isError: true, content: [{ type: "text", text: "BOOM" }] };
  },
);
server.registerTool(
  "net",
  { description: "Try to reach the network", inputSchema: {} },
  async () => {
    try {
      const res = await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) });
      return { content: [{ type: "text", text: JSON.stringify({ fetched: true, status: res.status }) }] };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: JSON.stringify({ fetched: false, error }) }] };
    }
  },
);
server.registerTool(
  "structured",
  {
    description: "Structured output plus a text block",
    inputSchema: {},
    outputSchema: { answer: z.number() },
  },
  async () => ({
    structuredContent: { answer: 42 },
    content: [{ type: "text", text: "STRUCTURED-TEXT" }],
  }),
);
server.registerTool(
  "die",
  { description: "Exits mid-call", inputSchema: {} },
  async () => {
    process.exit(1);
  },
);
await server.connect(new StdioServerTransport());
`;

const SUITE = {
  format: 1,
  name: "basic",
  cases: [
    {
      name: "echo-exact",
      tool: "echo",
      input: { text: "hello" },
      expect: { rubric: "exact", value: "hello" },
    },
    {
      name: "echo-json-match",
      tool: "echo",
      input: { text: '{"greeting":"hi","n":2}' },
      expect: { rubric: "json-match", value: { greeting: "hi" } },
    },
    {
      name: "fail-is-an-error",
      tool: "fail",
      input: {},
      expect: { rubric: "exact", value: "BOOM", error: true },
    },
    {
      name: "echo-deliberately-wrong",
      tool: "echo",
      input: { text: "hello" },
      expect: { rubric: "exact", value: "goodbye" },
    },
    {
      name: "die-is-a-crash",
      tool: "die",
      input: {},
      expect: { rubric: "exact", value: "never" },
    },
    {
      name: "structured-text",
      tool: "structured",
      input: {},
      expect: { rubric: "exact", value: "STRUCTURED-TEXT" },
    },
    {
      name: "net-is-blocked",
      tool: "net",
      input: {},
      expect: { rubric: "one-of", path: "/fetched", values: [false] },
    },
  ],
};

type RoleResult = { code: number; stdout: string; stderr: string; ms: number };

async function run(argv: string[], cwd: string, env?: Record<string, string>): Promise<RoleResult> {
  const started = Date.now();
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
    ...(env === undefined ? {} : { env }),
  });
  const timer = setTimeout(() => proc.kill(), ROLE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

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
  const project = join(scaffoldRoot, "evalecho");
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
    return run(["bun", GATEWAY_ENTRY, "__nimbus-eval", "--package", dir], REPO, roleEnv);
  }

  beforeAll(async () => {
    for (const d of Object.values(roleEnv).filter((v) => v.startsWith(home))) {
      mkdirSync(d, { recursive: true });
    }
    // 1. Scaffold through the real CLI.
    mkdirSync(scaffoldRoot, { recursive: true });
    const scaffold = await run(["bun", CLI_ENTRY, "scaffold", "mcp", "evalecho"], scaffoldRoot);
    if (scaffold.code !== 0) {
      throw new Error(`scaffold exited ${scaffold.code}:\n${scaffold.stdout}\n${scaffold.stderr}`);
    }

    // 2. Link the two dependencies for the BUILD only (the bundle carries them).
    mkdirSync(join(project, "node_modules", "@modelcontextprotocol"), { recursive: true });
    symlinkSync(
      realpathSync(installedPackageDir("@modelcontextprotocol/sdk", join(REPO, "packages", "cli"))),
      join(project, "node_modules", "@modelcontextprotocol", "sdk"),
      "junction",
    );
    symlinkSync(
      realpathSync(installedPackageDir("zod", join(REPO, "packages", "cli"))),
      join(project, "node_modules", "zod"),
      "junction",
    );

    // 3. Bundle the entry into the package.
    writeFileSync(join(project, "src", "index.ts"), ENTRY_TS, "utf8");
    const build = await run(
      ["bun", "build", "src/index.ts", "--target=bun", "--outfile", join(pkg, "dist", "index.js")],
      project,
    );
    if (build.code !== 0) {
      throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
    }

    // 4. Manifest (no grants at all) and the suite.
    const manifest = { id: EXTENSION_ID, version: "1.0.0", entry: "dist/index.js" };
    writeFileSync(join(pkg, "nimbus.extension.json"), JSON.stringify(manifest, null, 2), "utf8");
    mkdirSync(join(pkg, "evals"), { recursive: true });
    writeFileSync(join(pkg, "evals", "basic.eval.json"), JSON.stringify(SUITE, null, 2), "utf8");

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
      JSON.stringify(SUITE, null, 2),
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
      expect(doc.report.cases).toBe(7);
      expect(doc.report.passed).toBe(5);
      expect(doc.report.score).toBe(71); // floor(5 * 100 / 7)
      expect(doc.report.rubrics).toEqual({
        exact: { cases: 5, passed: 3 },
        "json-match": { cases: 1, passed: 1 },
        "one-of": { cases: 1, passed: 1 },
      });
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
