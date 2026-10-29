// The eval e2e fixture package, shared by eval-role.e2e (the `__nimbus-eval` role, `--package`)
// and eval-extension.e2e (`extension.eval` over a real gateway, the installed path). Both evaluate
// the SAME package against the SAME suite, so the two paths are held to the same numbers.
//
// The package is the `nimbus scaffold mcp` output plus four tools, bundled with `bun build
// --target=bun` into one `dist/index.js` (exactly as extension-runtime.e2e builds its fixture): a
// bundle needs no `node_modules`, so the package carries no symlink and an install accepts it.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createSandboxRunner } from "../../../src/platform/sandbox/sandbox-runner.ts";

export const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
export const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
export const GATEWAY_ENTRY = join(REPO, "packages", "gateway", "src", "index.ts");

export const EVAL_FIXTURE_ID = "e2e.evalecho";
export const EVAL_FIXTURE_STDERR_MARKER = "NIMBUS-EVAL-E2E-STDERR-MARKER";

/** What the suite scores against the fixture package, whichever path runs it. */
export const EVAL_FIXTURE_EXPECTED = {
  cases: 7,
  passed: 5,
  score: 71, // floor(5 * 100 / 7)
  rubrics: {
    exact: { cases: 5, passed: 3 },
    "json-match": { cases: 1, passed: 1 },
    "one-of": { cases: 1, passed: 1 },
  },
} as const;

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
  "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);

/** Whether this platform's sandbox can confine a no-network policy here (see user-mcp.e2e). */
export async function evalSandboxAvailable(probeId: string): Promise<boolean> {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: probeId,
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  }
}

/**
 * The eval child is spawned through `wrapServerSpecInCwd`'s `__nimbus-sandbox` re-exec, whose env
 * (I1) never carries `NIMBUS_SANDBOX_HELPER_PATH`, so the wrapper resolves the helper next to
 * `process.execPath`. As in extension-runtime.e2e, the checkout's helper is copied there for the
 * calling file's lifetime only, and removed afterwards only if this call put it there.
 */
export function installDefaultHelper(): () => void {
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

export type CommandResult = { code: number; stdout: string; stderr: string; ms: number };

/** Runs a command to completion, killing it after `timeoutMs`. */
export async function runCommand(
  argv: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs = 240_000,
): Promise<CommandResult> {
  const started = Date.now();
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
    ...(env === undefined ? {} : { env }),
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
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

/**
 * The entry: the scaffold's server (whose `echo` returns its input text) plus `fail` (an MCP
 * error reply, after writing a marker to stderr), `net` (a network attempt, reported as JSON so a
 * suite can match the error branch by path), `structured` (an `outputSchema` tool replying with
 * `structuredContent` AND a text block: through the real `@mastra/mcp` that reply is reshaped,
 * so only this case proves the runtime recovers the text the tool sent) and `die` (the server
 * process exits inside the call). `@mastra/mcp` reconnects once on a dropped transport and retries
 * the call on a new child from the same spec: `die` dies again, so the case is scored `crash`, and
 * the cases after it run on a fresh spawn from a fresh stage. This pins that v1 bound.
 */
const ENTRY_TS = `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createConnection } from "node:net";
import { createServer } from "./server.ts";

const server = createServer();
server.registerTool(
  "fail",
  { description: "Always fails", inputSchema: {} },
  async () => {
    process.stderr.write("${EVAL_FIXTURE_STDERR_MARKER}\\n");
    return { isError: true, content: [{ type: "text", text: "BOOM" }] };
  },
);
server.registerTool(
  "net",
  { description: "Try to reach the network", inputSchema: {} },
  // A raw TCP connect to an IP literal, never fetch(): no DNS, so a confined child fails at once
  // (no route under bwrap's empty netns, denied under AppContainer / SBPL) instead of hanging on
  // name resolution or taking the runtime down, which made the Linux outcome vary run to run.
  async () => {
    const outcome = await new Promise<{ fetched: boolean; error?: string }>((resolve) => {
      try {
        const sock = createConnection({ host: "1.1.1.1", port: 80 });
        sock.setTimeout(3_000, () => {
          sock.destroy();
          resolve({ fetched: false, error: "timeout" });
        });
        sock.once("connect", () => {
          sock.destroy();
          resolve({ fetched: true });
        });
        sock.once("error", (e) => resolve({ fetched: false, error: e.message }));
      } catch (e) {
        resolve({ fetched: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
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

export const EVAL_FIXTURE_SUITE = {
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

/**
 * Builds the fixture package at `pkg`: scaffold through the real CLI under `scaffoldRoot`, link
 * the two dependencies for the BUILD only (the bundle carries them), bundle the entry, then write
 * a manifest with no grants at all and the suite. Nothing is written outside the two directories.
 */
export async function buildEvalFixturePackage(scaffoldRoot: string, pkg: string): Promise<void> {
  const project = join(scaffoldRoot, "evalecho");
  mkdirSync(scaffoldRoot, { recursive: true });
  const scaffold = await runCommand(
    ["bun", CLI_ENTRY, "scaffold", "mcp", "evalecho"],
    scaffoldRoot,
  );
  if (scaffold.code !== 0) {
    throw new Error(`scaffold exited ${scaffold.code}:\n${scaffold.stdout}\n${scaffold.stderr}`);
  }

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

  writeFileSync(join(project, "src", "index.ts"), ENTRY_TS, "utf8");
  const build = await runCommand(
    ["bun", "build", "src/index.ts", "--target=bun", "--outfile", join(pkg, "dist", "index.js")],
    project,
  );
  if (build.code !== 0) {
    throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
  }

  const manifest = { id: EVAL_FIXTURE_ID, version: "1.0.0", entry: "dist/index.js" };
  writeFileSync(join(pkg, "nimbus.extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  mkdirSync(join(pkg, "evals"), { recursive: true });
  writeFileSync(
    join(pkg, "evals", "basic.eval.json"),
    JSON.stringify(EVAL_FIXTURE_SUITE, null, 2),
    "utf8",
  );
}
