// Extension publishing, end to end (registry publishing design § 8): an author scaffolds a
// namespaced extension, builds it, makes a key, signs it and publishes it into a local clone of a
// git-repository registry; the registry action's `check` passes the publish branch; the branch is
// merged; the action's `sign` signs it onto `gh-pages`; and a REAL gateway adds that `gh-pages`
// tree as a registry, installs the extension from it, approves it to run and lists its `echo`
// tool from the running, sandboxed child. Every other test for publishing stops at one seam (the
// validator, the action against fixture extensions, the CLI against a fake `gh`); this one proves
// the seams fit: what `scaffold` writes, `publish` accepts; what `publish` commits, `check` and
// `sign` accept; what `sign` pushes, the gateway verifies, installs and RUNS.
//
// Every author and maintainer step is the real CLI as a subprocess (`bun <cli>/src/index.ts …`);
// the action is its real entry point as a subprocess, with its inputs as the runner's `INPUT_*`
// variables. Gateway steps that the CLI only allows at a terminal (`registry add`, `extension
// approve`: no --yes, TTY-only CLI guards) are answered over a raw local-owner socket, as
// registry-acceptance.e2e and extension-runtime.e2e do; `extension install` and `connector tools`
// are the CLI again, pointed at this test's gateway through an isolated `gateway.json`.
//
// The registry lives in a local bare repository. `publish --clone` requires the clone's `origin`
// to BE the GitHub repository it targets, so the clone's origin is `git@github.com:<repo>.git`
// and its `core.sshCommand` is a fake ssh that serves the local bare repository. That holds only
// while nothing overrides the repository's own setting, so every child that runs git gets an
// isolated environment: no system or global git config (a developer's `insteadOf` could turn the
// origin back into https://github.com), and no `GIT_SSH_COMMAND`/`GIT_SSH`/`GIT_CONFIG_*`, which
// would take precedence. A bypass would make a real connection attempt, so it is guarded rather
// than tolerated: the fake records every invocation and that record is asserted, and a positive
// control shows an outer `GIT_SSH_COMMAND` never reaches the publish.
//
// The publisher id is unique per run: an install caches the publisher key in the Vault, which on
// macOS/Linux is the machine-global keychain. The cached key is evicted afterwards. Embeddings are
// skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { evictPublisherKey } from "../../src/extensions/publisher-keys.ts";
import type { PlatformPaths } from "../../src/platform/paths.ts";
import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";
import { createNimbusVault } from "../../src/vault/factory.ts";
import { rmDirWithRetry } from "../helpers/rm-dir-with-retry.ts";

// --- TestIpcClient + until, as in registry-acceptance.e2e.test.ts ---

type NotificationHandler = (params: Record<string, unknown>) => void;

class TestIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  private readonly notifyHandlers = new Map<string, NotificationHandler>();

  private failAllPending(reason: string): void {
    for (const [, cb] of this.pending) cb({ error: { message: reason } });
    this.pending.clear();
  }

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolveConn, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolveConn());
      sock.on("error", (e) => {
        reject(e);
        this.failAllPending(`socket error: ${e.message}`);
      });
      sock.on("close", () => this.failAllPending("socket closed"));
      sock.on("data", (chunk) => {
        this.buffer += chunk.toString("utf8");
        let idx = this.buffer.indexOf("\n");
        while (idx !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line !== "") this.onLine(line);
          idx = this.buffer.indexOf("\n");
        }
      });
      this.sock = sock;
    });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notifyHandlers.set(method, handler);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") {
      const method = msg["method"];
      if (typeof method === "string") {
        const handler = this.notifyHandlers.get(method);
        if (handler !== undefined) {
          handler((msg["params"] as Record<string, unknown> | undefined) ?? {});
        }
      }
      return;
    }
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as { result?: unknown; error?: unknown });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveCall, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolveCall(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  clearNotificationHandlers(): void {
    this.notifyHandlers.clear();
  }

  close(): void {
    this.sock?.destroy();
  }
}

