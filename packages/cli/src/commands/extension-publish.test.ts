/**
 * `nimbus extension publish` against REAL git: a local bare repo stands in for the GitHub registry
 * repository (the remote URL is an injected dep, so nothing reaches github.com), with `main` and a
 * `gh-pages` branch holding an index signed by `registry maintain`. `gh` is faked through the
 * injected `runTool`; every `git` call goes to the real binary.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64, generateEd25519Keypair, signManifest } from "../lib/extension-signing.ts";
import { rmDirWithRetry } from "../lib/rm-dir-with-retry.ts";
import { type RunTool, runTool, TOOL_NOT_STARTED, type ToolResult } from "../lib/run-git.ts";
import { runExtensionPublish } from "./extension-publish.ts";
import { runRegistryMaintain } from "./registry-maintain.ts";

const REPO = "nimbus-agent/registry";
const BRANCH = "publish/acme/tool/1.0.0";
const TEST_IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

let tmp: string;
let scratch: string;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-publish-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  out = [];
  err = [];
});
afterEach(() => {
  rmDirWithRetry(tmp);
});

/** Synchronous git for fixtures; raw stdout bytes. */
function git(cwd: string, ...args: string[]): Buffer {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout;
}

const gitText = (cwd: string, ...args: string[]): string =>
  git(cwd, ...args)
    .toString()
    .trim();

interface ExtOpts {
  id?: string;
  version?: string;
  pair?: { privkey: Uint8Array; pubkey: Uint8Array };
  crlf?: boolean;
}

async function makeExtension(name: string, opts: ExtOpts = {}): Promise<string> {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "export default 1;\n");
  const pair = opts.pair ?? generateEd25519Keypair();
  const manifest: Record<string, unknown> = {
    id: opts.id ?? "acme/tool",
    name: "Acme Tool",
    version: opts.version ?? "1.0.0",
    entry: "dist/index.js",
    permissions: {},
    publisher: { id: "acme", key: encodeBase64(pair.pubkey) },
  };
  manifest["signature"] = await signManifest(manifest, pair.privkey);
  let text = JSON.stringify(manifest, null, 2);
  if (opts.crlf === true) text = text.replaceAll("\n", "\r\n");
  writeFileSync(join(dir, "nimbus.extension.json"), text);
  return dir;
}

interface RegistryOpts {
  requireNamespace?: boolean;
  ghPages?: boolean;
  /** Extension dirs `registry maintain add`ed to the signed index before publishing. */
  indexed?: string[];
  tamper?: boolean;
}

/** A bare remote with `main` (sources) and, unless `ghPages: false`, the signed site on `gh-pages`. */
async function makeRegistry(opts: RegistryOpts = {}): Promise<string> {
  const quiet = { stdout: () => {}, stderr: (s: string) => void err.push(s) };
  const site = join(tmp, "site");
  const key = join(tmp, "root-key");
  expect(await runRegistryMaintain(["init", site, "--key", key], quiet)).toBe(0);
  if (opts.requireNamespace !== undefined) {
    writeFileSync(
      join(site, "nimbus-registry.json"),
      JSON.stringify({ format: 1, requirePublisherNamespace: opts.requireNamespace }),
    );
  }
  for (const ext of opts.indexed ?? []) {
    expect(await runRegistryMaintain(["add", site, ext, "--key", key], quiet)).toBe(0);
  }
  if (opts.tamper === true) {
    const index = JSON.parse(readFileSync(join(site, "index.json"), "utf8")) as {
      sequence: number;
    };
    index.sequence += 1;
    writeFileSync(join(site, "index.json"), JSON.stringify(index, null, 2));
  }

  const remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "-b", "main", remote);
  const src = join(tmp, "src");
  git(tmp, "init", "-b", "main", src);
  writeFileSync(join(src, "README.md"), "# registry\n");
  git(src, "add", "README.md");
  git(src, ...TEST_IDENTITY, "commit", "-m", "init");
  git(src, "push", remote, "main");
  if (opts.ghPages !== false) {
    const pages = join(tmp, "pages");
    git(tmp, "init", "-b", "gh-pages", pages);
    cpSync(site, pages, { recursive: true });
    git(pages, "add", ".");
    git(pages, ...TEST_IDENTITY, "commit", "-m", "site");
    git(pages, "push", remote, "gh-pages");
  }
  return remote;
}

interface Call {
  cmd: "git" | "gh";
  args: string[];
}

