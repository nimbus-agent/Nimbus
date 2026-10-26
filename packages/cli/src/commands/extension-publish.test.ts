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
import { signTrustStatement, trustStatementId } from "@nimbus-dev/registry-format";
import { encodeBase64, generateEd25519Keypair, signManifest } from "../lib/extension-signing.ts";
import { rmDirWithRetry } from "../lib/rm-dir-with-retry.ts";
import { type RunTool, runTool, TOOL_NOT_STARTED, type ToolResult } from "../lib/run-git.ts";
import { normaliseRemoteUrl, runExtensionPublish } from "./extension-publish.ts";
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
  /** `extensions/acme/tool/1.0.0/` already merged on `main`, not yet signed. */
  onMain?: boolean;
  /** `nimbus-registry.json` requiring namespaces on `main` only (none on `gh-pages`). */
  mainConfig?: boolean;
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
  if (opts.onMain === true) {
    mkdirSync(join(src, "extensions", "acme", "tool", "1.0.0"), { recursive: true });
    writeFileSync(join(src, "extensions", "acme", "tool", "1.0.0", "manifest.json"), "{}");
  }
  if (opts.mainConfig === true) {
    writeFileSync(
      join(src, "nimbus-registry.json"),
      JSON.stringify({ format: 1, requirePublisherNamespace: true }),
    );
  }
  git(src, "add", ".");
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
  cwd: string;
}