async function until<T>(probe: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- end copied section ---

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
const ACTION_MAIN = join(REPO, "packages", "github-actions", "registry-action", "src", "main.ts");
const IS_CI = process.env["CI"] === "true";

/** The commit identity the test's own git calls use; the isolated global config has none. */
const GIT_IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

/** Any 40-hex commit: a dev build has no embedded release commit for `init --github` to pin. */
const ACTION_REF = "0123456789abcdef0123456789abcdef01234567";
const REGISTRY_REPO = "nimbus-e2e/extensions";
const REGISTRY_NAME = "e2e";
const EXT_NAME = "echo_ext";
const EXT_VERSION = "0.1.0";

// The whole chain builds, packs, clones, signs and boots a gateway: each step can take seconds
// on a dev machine and far longer on a CI runner, so every step gets a generous timeout.
const STEP_TIMEOUT_MS = 180_000;

/** The nearest `node_modules/<pkg>` at or above `from` (as extension-runtime.e2e.test.ts). */
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

/** Whether this platform's sandbox can confine a no-network policy here (as extension-runtime.e2e). */
const sandboxAvailable = await (async () => {
  const prior = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (process.platform === "win32" && prior === undefined) {
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
  }
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "registry-publish-acceptance-probe",
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
 * The extension is spawned through `wrapServerSpec`'s `__nimbus-sandbox` re-exec, whose env (I1)
 * never carries `NIMBUS_SANDBOX_HELPER_PATH`, so the wrapper resolves the helper next to
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
describe.skipIf(sandboxAvailable || !IS_CI)(
  "registry publish acceptance — CI sandbox precondition",
  () => {
    test("fails loudly instead of silently skipping the run step", () => {
      expect(
        "registry-publish-acceptance: CI precondition unmet -- the platform sandbox cannot confine " +
          "a no-network policy, so the published extension cannot be run. Install this platform's " +
          "sandbox dependency (scripts/linux/install-sandbox-deps.sh on Linux, " +
          "build:sandbox-helper:win32 on Windows).",
      ).toBeNull();
    });
  },
);

type Run = { code: number; stdout: string; stderr: string };

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<Run> {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function describeRun(what: string, r: Run): string {
  return `${what} exited ${String(r.code)}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
}

describe("publish to run: scaffold → sign → publish → check → merge → sign → install → run", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-pubacc-e2e-"));
  const publisherId = `e2e-pub-${randomUUID().slice(0, 8)}`;
  const extensionId = `${publisherId}/${EXT_NAME}`;
  const branch = `publish/${extensionId}/${EXT_VERSION}`;

  // Every per-user directory the CLI resolves points inside `tmp` (as mcp-capture.e2e.test.ts),
  // so no CLI subprocess can read the developer's config, data, keys or live gateway.
  const user = {
    roaming: join(tmp, "user", "roaming"),
    local: join(tmp, "user", "local"),
    home: join(tmp, "user", "home"),
    xdgConfig: join(tmp, "user", "xdg-config"),
    xdgData: join(tmp, "user", "xdg-data"),
    run: join(tmp, "user", "run"),
    tmp: join(tmp, "user", "tmp"),
  };
  const authorDir = join(tmp, "author");
  const project = join(authorDir, EXT_NAME);
  const publisherKey = join(tmp, "keys", "publisher-key");
  const registryKey = join(tmp, "keys", "registry-key");
  const registryDir = join(tmp, "registry");
  const initSite = join(tmp, "registry-site");
  const origin = join(tmp, "origin.git");
  const originUrl = pathToFileURL(origin).href;
  const publishClone = join(tmp, "publish-clone");
  const sshLog = join(tmp, "fake-ssh.log");
  const signWorkspace = join(tmp, "sign-workspace");
  const servedSite = join(tmp, "served-site");

  /** An empty global git config: no developer `insteadOf`, `sshCommand` or identity applies. */
  const emptyGitConfig = join(tmp, "user", "empty-gitconfig");

  /**
   * `base` with every per-user directory pointed inside `tmp` and git's configuration isolated:
   * no system or global config, and none of the environment variables that override a
   * repository's own `core.sshCommand` or inject config (`GIT_SSH_COMMAND` and `GIT_SSH` take
   * precedence over it; `GIT_CONFIG_*` can set anything). Every child that runs git gets this,
   * so the clone's fake ssh is the only way its github-shaped origin can be reached.
   */
  function isolatedEnv(
    base: Record<string, string | undefined>,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) {
      if (v !== undefined) env[k] = v;
    }
    for (const k of Object.keys(env)) {
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
    }
    for (const k of [
      "NIMBUS_DEMO",
      "NIMBUS_CONFIG_DIR",
      "NIMBUS_GATEWAY_SOCKET",
      "NIMBUS_PROFILE",
      "NIMBUS_SCRIPT_CONSENT_SOURCE",
      "GIT_SSH_COMMAND",
      "GIT_SSH",
      "GIT_SSH_VARIANT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG",
      "GIT_DIR",
      "GIT_WORK_TREE",
      // The rest of the repository-location variables a git hook running the tests can set.
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_PREFIX",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete env[k];
    }
    return {
      ...env,
      APPDATA: user.roaming,
      LOCALAPPDATA: user.local,
      HOME: user.home,
      USERPROFILE: user.home,
      XDG_CONFIG_HOME: user.xdgConfig,
      XDG_DATA_HOME: user.xdgData,
      XDG_RUNTIME_DIR: user.run,
      TMPDIR: user.tmp,
      TEMP: user.tmp,
      TMP: user.tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      ...extra,
    };
  }

  /** The env every CLI subprocess gets; `base` lets a test seed the OUTER env it is built from. */
  function cliEnv(
    extra: Record<string, string> = {},
    base: Record<string, string | undefined> = process.env,
  ): Record<string, string> {
    return isolatedEnv(base, extra);
  }

  /** The test's own git calls, under the same isolated config (identity passed explicitly). */
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", [...GIT_IDENTITY, ...args], {
      cwd,
      env: isolatedEnv(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");
  }

  /** How many times the fake ssh has served a fetch so far. */
  function uploadPackCount(): number {
    if (!existsSync(sshLog)) return 0;
    return readFileSync(sshLog, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("git-upload-pack")).length;
  }

  /** The data dir the CLI resolves under `cliEnv()` (mirrors packages/cli/src/paths.ts). */
  function cliDataDir(): string {
    if (process.platform === "win32") return join(user.local, "Nimbus", "data");
    if (process.platform === "darwin") {
      return join(user.home, "Library", "Application Support", "Nimbus");
    }
    return join(user.xdgData, "nimbus");
  }

  function cli(
    args: string[],
    cwd: string,
    extra?: Record<string, string>,
    base?: Record<string, string | undefined>,
  ): Promise<Run> {
    return run(["bun", CLI_ENTRY, ...args], cwd, cliEnv(extra, base));
  }

  async function action(
    mode: "check" | "sign",
    workspace: string,
    extra: Record<string, string>,
  ): Promise<Run> {
    return run(
      ["bun", ACTION_MAIN],
      workspace,
      isolatedEnv(process.env, {
        INPUT_MODE: mode,
        GITHUB_WORKSPACE: workspace,
        GITHUB_STEP_SUMMARY: join(tmp, `summary-${mode}.md`),
        ...extra,
      }),
    );
  }

  beforeAll(() => {
    for (const d of Object.values(user)) mkdirSync(d, { recursive: true });
    writeFileSync(emptyGitConfig, "");
    mkdirSync(authorDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmDirWithRetry(tmp);
    } catch {
      /* a Windows handle held past the retries; the dir is unique to this run */
    }
  });

  test(
    "step 1: scaffold extension --publisher writes a namespaced extension that builds",
    async () => {
      const scaffold = await cli(
        ["scaffold", "extension", EXT_NAME, "--publisher", publisherId],
        authorDir,
      );
      expect(scaffold.code, describeRun("scaffold", scaffold)).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(project, "nimbus.extension.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        id: extensionId,
        version: EXT_VERSION,
        entry: "dist/index.js",
        publisher: { id: publisherId },
      });

      // `bun install` would reach the npm registry; the two dependencies are linked from this
      // checkout instead, for the BUILD only: the bundle carries them, and the published package
      // never holds node_modules.
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
      const build = await run(["bun", "run", "build"], project, cliEnv());
      expect(build.code, describeRun("bun run build", build)).toBe(0);
      expect(existsSync(join(project, "dist", "index.js"))).toBe(true);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "step 2: extension keygen makes a key and extension sign records it and signs",
    async () => {
      const keygen = await cli(["extension", "keygen", "--out", publisherKey], authorDir);
      expect(keygen.code, describeRun("keygen", keygen)).toBe(0);
      const pubkey = keygen.stdout.trim();
      expect(pubkey).toMatch(/^[A-Za-z0-9+/]{43}=$/);

      const sign = await cli(["extension", "sign", project, "--key", publisherKey], authorDir);
      expect(sign.code, describeRun("extension sign", sign)).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(project, "nimbus.extension.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest["publisher"]).toEqual({ id: publisherId, key: pubkey });
      expect(typeof manifest["signature"]).toBe("string");
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "registry setup: maintain init --github writes the repository, pushed as main + gh-pages",
    async () => {
      const init = await cli(
        [
          "registry",
          "maintain",
          "init",
          registryDir,
          "--github",
          "--action-ref",
          ACTION_REF,
          "--key",
          registryKey,
          "--site",
          initSite,
        ],
        tmp,
      );
      expect(init.code, describeRun("registry maintain init --github", init)).toBe(0);
      expect(init.stdout).toContain(`action pin:  ${ACTION_REF}`);
      for (const rel of [
        ".github/workflows/registry-check.yml",
        ".github/workflows/registry-sign.yml",
        "nimbus-registry.json",
        "extensions/.gitattributes",
      ]) {
        expect(existsSync(join(registryDir, ...rel.split("/")))).toBe(true);
      }
      expect(existsSync(join(registryDir, "index.json"))).toBe(false);
      expect(
        readFileSync(join(registryDir, ".github/workflows/registry-sign.yml"), "utf8"),
      ).toContain(ACTION_REF);

      git(tmp, "init", "-q", "--bare", "-b", "main", origin);
      git(registryDir, "init", "-q", "-b", "main");
      git(registryDir, "add", "-A");
      git(registryDir, "commit", "-q", "-m", "registry init");
      git(registryDir, "remote", "add", "origin", originUrl);
      git(registryDir, "push", "-q", "origin", "main");

      git(initSite, "init", "-q", "-b", "gh-pages");
      git(initSite, "add", "-A");
      git(initSite, "commit", "-q", "-m", "initial site");
      git(initSite, "push", "-q", originUrl, "gh-pages");
      expect(git(origin, "show", "gh-pages:index.json")).toContain('"sequence": 1');
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "step 3: extension publish --no-pr commits the publish branch in a clone of the registry",
    async () => {
      git(tmp, "clone", "-q", "--branch", "main", originUrl, publishClone);
      // The clone's origin is the GitHub repository the publish targets; the fake ssh serves it
      // from the local bare repository (see the module comment).
      const fakeSsh = join(tmp, "fake-ssh.sh");
      const posix = (p: string): string => p.replaceAll("\\", "/");
      writeFileSync(
        fakeSsh,
        [
          "#!/bin/sh",
          "for last; do :; done",
          `printf '%s\\n' "$last" >> '${posix(sshLog)}'`,
          'case "$last" in',
          `  git-upload-pack*) exec git upload-pack '${posix(origin)}' ;;`,
          `  git-receive-pack*) exec git receive-pack '${posix(origin)}' ;;`,
          "esac",
          'echo "fake-ssh: unexpected remote command: $last" >&2',
          "exit 1",
          "",
        ].join("\n"),
      );
      git(publishClone, "config", "core.sshCommand", `sh '${posix(fakeSsh)}'`);
      git(publishClone, "config", "ssh.variant", "simple");
      git(publishClone, "remote", "set-url", "origin", `git@github.com:${REGISTRY_REPO}.git`);

      // A trap ssh: records that it ran and fails, so nothing it is handed is ever contacted.
      const trapSsh = join(tmp, "trap-ssh.sh");
      const trapMarker = join(tmp, "trap-ssh.marker");
      writeFileSync(
        trapSsh,
        ["#!/bin/sh", `printf 'ran\\n' >> '${posix(trapMarker)}'`, "exit 1", ""].join("\n"),
      );
      const trapCommand = `sh '${posix(trapSsh)}'`;
      // Positive control: an inherited GIT_SSH_COMMAND DOES beat the clone's core.sshCommand, so
      // "the marker stays absent" below is evidence of the scrub, not of an inert trap.
      const control = Bun.spawnSync(["git", "ls-remote", "origin"], {
        cwd: publishClone,
        env: isolatedEnv(process.env, { GIT_SSH_COMMAND: trapCommand }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      expect(control.exitCode).not.toBe(0);
      expect(existsSync(trapMarker)).toBe(true);
      rmSync(trapMarker, { force: true });

      // The publish runs from an OUTER environment that carries the trap; the CLI's env drops it.
      const publish = await cli(
        [
          "extension",
          "publish",
          project,
          "--registry-repo",
          REGISTRY_REPO,
          "--clone",
          publishClone,
          "--no-pr",
        ],
        authorDir,
        undefined,
        { ...process.env, GIT_SSH_COMMAND: trapCommand },
      );
      expect(publish.code, describeRun("extension publish", publish)).toBe(0);
      expect(existsSync(trapMarker)).toBe(false);
      expect(publish.stdout).toContain(
        `Committed ${extensionId}@${EXT_VERSION} on branch ${branch}`,
      );
      // Every fetch went through the fake: the publish read the registry, and nothing else served it.
      expect(uploadPackCount()).toBeGreaterThan(0);

      expect(git(publishClone, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
      const added = git(publishClone, "diff", "--name-only", "origin/main", "HEAD")
        .trim()
        .split("\n")
        .sort();
      const base = `extensions/${extensionId}/${EXT_VERSION}`;
      expect(added).toEqual(
        [`${base}/manifest.json`, `${base}/package.tgz`, `${base}/publish-request.json`].sort(),
      );
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "step 4: the registry action's check passes the publish branch",
    async () => {
      // The clone stands in for the pull request's checkout: HEAD is the publish branch.
      const fetchesBefore = uploadPackCount();
      const check = await action("check", publishClone, { GITHUB_BASE_REF: "main" });
      const out = `${check.stdout}${check.stderr}`;
      expect(out).not.toContain("::error::");
      expect(check.code, describeRun("action check", check)).toBe(0);
      // It really validated this publish (an exit 0 alone would also cover a no-op)…
      expect(check.stdout).toContain(`check passed: ${extensionId}@${EXT_VERSION}`);
      expect(readFileSync(join(tmp, "summary-check.md"), "utf8")).toContain(
        `## Registry publish: \`${extensionId}@${EXT_VERSION}\``,
      );
      // …and its fetch of the base and gh-pages went through the fake ssh too.
      expect(uploadPackCount()).toBeGreaterThan(fetchesBefore);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "step 5: the publish branch is merged into main and pushed",
    () => {
      git(registryDir, "fetch", "-q", publishClone, `+refs/heads/${branch}:refs/heads/pr`);
      git(registryDir, "merge", "-q", "--no-ff", "pr", "-m", `Merge ${branch}`);
      git(registryDir, "push", "-q", "origin", "main");
      expect(
        git(origin, "ls-tree", "-r", "--name-only", "main", `extensions/${publisherId}`),
      ).toContain(`${EXT_VERSION}/package.tgz`);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "step 6: the registry action's sign signs it onto gh-pages",
    async () => {
      git(tmp, "clone", "-q", "--branch", "main", originUrl, signWorkspace);
      const rootKey = readFileSync(registryKey, "utf8").trim();
      const sign = await action("sign", signWorkspace, { "INPUT_ROOT-KEY": rootKey });
      const out = `${sign.stdout}${sign.stderr}`;
      expect(out).not.toContain("::error::");
      expect(out).not.toContain("::warning::");
      expect(sign.code, describeRun("action sign", sign)).toBe(0);
      expect(readFileSync(join(tmp, "summary-sign.md"), "utf8")).toContain(
        `\`${extensionId}@${EXT_VERSION}\``,
      );

      git(tmp, "clone", "-q", "--branch", "gh-pages", originUrl, servedSite);
      const index = JSON.parse(readFileSync(join(servedSite, "index.json"), "utf8")) as {
        sequence: number;
        extensions: Record<string, unknown>;
      };
      expect(index.sequence).toBe(2);
      expect(Object.keys(index.extensions)).toEqual([extensionId]);
    },
    STEP_TIMEOUT_MS,
  );

  describe("step 7: a real gateway adds the gh-pages tree, installs and runs the extension", () => {
    const paths: PlatformPaths = {
      configDir: join(tmp, "gw", "config"),
      dataDir: join(tmp, "gw", "data"),
      logDir: join(tmp, "gw", "logs"),
      socketPath:
        process.platform === "win32"
          ? `\\\\.\\pipe\\nimbus-pubacc-${String(process.pid)}-${randomUUID().slice(0, 8)}`
          : join(tmp, "gw.sock"),
      extensionsDir: join(tmp, "gw", "extensions"),
      tempDir: join(tmp, "gw", "tmp"),
      sandboxDir: join(tmp, "gw", "sandbox"),
    };
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let gatewayLog = "";
    let restoreHelper: () => void = () => {};
    let serviceId = "";
    const client = new TestIpcClient();
    /** The action type of every consent prompt raised on the socket client, in order (all approved). */
    const prompts: string[] = [];

    async function promptsDuring(fn: () => Promise<unknown>): Promise<string[]> {
      const before = prompts.length;
      await fn();
      return prompts.slice(before);
    }

    beforeAll(async () => {
      restoreHelper = installDefaultHelper();
      for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
      proc = Bun.spawn(["bun", RUNNER], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: {
          ...(process.env as Record<string, string>),
          NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
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
          () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
          "gateway bind",
          60_000,
        );
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
        );
      }
      // The CLI finds this gateway through its (isolated) data dir, never the developer's.
      mkdirSync(cliDataDir(), { recursive: true });
      writeFileSync(
        join(cliDataDir(), "gateway.json"),
        JSON.stringify({ pid: proc.pid, socketPath: paths.socketPath }),
      );
      await client.connect(paths.socketPath);
      client.onNotification("consent.request", (params) => {
        const type = /^Type: (\S+)$/m.exec(String(params["prompt"] ?? ""))?.[1] ?? "unknown";
        prompts.push(type);
        // A socket closed by teardown rejects the reply; that must not surface as unhandled.
        void client
          .call("consent.respond", { requestId: params["requestId"], approved: true })
          .catch(() => {});
      });
    }, STEP_TIMEOUT_MS);

    afterAll(async () => {
      client.clearNotificationHandlers();
      client.close();
      proc?.kill();
      await proc?.exited.catch(() => {});
      restoreHelper();
      try {
        // The install cached this run's publisher key; on macOS/Linux that is the real keychain.
        await evictPublisherKey(await createNimbusVault(paths), publisherId);
      } catch {
        /* best-effort -- the key is unique to this run and harmless if left */
      }
    });

    test(
      "registry add pins the signed gh-pages tree's root key (owner approval over the socket)",
      async () => {
        let added: { name: string; rootFingerprint: string; extensionCount: number } | undefined;
        const raised = await promptsDuring(async () => {
          added = await client.call("registry.add", { name: REGISTRY_NAME, url: servedSite });
        });
        expect(raised).toEqual(["registry.add"]);
        expect(added).toMatchObject({ name: REGISTRY_NAME, extensionCount: 1 });
      },
      STEP_TIMEOUT_MS,
    );

    test(
      "nimbus extension install <id> installs it from the registry (scripted owner approval)",
      async () => {
        const consent = join(tmp, "install-consent.jsonl");
        writeFileSync(consent, `${JSON.stringify({ approved: true })}\n`);
        const install = await cli(["extension", "install", extensionId], tmp, {
          NIMBUS_SCRIPT_CONSENT_SOURCE: consent,
        });
        expect(install.code, describeRun("extension install", install)).toBe(0);
        expect(install.stdout).toContain(`[consent.request]`);
        expect(install.stdout).toContain(
          `installed ${extensionId}@${EXT_VERSION} from registry ${REGISTRY_NAME}`,
        );
        const list = await client.call<{
          extensions: Array<{ id: string; version: string; runState: string }>;
        }>("extension.list", {});
        expect(list.extensions.find((e) => e.id === extensionId)).toMatchObject({
          version: EXT_VERSION,
          runState: "no_grant",
        });
      },
      STEP_TIMEOUT_MS,
    );

    describe.skipIf(!sandboxAvailable)(
      "run (skipped where this platform's sandbox cannot confine a no-network policy)",
      () => {
        test(
          "extension approve grants it a service id (owner approval over the socket)",
          async () => {
            let out: { serviceId: string } | undefined;
            const raised = await promptsDuring(async () => {
              out = await client.call<{ serviceId: string }>("extension.approveRun", {
                id: extensionId,
              });
            });
            expect(raised).toEqual(["extension.run"]);
            serviceId = out?.serviceId ?? "";
            expect(serviceId).toMatch(/^ext_/);
          },
          STEP_TIMEOUT_MS,
        );

        test(
          "nimbus connector tools ext_… spawns the sandboxed extension and lists echo",
          async () => {
            const tools = await cli(["connector", "tools", serviceId, "--json"], tmp);
            expect(tools.code, describeRun("connector tools", tools)).toBe(0);
            const parsed = JSON.parse(tools.stdout) as { tools: Array<{ name: string }> };
            expect(parsed.tools.map((t) => t.name)).toContain("echo");

            // And it answers: one call through the owner's I42 prompt, echoing its input back.
            const outcome = await client.call<{ status: string; result?: unknown }>(
              "connector.userMcpCall",
              { serviceId, tool: "echo", input: { text: "published and running" } },
            );
            expect(outcome.status).toBe("ok");
            expect(JSON.stringify(outcome.result)).toContain("published and running");
          },
          STEP_TIMEOUT_MS,
        );
      },
    );
  });
});