/** Real git; `gh` faked per `gh`. A `repo fork` adds a `fork` remote pointing at a local bare repo. */
function tools(gh: "absent" | "authed" | "unauthed"): {
  run: RunTool;
  calls: Call[];
  fork: string;
} {
  const calls: Call[] = [];
  const fork = join(tmp, "alice", "registry.git");
  const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "" });
  const run: RunTool = async (cmd, args, opts) => {
    calls.push({ cmd, args });
    if (cmd === "git") return runTool(cmd, args, opts);
    if (gh === "absent") return { code: TOOL_NOT_STARTED, stdout: "", stderr: "gh: not found" };
    if (args[0] === "auth") {
      return gh === "authed" ? ok() : { code: 1, stdout: "", stderr: "not logged in" };
    }
    if (args[0] === "repo" && args[1] === "fork") {
      git(tmp, "init", "--bare", "-b", "main", fork);
      git(opts.cwd, "remote", "add", "fork", fork);
      return ok();
    }
    if (args[0] === "pr") return ok(`https://github.com/${REPO}/pull/7\n`);
    return { code: 1, stdout: "", stderr: "unexpected gh call" };
  };
  return { run, calls, fork };
}

function deps(run: RunTool, remote: string) {
  return {
    runTool: run,
    tmpdir: () => scratch,
    log: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
    repoUrl: () => remote,
  };
}

const WRITE_SUBCOMMANDS = new Set(["switch", "checkout", "add", "commit", "push"]);
/** The git subcommand of a call, past any leading `-c key=value` pairs. */
function subcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}
const wroteToGit = (calls: Call[]): boolean =>
  calls.some((c) => c.cmd === "gh" || WRITE_SUBCOMMANDS.has(subcommand(c.args)));