/** Real git; `gh` faked per `gh`. A `repo fork` adds a `fork` remote pointing at a local bare repo. */
function tools(gh: "absent" | "authed" | "unauthed"): {
  run: RunTool;
  calls: Call[];
  fork: string;
} {
  const calls: Call[] = [];
  const fork = join(tmp, "alice", "registry.git");
  const result = (code: number, stdout: string, stderr: string): ToolResult => ({
    code,
    stdout,
    stdoutBytes: new TextEncoder().encode(stdout),
    stderr,
  });
  const ok = (stdout = ""): ToolResult => result(0, stdout, "");
  const run: RunTool = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    if (cmd === "git") return runTool(cmd, args, opts);
    if (gh === "absent") return result(TOOL_NOT_STARTED, "", "gh: not found");
    if (args[0] === "auth") {
      return gh === "authed" ? ok() : result(1, "", "not logged in");
    }
    if (args[0] === "repo" && args[1] === "fork") {
      git(tmp, "init", "--bare", "-b", "main", fork);
      git(opts.cwd, "remote", "add", "fork", fork);
      return ok();
    }
    if (args[0] === "pr") return ok(`https://github.com/${REPO}/pull/7\n`);
    return result(1, "", "unexpected gh call");
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
    // No repository argument: gh forks the clone's own (verified) origin, from inside the clone.
    expect(ghCalls[1]).toEqual(["repo", "fork", "--remote", "--remote-name", "fork"]);
    const forkCall = t.calls.find((c) => c.cmd === "gh" && c.args[1] === "fork");
    expect(forkCall?.cwd).toContain("nimbus-publish-clone-");
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
    expect(text).toContain("  gh repo fork --remote --remote-name fork\n");
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

  describe("--statement", () => {
    type Pair = { privkey: Uint8Array; pubkey: Uint8Array };

    async function rotationFile(from: Pair, to: Pair, name = "rotation.json") {
      const fromKey = encodeBase64(from.pubkey);
      const s = await signTrustStatement(
        {
          kind: "key.rotate",
          issuedAt: "2026-10-26T12:00:00Z",
          signerKey: fromKey,
          publisherId: "acme",
          fromKey,
          toKey: encodeBase64(to.pubkey),
        },
        from.privkey,
      );
      const path = join(tmp, name);
      writeFileSync(path, JSON.stringify(s, null, 2));
      return { path, id: trustStatementId(s) };
    }

    test("a rotation rides the publish: statements/<id>.json is on the branch beside the three files", async () => {
      const oldPair = generateEd25519Keypair();
      const newPair = generateEd25519Keypair();
      const remote = await makeRegistry({
        indexed: [await makeExtension("indexed", { pair: oldPair })],
      });
      const ext = await makeExtension("ext", { version: "1.1.0", pair: newPair });
      const rot = await rotationFile(oldPair, newPair);
      const t = tools("authed");
      const code = await runExtensionPublish(
        [ext, "--registry-repo", REPO, "--statement", rot.path],
        deps(t.run, remote),
      );
      expect(err.join("")).toBe("");
      expect(code).toBe(0);
      const branch = "publish/acme/tool/1.1.0";
      const changed = gitText(t.fork, "show", "--name-only", "--format=", branch).split("\n");
      expect(changed.sort()).toEqual([
        "extensions/acme/tool/1.1.0/manifest.json",
        "extensions/acme/tool/1.1.0/package.tgz",
        "extensions/acme/tool/1.1.0/publish-request.json",
        `statements/${rot.id}.json`,
      ]);
      const pr = t.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr")?.args ?? [];
      expect(pr[11]).toContain(rot.id.slice(0, 12));
    });

    test("without the rotation the publish is refused with the --statement hint, before writing to git", async () => {
      const oldPair = generateEd25519Keypair();
      const remote = await makeRegistry({
        indexed: [await makeExtension("indexed", { pair: oldPair })],
      });
      const ext = await makeExtension("ext", { version: "1.1.0" });
      const t = tools("authed");
      expect(await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote))).toBe(
        2,
      );
      expect(err.join("")).toContain("--statement");
      expect(wroteToGit(t.calls)).toBe(false);
    });

    test("a statement the registry would not admit refuses before writing to git", async () => {
      const oldPair = generateEd25519Keypair();
      const remote = await makeRegistry({
        indexed: [await makeExtension("indexed", { pair: oldPair })],
      });
      const ext = await makeExtension("ext", { version: "1.1.0", pair: oldPair });
      const stranger = await rotationFile(generateEd25519Keypair(), generateEd25519Keypair());
      const t = tools("authed");
      const code = await runExtensionPublish(
        [ext, "--registry-repo", REPO, "--statement", stranger.path],
        deps(t.run, remote),
      );
      expect(code).toBe(2);
      expect(err.join("")).toContain("would not admit");
      expect(wroteToGit(t.calls)).toBe(false);
    });

    test("an unreadable statement file refuses before anything else", async () => {
      const remote = await makeRegistry();
      const ext = await makeExtension("ext");
      const t = tools("authed");
      const code = await runExtensionPublish(
        [ext, "--registry-repo", REPO, "--statement", join(tmp, "missing.json")],
        deps(t.run, remote),
      );
      expect(code).toBe(2);
      expect(err.join("")).toContain("missing.json");
      expect(wroteToGit(t.calls)).toBe(false);
    });

    test("names the publisher's other extensions still bound to the old key", async () => {
      const oldPair = generateEd25519Keypair();
      const newPair = generateEd25519Keypair();
      const remote = await makeRegistry({
        indexed: [
          await makeExtension("indexed", { pair: oldPair }),
          await makeExtension("sibling", { id: "acme/other", pair: oldPair }),
        ],
      });
      const ext = await makeExtension("ext", { version: "1.1.0", pair: newPair });
      const rot = await rotationFile(oldPair, newPair);
      const t = tools("authed");
      const code = await runExtensionPublish(
        [ext, "--registry-repo", REPO, "--statement", rot.path],
        deps(t.run, remote),
      );
      expect(code).toBe(0);
      const text = out.join("");
      expect(text).toContain("acme/other");
      expect(text).toContain("republish");
    });
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

  test("refuses a --clone whose origin is not the registry, before writing to git", async () => {
    const remote = await makeRegistry();
    const other = join(tmp, "other.git");
    git(tmp, "clone", "--bare", remote, other);
    const clone = join(tmp, "other-clone");
    git(tmp, "clone", other, clone);
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--clone", clone],
      deps(t.run, remote),
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("origin is");
    expect(wroteToGit(t.calls)).toBe(false);
    expect(t.calls.some((c) => c.args[0] === "fetch")).toBe(false);
  });

  test("refuses a branch publish/<id>/<version> that already exists in the clone", async () => {
    const remote = await makeRegistry();
    const clone = join(tmp, "my-clone");
    git(tmp, "clone", remote, clone);
    git(clone, "branch", BRANCH);
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--clone", clone],
      deps(t.run, remote),
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain(`branch ${BRANCH} already exists`);
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("an existing fork remote is reused, not re-forked", async () => {
    const remote = await makeRegistry();
    const clone = join(tmp, "my-clone");
    git(tmp, "clone", remote, clone);
    const t = tools("authed");
    git(tmp, "init", "--bare", "-b", "main", t.fork);
    git(clone, "remote", "add", "fork", t.fork);
    const ext = await makeExtension("ext");
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--clone", clone],
      deps(t.run, remote),
    );
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    const ghCalls = t.calls.filter((c) => c.cmd === "gh").map((c) => c.args.slice(0, 2));
    expect(ghCalls).toEqual([
      ["auth", "status"],
      ["pr", "create"],
    ]);
    expect(gitText(t.fork, "rev-parse", "--verify", BRANCH)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("refuses a version already merged on the default branch and waiting to be signed", async () => {
    const remote = await makeRegistry({ onMain: true });
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("is already on main, waiting to be signed");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("falls back to the default branch's config when gh-pages has none", async () => {
    const remote = await makeRegistry({ mainConfig: true });
    const ext = await makeExtension("ext", { id: "tool" });
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_NAMESPACE_REQUIRED: ");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("a namespace rule present only on the default branch refuses even when gh-pages' config allows it", async () => {
    const remote = await makeRegistry({ requireNamespace: false, mainConfig: true });
    const ext = await makeExtension("ext", { id: "tool" });
    const t = tools("authed");
    const code = await runExtensionPublish([ext, "--registry-repo", REPO], deps(t.run, remote));
    expect(code).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_NAMESPACE_REQUIRED: ");
    expect(wroteToGit(t.calls)).toBe(false);
  });

  test("overrides only the identity key git does not set", async () => {
    const remote = await makeRegistry();
    const ext = await makeExtension("ext");
    const t = tools("authed");
    const commits: string[][] = [];
    const run: RunTool = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "config" && args[2] === "user.name") {
        return { code: 1, stdout: "", stdoutBytes: new Uint8Array(), stderr: "" };
      }
      if (cmd === "git" && args[0] === "config" && args[2] === "user.email") {
        const stdout = "author@example.invalid\n";
        return { code: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "" };
      }
      if (cmd === "git" && subcommand(args) === "commit") {
        commits.push(args);
        // The real commit still needs an email on a machine whose git has none.
        return t.run(cmd, ["-c", "user.email=author@example.invalid", ...args], opts);
      }
      return t.run(cmd, args, opts);
    };
    const code = await runExtensionPublish(
      [ext, "--registry-repo", REPO, "--no-pr"],
      deps(run, remote),
    );
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    expect(commits).toHaveLength(1);
    const argv = commits[0] ?? [];
    expect(argv).toContain("user.name=acme (nimbus extension publish)");
    expect(argv.some((a) => a.startsWith("user.email="))).toBe(false);
  });

  test("normaliseRemoteUrl equates the GitHub https and ssh forms, case-insensitively", () => {
    const want = "github.com/acme/registry";
    for (const url of [
      "https://github.com/acme/registry",
      "https://github.com/Acme/Registry.git",
      "https://github.com/acme/registry/",
      "git@github.com:acme/registry.git",
      "ssh://git@github.com/acme/registry.git",
    ]) {
      expect(normaliseRemoteUrl(url)).toBe(want);
    }
    expect(normaliseRemoteUrl("https://github.com/acme/other.git")).not.toBe(want);
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
    expect(await runExtensionPublish(["dir", "--registry-repo", "acme/."], d)).toBe(2);
    expect(await runExtensionPublish(["dir", "--registry-repo", "acme/.."], d)).toBe(2);
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
