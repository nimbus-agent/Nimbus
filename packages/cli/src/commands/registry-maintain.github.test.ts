/**
 * `nimbus registry maintain init <dir> --github` (design § 7.5): the exact main-branch tree, the
 * initial gh-pages site, and the two workflows' triggers, permissions, environment, concurrency and
 * SHA pins.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  parseRegistryConfig,
  publicKeyFromSeed,
  verifyIndexSignature,
} from "@nimbus-dev/registry-format";
import { parse as parseYaml } from "yaml";
import { lintWorkflow, makeBashChecker } from "../../../../scripts/audit/workflow-lint.ts";
import { decodeBase64, encodeBase64 } from "../lib/extension-signing.ts";
import { readIndexFile } from "../lib/registry-index.ts";
import { type MaintainBuild, runRegistryMaintain } from "./registry-maintain.ts";
import {
  CHECKOUT_ACTION,
  DOWNLOAD_ARTIFACT_ACTION,
  REGISTRY_ACTION_PATH,
  ROOT_KEY_SECRET,
  SCORES_ARTIFACT,
  UPLOAD_ARTIFACT_ACTION,
} from "./registry-templates/workflows.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RELEASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const DEV: MaintainBuild = { releaseCommit: undefined, version: "9.9.9" };
const RELEASE: MaintainBuild = { releaseCommit: RELEASE_SHA, version: "9.9.9" };

let tmp: string;
let out: string[];
let err: string[];
const io = {
  stdout: (s: string) => void out.push(s),
  stderr: (s: string) => void err.push(s),
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-init-github-"));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** Every file under `root`, as sorted `/`-separated relative paths. */
function tree(root: string): string[] {
  const outFiles: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else outFiles.push(relative(root, full).split(/[\\/]/).join("/"));
    }
  };
  walk(root);
  return outFiles.sort();
}

async function initGithub(
  extra: string[] = ["--action-ref", SHA],
  build: MaintainBuild = DEV,
): Promise<{ dir: string; key: string; site: string; code: number }> {
  const dir = join(tmp, "reg");
  const key = join(tmp, "reg-key");
  const code = await runRegistryMaintain(
    ["init", dir, "--key", key, "--github", ...extra],
    io,
    build,
  );
  return { dir, key, site: `${dir}-site`, code };
}