describe("nimbus extension publish", () => {
  test("opens a PR through gh: only the three files on the branch, never index.json", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(err.join("")).toBe("");
    expect(code).toBe(0);

    const changed = gitText(t.fork, "show", "--name-only", "--format=", BRANCH).split("\n");
    expect(changed.sort()).toEqual([
      "extensions/acme/tool/1.0.0/manifest.json",
      "extensions/acme/tool/1.0.0/package.tgz",
      "extensions/acme/tool/1.0.0/publish-request.json",
    ]);
    const tree = gitText(t.fork, "ls-tree", "-r", "--name-only", BRANCH).split("\n");
    expect(tree).not.toContain("index.json");
    expect(tree).not.toContain("extensions/.gitattributes");
    const manifest = git(t.fork, "show", `${BRANCH}:extensions/acme/tool/1.0.0/manifest.json`);
    expect(manifest.equals(readFileSync(join(ext, "nimbus.extension.json")))).toBe(true);
    const request = JSON.parse(
      gitText(t.fork, "show", `${BRANCH}:extensions/acme/tool/1.0.0/publish-request.json`),
    ) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "channel",
      "id",
      "publisherFingerprint",
      "version",
    ]);
    expect(request["channel"]).toBe("stable");

    const ghCalls = t.calls.filter((c) => c.cmd === "gh").map((c) => c.args);
    expect(ghCalls[0]).toEqual(["auth", "status"]);
    expect(ghCalls[1]).toEqual(["repo", "fork", "--remote", "--remote-name", "fork"]);
    const pr = ghCalls[2] ?? [];
    expect(pr.slice(0, 10)).toEqual([
      "pr",
      "create",
      "--repo",
      REPO,
      "--base",
      "main",
      "--head",
      `alice:${BRANCH}`,
      "--title",
      "Publish acme/tool@1.0.0",
    ]);
    expect(pr[10]).toBe("--body");
    expect(pr[11]).toContain("acme/tool@1.0.0");
    expect(ghCalls).toHaveLength(3);
    expect(out.join("")).toContain(`https://github.com/${REPO}/pull/7`);
    // The temp clone is gone once the PR exists.
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("--channel beta is what publish-request.json records", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--channel", "beta"],
      deps(t.run, remote),
    );
    expect(code).toBe(0);
    const request = JSON.parse(
      gitText(t.fork, "show", `${BRANCH}:extensions/acme/tool/1.0.0/publish-request.json`),
    ) as Record<string, unknown>;
    expect(request["channel"]).toBe("beta");
  });

  test("publish with autocrlf=true in the clone commits byte-identical manifest bytes and only the three files", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext", { crlf: true });
    const clone = join(tmp, "my-clone");
    git(tmp, "clone", remote, clone);
    git(clone, "config", "core.autocrlf", "true");
    const t = tools("authed");
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--clone", clone, "--no-pr"],
      deps(t.run, remote),
    );
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    const committed = git(clone, "show", `${BRANCH}:extensions/acme/tool/1.0.0/manifest.json`);
    const source = readFileSync(join(ext, "nimbus.extension.json"));
    expect(source.includes("\r\n")).toBe(true);
    expect(committed.equals(source)).toBe(true);
    const changed = gitText(clone, "show", "--name-only", "--format=", BRANCH).split("\n");
    expect(changed).toHaveLength(3);
    // --no-pr never asks gh anything, and the user's clone is kept.
    expect(t.calls.some((c) => c.cmd === "gh")).toBe(false);
    expect(existsSync(clone)).toBe(true);
  });

  test("no gh on PATH prints push and pr commands", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext");
    const t = tools("absent");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain(`git push fork ${BRANCH}`);
    expect(text).toContain(
      `gh pr create --repo ${REPO} --base main --head <your-github-user>:${BRANCH} --title "Publish acme/tool@1.0.0"`,
    );
    // The printed clone keeps the committed branch.
    const [clone] = readdirSync(scratch);
    expect(clone).toBeDefined();
    const clonePath = join(scratch, clone as string);
    expect(text).toContain(clonePath);
    expect(gitText(clonePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  });

  test("gh installed but not signed in prints the commands too", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext");
    const t = tools("unauthed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(0);
    expect(out.join("")).toContain(`git push fork ${BRANCH}`);
    expect(t.calls.filter((c) => c.cmd === "gh").map((c) => c.args[0])).toEqual(["auth"]);
  });

  test("refuses a version already in the index before writing to git", async () => {
    const pair = generateEd25519Keypair();
    const indexed = await makeExtension("indexed", { pair });
    const remote = await makeRegistry({ indexed: [indexed] });
    const ext = await makeExtension("ext", { pair });
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_VERSION_EXISTS: ");
    expect(wroteToGit(t.calls)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("refuses a publisher whose key changed before writing to git", async () => {
    const indexed = await makeExtension("indexed");
    const remote = await makeRegistry({ indexed: [indexed] });
    const ext = await makeExtension("ext", { version: "1.1.0" });
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT: ");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("refuses a non-namespaced id when gh-pages' config requires one", async () => {
    const remote = await makeRegistry({ requireNamespace: true });
    const ext = await makeExtension("ext", { id: "tool" });
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_NAMESPACE_REQUIRED: ");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("refuses an index whose signature does not verify against its own root key", async () => {
    const remote = await makeRegistry({ tamper: true });
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_SIGNATURE_INVALID: ");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("refuses a registry with no gh-pages branch as not initialised", async () => {
    const remote = await makeRegistry({ ghPages: false });
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("not initialised");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("refuses a --clone with uncommitted changes", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext");
    const clone = join(tmp, "dirty");
    git(tmp, "clone", remote, clone);
    writeFileSync(join(clone, "stray.txt"), "x");
    const t = tools("authed");
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--clone", clone],
      deps(t.run, remote),
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("not clean");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("usage errors exit 2", async () => {
    const t = tools("authed");
    const d = deps(t.run, "unused");
    expect(await runExtensionPublish([], d)).toBe(2);
    expect(await runExtensionPublish(["dir"], d)).toBe(2);
    expect(await runExtensionPublish(["dir", "--registry-repo", "not a repo"], d)).toBe(2);
    expect(
      await runExtensionPublish(["dir", "--registry-repo", REPO, "--channel", "gamma"], d),
    ).toBe(2);
    expect(await runExtensionPublish(["dir", "--registry-repo", REPO, "--bogus"], d)).toBe(2);
    expect(err.join("")).toContain("--channel must be stable or beta");
    expect(t.calls).toEqual([]);
  });
});

describe("runTool", () => {
  test("runs git with argv and returns its output", async () => {
    const r = await runTool("git", ["--version"], { cwd: tmp });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git version");
  });

  test("a tool that cannot start reports exit 127", async () => {
    const r = await runTool("git", ["--version"], { cwd: join(tmp, "missing-dir") });
    expect(r.code).toBe(TOOL_NOT_STARTED);
    expect(r.stderr).toContain("could not be started");
  });
});