function workflow(dir: string, name: string): { text: string; doc: Record<string, unknown> } {
  const text = readFileSync(join(dir, ".github", "workflows", name), "utf8");
  return { text, doc: parseYaml(text) as Record<string, unknown> };
}

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
function job(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  return (doc["jobs"] as Record<string, Record<string, unknown>>)[name] as Record<string, unknown>;
}
function steps(doc: Record<string, unknown>, name: string): Step[] {
  return job(doc, name)["steps"] as Step[];
}
function usesStep(doc: Record<string, unknown>, name: string, prefix: string): Step {
  const s = steps(doc, name).find((x) => x.uses?.startsWith(prefix));
  if (s === undefined) throw new Error(`no ${prefix} step in ${name}`);
  return s;
}
/** Every non-empty line of every `run:` body in the job, trimmed. */
function runLines(doc: Record<string, unknown>, name: string): string[] {
  return steps(doc, name)
    .flatMap((s) => (s.run ?? "").split("\n"))
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
const GATEWAY_PATH = `\${{ github.workspace }}/nimbus-gateway-linux-x64`;
function checkoutStep(doc: Record<string, unknown>, name: string): Step {
  const s = steps(doc, name).find((x) => x.uses?.startsWith("actions/checkout@"));
  if (s === undefined) throw new Error("no checkout step");
  return s;
}

describe("registry maintain init --github", () => {
  test("writes exactly the main-branch tree into <dir>, with no index.json", async () => {
    const { dir, code } = await initGithub();
    expect(code).toBe(0);
    expect(tree(dir)).toEqual([
      ".github/workflows/registry-check.yml",
      ".github/workflows/registry-sign.yml",
      "README.md",
      "extensions/.gitattributes",
      "extensions/.gitkeep",
      "nimbus-registry.json",
    ]);
    expect(existsSync(join(dir, "index.json"))).toBe(false);
    expect(readFileSync(join(dir, "extensions", ".gitattributes"), "utf8")).toBe("* -text\n");
    expect(readFileSync(join(dir, "extensions", ".gitkeep"), "utf8")).toBe("");
  });

  test("writes the signed empty index, the config and the Pages files into the site folder", async () => {
    const { dir, key, site } = await initGithub();
    expect(tree(site)).toEqual([
      ".gitattributes",
      ".nojekyll",
      "index.json",
      "nimbus-registry.json",
    ]);
    expect(readFileSync(join(site, ".nojekyll"), "utf8")).toBe("");
    expect(readFileSync(join(site, ".gitattributes"), "utf8")).toBe("* -text\n");
    const index = readIndexFile(join(site, "index.json"));
    expect(index.sequence).toBe(1);
    expect(index.extensions).toEqual({});
    expect(verifyIndexSignature(index)).toBe(true);
    expect(index.rootKey).toBe(
      encodeBase64(publicKeyFromSeed(decodeBase64(readFileSync(key, "utf8").trim()))),
    );
    const config = readFileSync(join(site, "nimbus-registry.json"), "utf8");
    expect(config).toBe(readFileSync(join(dir, "nimbus-registry.json"), "utf8"));
    expect(parseRegistryConfig(Buffer.from(config))).toEqual({
      format: 1,
      requirePublisherNamespace: true,
    });
  });

  test("--no-publisher-namespace turns the namespace rule off; --site moves the site", async () => {
    const site = join(tmp, "elsewhere");
    const { dir, code } = await initGithub([
      "--action-ref",
      SHA,
      "--no-publisher-namespace",
      "--site",
      site,
    ]);
    expect(code).toBe(0);
    expect(parseRegistryConfig(readFileSync(join(dir, "nimbus-registry.json")))).toEqual({
      format: 1,
      requirePublisherNamespace: false,
    });
    expect(existsSync(join(site, "index.json"))).toBe(true);
    expect(existsSync(`${dir}-site`)).toBe(false);
  });

  test("every uses: in both workflows is pinned to a 40-hex SHA with a version comment", async () => {
    const { dir } = await initGithub();
    const expected: Record<string, number> = { "registry-check.yml": 2, "registry-sign.yml": 6 };
    for (const name of ["registry-check.yml", "registry-sign.yml"]) {
      const usesLines = workflow(dir, name)
        .text.split("\n")
        .filter((l) => /^\s*-?\s*uses:/.test(l));
      expect(usesLines).toHaveLength(expected[name] ?? -1);
      for (const line of usesLines) {
        expect(line).toMatch(/uses: [^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
      expect(workflow(dir, name).text).toContain(`uses: ${REGISTRY_ACTION_PATH}@${SHA} # v9.9.9`);
      expect(workflow(dir, name).text).toContain(`uses: ${CHECKOUT_ACTION} # v`);
    }
  });

  test.each([
    ["checkout", `${CHECKOUT_ACTION} # v`],
    ["upload-artifact", UPLOAD_ARTIFACT_ACTION],
    ["download-artifact", DOWNLOAD_ARTIFACT_ACTION],
  ])("the %s pin is one this repository's own workflows use", (_what, pinned) => {
    expect(pinned).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40} # v/);
    const workflows = join(import.meta.dir, "..", "..", "..", "..", ".github", "workflows");
    const own = readdirSync(workflows).filter((f) => f.endsWith(".yml"));
    expect(own.some((f) => readFileSync(join(workflows, f), "utf8").includes(pinned))).toBe(true);
  });

  test("lintWorkflow finds nothing in either workflow, bash syntax included where bash runs", async () => {
    const { dir } = await initGithub();
    const bash = makeBashChecker() ?? undefined;
    for (const name of ["registry-check.yml", "registry-sign.yml"]) {
      expect(lintWorkflow(name, workflow(dir, name).text, bash)).toEqual([]);
    }
  });

  test("the check workflow: pull_request, read-only, no environment, full history, no credentials", async () => {
    const { dir } = await initGithub();
    const { doc } = workflow(dir, "registry-check.yml");
    expect(doc["on"]).toEqual({ pull_request: { branches: ["main"] } });
    expect(doc["permissions"]).toEqual({ contents: "read" });
    expect(doc["concurrency"]).toBeUndefined();
    expect(Object.keys(doc["jobs"] as object)).toEqual(["check"]);
    expect(job(doc, "check")["environment"]).toBeUndefined();
    expect(job(doc, "check")["permissions"]).toBeUndefined();
    // The action finds the pull request's merge base, which a depth-1 checkout cannot.
    expect(checkoutStep(doc, "check").with?.["fetch-depth"]).toBe(0);
    expect(checkoutStep(doc, "check").with?.["persist-credentials"]).toBe(false);
    const action = steps(doc, "check").find((s) => s.uses?.startsWith(REGISTRY_ACTION_PATH));
    // The check job runs the pull request's eval suites, so it holds no token at all (R8);
    // build provenance is left to the sign job.
    expect(action?.with).toEqual({ mode: "check", "nimbus-gateway": GATEWAY_PATH });
  });

  test("the check job holds no secret or token and sets up the gateway before the check", async () => {
    const { dir } = await initGithub();
    const { text, doc } = workflow(dir, "registry-check.yml");
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("github.token");
    expect(job(doc, "check")["timeout-minutes"]).toBe(20);
    const names = steps(doc, "check").map((s) => s.name);
    const check = names.indexOf("Check");
    for (const before of ["Set up the sandbox", "Download the Nimbus gateway"]) {
      expect(names.indexOf(before)).toBeGreaterThan(-1);
      expect(names.indexOf(before)).toBeLessThan(check);
    }
  });

  test("the sign workflow: push to main + dispatch, environment, write, serialised, keeps credentials", async () => {
    const { dir } = await initGithub();
    const { doc } = workflow(dir, "registry-sign.yml");
    expect(doc["on"]).toEqual({ push: { branches: ["main"] }, workflow_dispatch: null });
    expect(doc["permissions"]).toEqual({ contents: "write" });
    expect(doc["concurrency"]).toEqual({ group: "registry-sign", "cancel-in-progress": false });
    expect(Object.keys(doc["jobs"] as object)).toEqual(["score", "sign"]);
    expect(job(doc, "sign")["needs"]).toBe("score");
    expect(job(doc, "sign")["environment"]).toBe("registry-signing");
    // The action pushes gh-pages with the token the checkout persisted.
    const checkout = checkoutStep(doc, "sign");
    expect(checkout.with?.["persist-credentials"]).toBeUndefined();
    // The sign mode fetches main and gh-pages itself and needs no history.
    expect(checkout.with?.["fetch-depth"]).toBeUndefined();
    const action = steps(doc, "sign").find((s) => s.uses?.startsWith(REGISTRY_ACTION_PATH));
    expect(action?.with).toEqual({
      mode: "sign",
      "default-branch": "main",
      "root-key": `\${{ secrets.${ROOT_KEY_SECRET} }}`,
      "github-token": `\${{ github.token }}`,
      scores: "scores.json",
    });
  });

  test("the sign job downloads the score job's scores.json before signing", async () => {
    const { dir } = await initGithub();
    const { doc } = workflow(dir, "registry-sign.yml");
    const download = usesStep(doc, "sign", "actions/download-artifact@");
    expect(download.uses).toBe(DOWNLOAD_ARTIFACT_ACTION.split(" #")[0]);
    expect(download.with).toEqual({ name: SCORES_ARTIFACT });
    const all = steps(doc, "sign");
    expect(all.indexOf(download)).toBeLessThan(
      all.indexOf(usesStep(doc, "sign", REGISTRY_ACTION_PATH)),
    );
    // No extension code, and no shell at all, runs in the job that holds the key.
    expect(runLines(doc, "sign")).toEqual([]);
  });

  test("the score job: no environment, read-only, no persisted credentials, no secret or token", async () => {
    const { dir } = await initGithub();
    const { doc } = workflow(dir, "registry-sign.yml");
    const score = job(doc, "score");
    expect(score["runs-on"]).toBe("ubuntu-24.04");
    expect(score["timeout-minutes"]).toBe(20);
    expect(score["environment"]).toBeUndefined();
    expect(score["needs"]).toBeUndefined();
    expect(score["permissions"]).toEqual({ contents: "read" });
    expect(checkoutStep(doc, "score").with?.["persist-credentials"]).toBe(false);
    const text = JSON.stringify(score);
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("github.token");
    expect(usesStep(doc, "score", REGISTRY_ACTION_PATH).with).toEqual({
      mode: "score",
      "default-branch": "main",
      "nimbus-gateway": GATEWAY_PATH,
    });
    const upload = usesStep(doc, "score", "actions/upload-artifact@");
    expect(upload.uses).toBe(UPLOAD_ARTIFACT_ACTION.split(" #")[0]);
    expect(upload.with).toEqual({
      name: SCORES_ARTIFACT,
      path: "scores.json",
      "if-no-files-found": "error",
    });
    const all = steps(doc, "score");
    expect(all.indexOf(usesStep(doc, "score", REGISTRY_ACTION_PATH))).toBeLessThan(
      all.indexOf(upload),
    );
  });

  test.each([
    ["registry-sign.yml", "score"],
    ["registry-check.yml", "check"],
  ])("%s %s: sudo for system changes, the smoke probe as the runner user", async (file, name) => {
    const { dir } = await initGithub();
    const lines = runLines(workflow(dir, file).doc, name);
    for (const line of [
      "sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Acquire::Retries=3 update -qq < /dev/null",
      "sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Acquire::Retries=3 install -y -qq bubblewrap < /dev/null",
      "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
      "sudo sysctl -w kernel.unprivileged_userns_clone=1 || true",
    ]) {
      expect(lines).toContain(line);
    }
    const probes = lines.filter((l) => l.includes("--unshare-user"));
    expect(probes).toHaveLength(1);
    const probe = probes[0] ?? "";
    // Root bypasses the userns restriction, so a probe under sudo would be a false green.
    expect(probe).not.toContain("sudo");
    expect(probe.startsWith("bwrap --unshare-user ")).toBe(true);
    for (const part of [
      "--unshare-net",
      "--ro-bind /usr /usr",
      "--ro-bind /etc /etc",
      "--ro-bind /lib /lib",
      "--proc /proc",
      "--dev /dev",
      "/usr/bin/true",
      `"\${lib64[@]}"`,
    ]) {
      expect(probe).toContain(part);
    }
    expect(lines.some((l) => l.includes("--ro-bind /lib64 /lib64"))).toBe(true);
  });

  test.each([
    ["registry-sign.yml", "score"],
    ["registry-check.yml", "check"],
  ])(
    "%s %s: downloads the pinned version's gateway, verifies only its line",
    async (file, name) => {
      const { dir } = await initGithub();
      const lines = runLines(workflow(dir, file).doc, name);
      const joined = lines.join("\n");
      const base = "https://github.com/nimbus-agent/Nimbus/releases/download/v9.9.9";
      expect(joined).toContain(base);
      expect(joined).toContain("nimbus-gateway-linux-x64");
      expect(joined).toContain("SHA256SUMS");
      const grep = lines.indexOf(
        "grep -E '^[0-9a-f]{64}  nimbus-gateway-linux-x64$' SHA256SUMS > CHECKSUM.txt",
      );
      const count = lines.indexOf('test "$(wc -l < CHECKSUM.txt)" -eq 1');
      const verify = lines.indexOf("sha256sum -c CHECKSUM.txt");
      const chmod = lines.indexOf("chmod +x nimbus-gateway-linux-x64");
      expect(grep).toBeGreaterThan(-1);
      expect(count).toBeGreaterThan(grep);
      expect(verify).toBeGreaterThan(count);
      expect(chmod).toBeGreaterThan(verify);
      // Checking the whole file fails on every asset this job did not download.
      expect(joined).not.toContain("sha256sum -c SHA256SUMS");
    },
  );

  test("never prints the root seed; prints the environment-scoped secret commands", async () => {
    const { key, site } = await initGithub();
    const text = out.join("");
    const seed = readFileSync(key, "utf8").trim();
    expect(text).toContain("fingerprint:");
    expect(text.split(seed).length - 1).toBe(0);
    const scoped = `gh secret set ${ROOT_KEY_SECRET} --env registry-signing --repo <owner>/<repo>`;
    expect(text).toContain(`${scoped} < '${key}'`);
    expect(text).toContain(`Get-Content -Raw '${key}' | ${scoped}`);
    // The secret is set only after the environment that gates it exists.
    expect(text.indexOf(scoped)).toBeGreaterThan(
      text.indexOf('Create the environment "registry-signing"'),
    );
    expect(text).toContain(site);
    expect(text).toMatch(/repository is public/);
    expect(text).toMatch(/On Windows the CLI sets no ACL on the key file/);
    expect(text).toMatch(/Protect gh-pages against force-push and deletion/);
    expect(text).toMatch(/GITHUB_TOKEN push still lands/);
    expect(text).toMatch(/sequence number\s+that was already used/);
  });

  test("the owner pushes the default branch last, after the environment and its secret", async () => {
    const { dir, site } = await initGithub();
    const text = out.join("");
    const at = (needle: string): number => {
      const i = text.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const environment = at('Create the environment "registry-signing"');
    const pushMain = at(`push ${dir} to the repository's main branch`);
    expect(at(`Push ${site} as the gh-pages branch`)).toBeLessThan(environment);
    expect(environment).toBeLessThan(pushMain);
    expect(at("gh secret set")).toBeLessThan(pushMain);
    expect(at("Set GitHub Pages to serve")).toBeLessThan(pushMain);
    expect(pushMain).toBeLessThan(at("Protect main: require pull requests"));
  });

  test("a release build pins the embedded release commit; --action-ref overrides it", async () => {
    const first = await initGithub([], RELEASE);
    expect(first.code).toBe(0);
    expect(workflow(first.dir, "registry-sign.yml").text).toContain(
      `${REGISTRY_ACTION_PATH}@${RELEASE_SHA} # v9.9.9`,
    );
    const again = await initGithub(["--action-ref", SHA, "--force"], RELEASE);
    expect(again.code).toBe(0);
    expect(workflow(again.dir, "registry-check.yml").text).toContain(
      `${REGISTRY_ACTION_PATH}@${SHA}`,
    );
  });

  test("a dev build without --action-ref refuses and writes nothing, not even the key", async () => {
    const { dir, key, site, code } = await initGithub([], DEV);
    expect(code).toBe(2);
    expect(err.join("")).toContain("--action-ref");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(site)).toBe(false);
    expect(existsSync(key)).toBe(false);
  });

  test.each([
    ["a short SHA", ["--action-ref", "0123456"]],
    ["an uppercase SHA", ["--action-ref", SHA.toUpperCase()]],
    ["a tag", ["--action-ref", "v9.9.9"]],
  ])("refuses %s as --action-ref", async (_what, extra) => {
    const { key, code } = await initGithub(extra);
    expect(code).toBe(2);
    expect(err.join("")).toContain("40-hex");
    expect(existsSync(key)).toBe(false);
  });

  test("refuses an embedded release commit that is not a 40-hex SHA", async () => {
    const { code } = await initGithub([], { releaseCommit: "not-a-sha", version: "9.9.9" });
    expect(code).toBe(2);
    expect(err.join("")).toContain("--action-ref");
  });

  test.each([
    ["--action-ref", ["--action-ref", SHA]],
    ["--site", ["--site", "x"]],
    ["--default-branch", ["--default-branch", "trunk"]],
    ["--no-publisher-namespace", ["--no-publisher-namespace"]],
  ] as const)("%s without --github refuses", async (_name, flag) => {
    const code = await runRegistryMaintain(
      ["init", join(tmp, "reg"), "--key", join(tmp, "k"), ...flag],
      io,
      DEV,
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("needs --github");
  });

  test("refuses a site folder inside <dir>", async () => {
    const { key, code } = await initGithub([
      "--action-ref",
      SHA,
      "--site",
      join(tmp, "reg", "site"),
    ]);
    expect(code).toBe(2);
    expect(err.join("")).toContain("neither folder may hold the other");
    expect(existsSync(key)).toBe(false);
  });

  test("refuses a site folder that contains <dir>", async () => {
    const dir = join(tmp, "site", "reg");
    const key = join(tmp, "k");
    const code = await runRegistryMaintain(
      ["init", dir, "--key", key, "--github", "--action-ref", SHA, "--site", join(tmp, "site")],
      io,
      DEV,
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("neither folder may hold the other");
    expect(existsSync(key)).toBe(false);
  });

  test.each([
    ["inside <dir>", ["reg", ".nimbus", "registry-key"]],
    ["equal to a file path in <dir>", ["reg", "README.md"]],
    ["inside the site folder", ["reg-site", "registry-key"]],
  ])("refuses a --key path %s, before generating any key", async (_what, rel) => {
    const key = join(tmp, ...rel);
    const code = await runRegistryMaintain(
      ["init", join(tmp, "reg"), "--key", key, "--github", "--action-ref", SHA],
      io,
      DEV,
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("pushed to GitHub");
    expect(existsSync(key)).toBe(false);
    expect(existsSync(join(tmp, "reg"))).toBe(false);
  });

  test("--default-branch is threaded into both workflows' branch filters", async () => {
    const { dir, code } = await initGithub(["--action-ref", SHA, "--default-branch", "release/v2"]);
    expect(code).toBe(0);
    expect(workflow(dir, "registry-check.yml").doc["on"]).toEqual({
      pull_request: { branches: ["release/v2"] },
    });
    expect(workflow(dir, "registry-sign.yml").doc["on"]).toEqual({
      push: { branches: ["release/v2"] },
      workflow_dispatch: null,
    });
    // The sign action is told the branch too, rather than reading origin's HEAD.
    const sign = steps(workflow(dir, "registry-sign.yml").doc, "sign").find((s) =>
      s.uses?.startsWith(REGISTRY_ACTION_PATH),
    );
    expect(sign?.with?.["default-branch"]).toBe("release/v2");
    expect(lintWorkflow("registry-sign.yml", workflow(dir, "registry-sign.yml").text)).toEqual([]);
  });

  test("a numeric-looking branch name stays a string in the YAML", async () => {
    const { dir } = await initGithub(["--action-ref", SHA, "--default-branch", "2024"]);
    expect(workflow(dir, "registry-sign.yml").doc["on"]).toEqual({
      push: { branches: ["2024"] },
      workflow_dispatch: null,
    });
  });

  test.each([
    "-main",
    ".main",
    "a..b",
    "a//b",
    "a/.b",
    "main/",
    "main.",
    "main.lock",
    "has space",
    "x:y",
    "a]b",
    "",
    "x".repeat(101),
  ])("refuses --default-branch %p", async (branch) => {
    const { key, code } = await initGithub(["--action-ref", SHA, "--default-branch", branch]);
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/--default-branch/);
    expect(existsSync(key)).toBe(false);
  });

  test("refuses when <dir> holds an index.json, even with --force", async () => {
    mkdirSync(join(tmp, "reg"), { recursive: true });
    writeFileSync(join(tmp, "reg", "index.json"), "{}");
    const { key, code } = await initGithub(["--action-ref", SHA, "--force"]);
    expect(code).toBe(2);
    expect(err.join("")).toContain("never holds a signed index");
    expect(existsSync(key)).toBe(false);
  });

  test("refuses to overwrite an existing file without --force", async () => {
    mkdirSync(join(tmp, "reg"), { recursive: true });
    writeFileSync(join(tmp, "reg", "README.md"), "# mine\n");
    const { key, code } = await initGithub();
    expect(code).toBe(2);
    expect(err.join("")).toContain("README.md exists");
    expect(readFileSync(join(tmp, "reg", "README.md"), "utf8")).toBe("# mine\n");
    expect(existsSync(key)).toBe(false);
  });

  test("refuses to overwrite an existing site file without --force", async () => {
    mkdirSync(join(tmp, "reg-site"), { recursive: true });
    writeFileSync(join(tmp, "reg-site", ".nojekyll"), "mine");
    const { key, code } = await initGithub();
    expect(code).toBe(2);
    expect(err.join("")).toContain(".nojekyll exists");
    expect(readFileSync(join(tmp, "reg-site", ".nojekyll"), "utf8")).toBe("mine");
    expect(existsSync(key)).toBe(false);
  });
});
