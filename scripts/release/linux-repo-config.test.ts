import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load as loadYaml } from "js-yaml";

import {
  APT_ARCH,
  APT_CODENAME,
  APT_COMPONENT,
  assetSha256,
  DEFAULT_RETAINED_RELEASES,
  debAssetName,
  downloadVerifiedRpm,
  planYumRetention,
  renderRepreproDistributions,
  renderYumRepoFile,
  rpmAssetName,
  rpmVersionOf,
  stableVersionsNewestFirst,
  stageRetainedRpms,
} from "./linux-repo-config.ts";

const SUMS = [
  "1111111111111111111111111111111111111111111111111111111111111111  nimbus-headless_1.2.3_amd64.deb",
  "2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-1.2.3-x86_64.rpm",
  "3333333333333333333333333333333333333333333333333333333333333333  SHA256SUMS",
  "",
].join("\n");

describe("linux-repo-config artifact helpers", () => {
  test("debAssetName builds the released .deb name, stripping a leading v", () => {
    expect(debAssetName("1.2.3")).toBe("nimbus-headless_1.2.3_amd64.deb");
    expect(debAssetName("v1.2.3")).toBe("nimbus-headless_1.2.3_amd64.deb");
  });

  test("rpmAssetName builds the released .rpm name, stripping a leading v", () => {
    expect(rpmAssetName("1.2.3")).toBe("nimbus-headless-1.2.3-x86_64.rpm");
    expect(rpmAssetName("v1.2.3")).toBe("nimbus-headless-1.2.3-x86_64.rpm");
  });

  test("assetSha256 extracts a file's hash from SHA256SUMS", () => {
    expect(assetSha256(SUMS, "nimbus-headless_1.2.3_amd64.deb")).toBe(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(assetSha256(SUMS, "nimbus-headless-1.2.3-x86_64.rpm")).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  test("assetSha256 throws (fail loud) when the file is absent", () => {
    expect(() => assetSha256(SUMS, "nope.deb")).toThrow("nope.deb");
  });
});

describe("renderRepreproDistributions", () => {
  const conf = renderRepreproDistributions();

  test("declares the stable distribution with our codename/component/arch", () => {
    expect(conf).toContain(`Codename: ${APT_CODENAME}`);
    expect(conf).toContain(`Components: ${APT_COMPONENT}`);
    expect(conf).toContain(`Architectures: ${APT_ARCH}`);
  });

  test("does NOT set SignWith (we sign Release manually with loopback gpg)", () => {
    expect(conf).not.toContain("SignWith");
  });

  test("ends with a trailing newline (reprepro requires a final newline)", () => {
    expect(conf.endsWith("\n")).toBe(true);
  });
});

describe("renderYumRepoFile", () => {
  const repo = renderYumRepoFile({ baseUrl: "https://nimbus-agent.github.io/linux-repo" });

  test("points baseurl at the yum tree and gpgkey at the published key", () => {
    expect(repo).toContain("baseurl=https://nimbus-agent.github.io/linux-repo/yum");
    expect(repo).toContain("gpgkey=https://nimbus-agent.github.io/linux-repo/gpg.key");
  });

  test("verifies signed repo metadata but not per-RPM headers (packages aren't header-signed)", () => {
    // repo_gpgcheck=1 verifies the signed repomd.xml (the trust anchor).
    expect(repo).toContain("repo_gpgcheck=1");
    // gpgcheck=0: the .rpm is not header-signed, so per-package checks would
    // make dnf reject every install. (Substring note: "repo_gpgcheck=1" itself
    // contains "gpgcheck=1", so assert the explicit gpgcheck=0 line instead.)
    expect(repo).toContain("\ngpgcheck=0\n");
  });

  test("strips a trailing slash on baseUrl so URLs aren't doubled", () => {
    const r = renderYumRepoFile({ baseUrl: "https://nimbus-agent.github.io/linux-repo/" });
    expect(r).toContain("baseurl=https://nimbus-agent.github.io/linux-repo/yum");
    expect(r).not.toContain("linux-repo//yum");
  });
});

describe("rpmVersionOf", () => {
  test("reads the version out of a published RPM name", () => {
    expect(rpmVersionOf(rpmAssetName("1.2.3"))).toBe("1.2.3");
    expect(rpmVersionOf("nimbus-headless-1.10.0-x86_64.rpm")).toBe("1.10.0");
  });

  test("returns null for anything that is not one of our RPMs", () => {
    // Never a deletion candidate: not an RPM, another package, another arch,
    // or a version string Bun.semver cannot order.
    expect(rpmVersionOf("repodata")).toBeNull();
    expect(rpmVersionOf("nimbus-headless-1.2.3-x86_64.rpm.asc")).toBeNull();
    expect(rpmVersionOf("other-tool-1.2.3-x86_64.rpm")).toBeNull();
    expect(rpmVersionOf("nimbus-headless-1.2.3-aarch64.rpm")).toBeNull();
    expect(rpmVersionOf("nimbus-headless-not-a-version-x86_64.rpm")).toBeNull();
  });
});

describe("planYumRetention", () => {
  const rpms = (...versions: string[]): string[] => versions.map(rpmAssetName);

  test("keeps the newest N and removes the rest, ordering by semver not string", () => {
    // 1.9.0 > 1.10.0 lexically; the plan must not fall for that.
    const plan = planYumRetention({
      entries: rpms("1.2.0", "1.9.0", "1.10.0", "1.11.0"),
      currentVersion: "1.11.0",
      retain: 2,
    });
    expect(plan.keep).toEqual(rpms("1.11.0", "1.10.0"));
    expect(plan.remove).toEqual(rpms("1.9.0", "1.2.0"));
  });

  test("defaults to DEFAULT_RETAINED_RELEASES when no retain is given", () => {
    const plan = planYumRetention({
      entries: rpms("1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"),
      currentVersion: "1.4.0",
    });
    expect(plan.retain).toBe(DEFAULT_RETAINED_RELEASES);
    expect(plan.keep).toHaveLength(DEFAULT_RETAINED_RELEASES);
    expect(plan.keep).toContain(rpmAssetName("1.4.0"));
    expect(plan.remove).not.toContain(rpmAssetName("1.4.0"));
  });

  test("never removes the release being published, even when older tags sort above it", () => {
    // Re-publishing an older tag (workflow_dispatch) stages its RPM into a tree
    // whose other entries are all newer. Deleting it would publish metadata for
    // a package that is not there.
    const plan = planYumRetention({
      entries: rpms("1.0.0", "2.0.0", "2.1.0", "2.2.0"),
      currentVersion: "1.0.0",
      retain: 2,
    });
    expect(plan.keep).toContain(rpmAssetName("1.0.0"));
    expect(plan.remove).not.toContain(rpmAssetName("1.0.0"));
    // UNION of "newest 2" and "the one being published" -> 3 entries, not 2.
    // The republished tag is an EXTRA, so retain is a floor on how many newest
    // releases survive rather than a cap the old tag can eat into.
    expect(plan.keep).toEqual(rpms("2.2.0", "2.1.0", "1.0.0"));
    expect(plan.remove).toEqual(rpms("2.0.0"));
  });

  test("a re-publish of an old tag at retain=1 still keeps the newest release", () => {
    // Regression, and the sharpest form of it: with the current release seeded
    // into the keep-set BEFORE the newest-N pass, retain=1 filled the single
    // slot with 1.0.0 and planned the deletion of every newer RPM in the
    // channel — keep=[1.0.0], remove=[2.2.0, 2.1.0, 2.0.0]. One
    // workflow_dispatch of an old tag would have taken `dnf install
    // nimbus-headless` back two majors.
    const plan = planYumRetention({
      entries: rpms("1.0.0", "2.0.0", "2.1.0", "2.2.0"),
      currentVersion: "1.0.0",
      retain: 1,
    });
    expect(plan.keep).toEqual(rpms("2.2.0", "1.0.0"));
    expect(plan.remove).toEqual(rpms("2.1.0", "2.0.0"));
    expect(plan.remove).not.toContain(rpmAssetName("2.2.0"));
  });

  test("is a no-op when the tree already holds N or fewer releases", () => {
    const plan = planYumRetention({
      entries: rpms("1.0.0", "1.1.0"),
      currentVersion: "1.1.0",
      retain: 5,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(rpms("1.1.0", "1.0.0"));
  });

  test("leaves every non-RPM entry alone — repodata is regenerated, never pruned", () => {
    const entries = [
      "repodata",
      ".nojekyll",
      "nimbus-headless-1.0.0-x86_64.rpm.asc",
      "other-tool-9.9.9-x86_64.rpm",
      ...rpms("1.0.0", "1.1.0"),
    ];
    const plan = planYumRetention({ entries, currentVersion: "1.1.0", retain: 1 });
    expect(plan.remove).toEqual(rpms("1.0.0"));
    for (const untouched of entries.filter((e) => rpmVersionOf(e) === null)) {
      expect(plan.remove).not.toContain(untouched);
      expect(plan.keep).not.toContain(untouched);
    }
  });

  test("clamps a zero/negative/NaN retain to 1 so the channel is never emptied", () => {
    for (const retain of [0, -3, Number.NaN]) {
      const plan = planYumRetention({
        entries: rpms("1.0.0", "1.1.0"),
        currentVersion: "1.1.0",
        retain,
      });
      // NaN is "not configured" -> default; 0 and -3 clamp to 1. Either way the
      // release just staged survives.
      expect(plan.retain).toBeGreaterThanOrEqual(1);
      expect(plan.keep).toContain(rpmAssetName("1.1.0"));
      expect(plan.remove).not.toContain(rpmAssetName("1.1.0"));
    }
    expect(
      planYumRetention({ entries: rpms("1.0.0"), currentVersion: "1.0.0", retain: 0 }).retain,
    ).toBe(1);
  });

  test("keep and remove partition the candidate RPMs with no overlap", () => {
    const entries = [...rpms("1.0.0", "1.1.0", "1.2.0", "1.3.0"), "repodata"];
    const plan = planYumRetention({ entries, currentVersion: "1.3.0", retain: 2 });
    expect([...plan.keep, ...plan.remove].sort()).toEqual(
      entries.filter((e) => rpmVersionOf(e) !== null).sort(),
    );
    expect(plan.keep.filter((f) => plan.remove.includes(f))).toEqual([]);
  });

  test("tolerates a duplicated directory entry without double-listing it", () => {
    const plan = planYumRetention({
      entries: [...rpms("1.0.0", "1.1.0"), rpmAssetName("1.0.0")],
      currentVersion: "1.1.0",
      retain: 1,
    });
    expect(plan.remove).toEqual(rpms("1.0.0"));
  });
});

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release", "linux-repo-config.ts");

describe("--prune-yum CLI", () => {
  // Closes the loop between the flag the workflow types and the flag the script
  // parses: a rename on either side would leave the publish silently un-pruned.
  test("deletes exactly the planned RPMs from a real directory, leaving repodata", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-yum-"));
    try {
      mkdirSync(join(dir, "repodata"));
      writeFileSync(join(dir, "repodata", "repomd.xml"), "<stale/>", "utf8");
      for (const v of ["1.0.0", "1.1.0", "1.9.0", "1.10.0"]) {
        writeFileSync(join(dir, rpmAssetName(v)), v, "utf8");
      }
      const run = spawnSync(process.execPath, [SCRIPT, "--prune-yum", dir, "--version", "1.10.0"], {
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(
        ["repodata", ...["1.10.0", "1.9.0", "1.1.0"].map(rpmAssetName)].sort(),
      );
      // The prune must NOT touch metadata — createrepo_c regenerates it next.
      expect(readFileSync(join(dir, "repodata", "repomd.xml"), "utf8")).toBe("<stale/>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--retain overrides the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-yum-"));
    try {
      for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
        writeFileSync(join(dir, rpmAssetName(v)), v, "utf8");
      }
      const run = spawnSync(
        process.execPath,
        [SCRIPT, "--prune-yum", dir, "--version", "1.2.0", "--retain", "1"],
        { encoding: "utf8" },
      );
      expect(run.status).toBe(0);
      expect(readdirSync(dir)).toEqual([rpmAssetName("1.2.0")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["the --retain flag", ["--retain", "five"], {}],
    ["the NIMBUS_LINUX_REPO_RETAIN variable", [], { NIMBUS_LINUX_REPO_RETAIN: "five" }],
    ["a non-integer retain", ["--retain", "3.5"], {}],
  ])("fails loud on a malformed retention override via %s", (_label, args, env) => {
    // A misconfigured override must NOT silently fall back to the default and
    // prune with a retention nobody chose: the operator would believe the value
    // they set was in force, and the only evidence would be the deleted RPMs.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-yum-"));
    try {
      for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
        writeFileSync(join(dir, rpmAssetName(v)), v, "utf8");
      }
      const run = spawnSync(
        process.execPath,
        [SCRIPT, "--prune-yum", dir, "--version", "1.3.0", ...args],
        { encoding: "utf8", env: { ...process.env, NIMBUS_LINUX_REPO_RETAIN: "", ...env } },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("must be an integer");
      // Fail-closed: nothing is deleted on the way out.
      expect(readdirSync(dir).sort()).toEqual(
        ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map(rpmAssetName).sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["an unset", ""],
    ["a whitespace-only", "  "],
  ])("treats %s NIMBUS_LINUX_REPO_RETAIN as not configured, not as a value", (_label, value) => {
    // An unset repo variable arrives as "" — the one blank that must keep
    // meaning "use the default" rather than erroring or (worse, pre-fix)
    // parsing to 0 and clamping the whole channel down to a single release.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-yum-"));
    try {
      for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
        writeFileSync(join(dir, rpmAssetName(v)), v, "utf8");
      }
      const run = spawnSync(process.execPath, [SCRIPT, "--prune-yum", dir, "--version", "1.3.0"], {
        encoding: "utf8",
        env: { ...process.env, NIMBUS_LINUX_REPO_RETAIN: value },
      });
      expect(run.status).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(["1.1.0", "1.2.0", "1.3.0"].map(rpmAssetName).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails loud without --version rather than guessing which release is current", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-yum-"));
    try {
      writeFileSync(join(dir, rpmAssetName("1.0.0")), "x", "utf8");
      const run = spawnSync(process.execPath, [SCRIPT, "--prune-yum", dir], {
        encoding: "utf8",
        env: { ...process.env, NIMBUS_RELEASE_VERSION: "" },
      });
      expect(run.status).toBe(1);
      expect(readdirSync(dir)).toEqual([rpmAssetName("1.0.0")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

interface WorkflowStep {
  name: string;
  run: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every step of every job, flattened, with only the fields this test reads. */
function workflowSteps(doc: unknown): WorkflowStep[] {
  const jobs = isRecord(doc) && isRecord(doc["jobs"]) ? Object.values(doc["jobs"]) : [];
  const steps: WorkflowStep[] = [];
  for (const job of jobs) {
    const list = isRecord(job) && Array.isArray(job["steps"]) ? job["steps"] : [];
    for (const step of list) {
      if (!isRecord(step)) continue;
      steps.push({
        name: typeof step["name"] === "string" ? step["name"] : "",
        run: typeof step["run"] === "string" ? step["run"] : "",
      });
    }
  }
  return steps;
}

/**
 * Fail-closed like `parseWorkflow` in
 * `scripts/structure-audit/check-workflow-run-triggers.ts`: a syntax error is
 * reported as a finding rather than thrown out of module scope, so the failure
 * names the problem instead of aborting the whole test file.
 */
function parseWorkflowYaml(text: string): { steps: WorkflowStep[]; parseError: string | null } {
  try {
    return { steps: workflowSteps(loadYaml(text)), parseError: null };
  } catch (err) {
    return { steps: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

describe("publish-linux-repo.yml yum prune ordering", () => {
  const path = join(ROOT, ".github", "workflows", "publish-linux-repo.yml");
  const { steps, parseError } = parseWorkflowYaml(readFileSync(path, "utf8"));

  test("the workflow parses as YAML and exposes its steps", () => {
    expect(parseError).toBeNull();
    expect(steps.length).toBeGreaterThan(0);
  });

  test("exactly one step builds the yum metadata, and it also runs the prune", () => {
    const building = steps.filter((s) => s.run.includes("createrepo_c repo/yum"));
    expect(building).toHaveLength(1);
    expect(building[0]?.run).toContain("--prune-yum repo/yum");
  });

  test("the prune runs BEFORE createrepo_c, so repodata never references a deleted RPM", () => {
    // The whole point of the change: metadata is generated from the post-prune
    // directory listing. Reversing these two lines silently ships a broken
    // channel (repodata pointing at RPMs that are gone).
    const step = steps.find((s) => s.run.includes("createrepo_c repo/yum"));
    const script = step?.run ?? "";
    const prune = script.indexOf("--prune-yum repo/yum");
    const createrepo = script.indexOf("createrepo_c repo/yum");
    expect(prune).toBeGreaterThan(-1);
    expect(createrepo).toBeGreaterThan(prune);
    // ...and the RPM is staged before the prune, so it is in the listing the
    // plan sees (otherwise the "always keep the current release" rule is moot).
    expect(script.indexOf('cp "$RPM" repo/yum/')).toBeLessThan(prune);
  });

  test("no later step deletes from the yum tree after the metadata is built", () => {
    const buildIndex = steps.findIndex((s) => s.run.includes("createrepo_c repo/yum"));
    const after = steps.slice(buildIndex + 1);
    expect(after.length).toBeGreaterThan(0); // the sign + commit steps
    for (const step of after) {
      expect(step.run).not.toContain("--prune-yum");
      expect(step.run).not.toMatch(/\brm\b[^\n]*repo\/yum/);
    }
  });

  test("the repomd signature is produced after the metadata it signs", () => {
    const buildIndex = steps.findIndex((s) => s.run.includes("createrepo_c repo/yum"));
    const signIndex = steps.findIndex((s) => s.run.includes("repo/yum/repodata/repomd.xml"));
    expect(signIndex).toBeGreaterThan(buildIndex);
  });
});

describe("stableVersionsNewestFirst", () => {
  test("keeps only stable v tags, newest first by semver and not by string", () => {
    expect(
      stableVersionsNewestFirst([
        "v9.2.1",
        "v10.14.1",
        "v10.2.0",
        "v11.0.0-rc.1",
        "client-v1.0.0",
        "site-10.14.1-1-1",
        "not-a-version",
      ]),
    ).toEqual(["10.14.1", "10.2.0", "9.2.1"]);
  });
});

describe("stageRetainedRpms", () => {
  function stage(
    tags: readonly string[],
    currentVersion: string,
    retain: number | undefined,
    missing: readonly string[] = [],
  ): string[] {
    const fetched: string[] = [];
    stageRetainedRpms({
      tags,
      currentVersion,
      retain,
      fetchRpm: (version) => {
        fetched.push(version);
        return !missing.includes(version);
      },
    });
    return fetched;
  }

  test("fetches the newest releases up to retain, never the one already staged", () => {
    expect(stage(["v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"], "4.0.0", 3)).toEqual(["3.0.0", "2.0.0"]);
  });

  test("an abandoned release with no assets costs no slot: the next one fills it", () => {
    expect(stage(["v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"], "4.0.0", 3, ["3.0.0"])).toEqual([
      "3.0.0",
      "2.0.0",
      "1.0.0",
    ]);
  });

  test("re-publishing an old tag still fetches the newest, so retention can keep them", () => {
    expect(stage(["v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"], "1.0.0", 3)).toEqual([
      "4.0.0",
      "3.0.0",
      "2.0.0",
    ]);
  });

  test("retain 1 fetches nothing when the release being published is the newest", () => {
    expect(stage(["v2.0.0", "v1.0.0"], "2.0.0", 1)).toEqual([]);
  });

  test("the default retention applies when none is configured", () => {
    const tags = ["v5.0.0", "v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"];
    expect(stage(tags, "5.0.0", undefined)).toHaveLength(DEFAULT_RETAINED_RELEASES - 1);
  });

  test("a failure while fetching stops the publish", () => {
    expect(() =>
      stageRetainedRpms({
        tags: ["v2.0.0", "v1.0.0"],
        currentVersion: "2.0.0",
        retain: 2,
        fetchRpm: () => {
          throw new Error("checksum mismatch");
        },
      }),
    ).toThrow("checksum mismatch");
  });
});

describe("downloadVerifiedRpm", () => {
  const VERSION = "1.2.3";
  const RPM = rpmAssetName(VERSION);
  const BODY = "rpm body";
  const SHA = new Bun.CryptoHasher("sha256").update(BODY).digest("hex");

  function withDir<T>(run: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-linux-repo-"));
    try {
      return run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A stand-in for `gh release download`: writes what the release holds into `--dir`. */
  function gh(files: Record<string, string>, result: { status: number; stderr: string }) {
    return (args: readonly string[]) => {
      const dir = args[args.indexOf("--dir") + 1] ?? "";
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
      return result;
    };
  }
  const OK = { status: 0, stderr: "" };

  test("moves a verified RPM into the yum tree and leaves nothing else there", () => {
    withDir((dir) => {
      const run = gh({ [RPM]: BODY, SHA256SUMS: `${SHA}  ${RPM}\n` }, OK);
      expect(downloadVerifiedRpm(VERSION, dir, run)).toBe(true);
      expect(readdirSync(dir)).toEqual([RPM]);
      expect(readFileSync(join(dir, RPM), "utf8")).toBe(BODY);
    });
  });

  test("a checksum mismatch throws and stages nothing", () => {
    withDir((dir) => {
      const wrong = "0".repeat(64);
      const run = gh({ [RPM]: BODY, SHA256SUMS: `${wrong}  ${RPM}\n` }, OK);
      expect(() => downloadVerifiedRpm(VERSION, dir, run)).toThrow("checksum mismatch");
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  // The second message is what gh 2.96.0 printed for a real release whose assets match no pattern.
  for (const stderr of ["no assets to download", "no assets match the file pattern"]) {
    test(`a release gh answers with "${stderr}" is missing, not a failure`, () => {
      withDir((dir) => {
        const run = gh({}, { status: 1, stderr });
        expect(downloadVerifiedRpm(VERSION, dir, run)).toBe(false);
        expect(readdirSync(dir)).toEqual([]);
      });
    });
  }

  test("a release holding SHA256SUMS but no RPM is missing", () => {
    withDir((dir) => {
      expect(downloadVerifiedRpm(VERSION, dir, gh({ SHA256SUMS: "" }, OK))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("an RPM with no SHA256SUMS throws: nothing unverified is ever published", () => {
    withDir((dir) => {
      expect(() => downloadVerifiedRpm(VERSION, dir, gh({ [RPM]: BODY }, OK))).toThrow(
        "SHA256SUMS",
      );
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("any other gh failure throws rather than quietly shrinking the channel", () => {
    withDir((dir) => {
      const run = gh({}, { status: 1, stderr: "HTTP 503: Service Unavailable" });
      expect(() => downloadVerifiedRpm(VERSION, dir, run)).toThrow("503");
    });
  });
});

/** The publish job's raw YAML: `if` and `concurrency` are what the deploy mode rests on. */
function publishJob(): { job: Record<string, unknown>; steps: Record<string, unknown>[] } {
  const path = join(ROOT, ".github", "workflows", "publish-linux-repo.yml");
  const doc = loadYaml(readFileSync(path, "utf8"));
  const jobs = isRecord(doc) && isRecord(doc["jobs"]) ? doc["jobs"] : {};
  const job = isRecord(jobs["publish-linux-repo"]) ? jobs["publish-linux-repo"] : {};
  const steps = Array.isArray(job["steps"]) ? job["steps"].filter(isRecord) : [];
  return { job, steps };
}

describe("publish-linux-repo.yml deploy modes", () => {
  const { job, steps } = publishJob();
  const named = (name: string) => steps.find((s) => s["name"] === name);
  const ACTIONS = "vars.NIMBUS_LINUX_REPO_DEPLOY == 'actions'";
  const NOT_ACTIONS = "vars.NIMBUS_LINUX_REPO_DEPLOY != 'actions'";

  test("with the variable unset, the Git path is the one that runs", () => {
    expect(named("Clone the linux-repo Pages repo")?.["if"]).toBe(NOT_ACTIONS);
    expect(named("Commit + push to linux-repo")?.["if"]).toBe(NOT_ACTIONS);
  });

  test("only the Actions path hands off, waits and prunes, and it never clones", () => {
    for (const name of [
      "Start from an empty tree",
      "Hand the tree to linux-repo",
      "Wait until Pages serves this release",
      "Prune old site releases",
    ]) {
      expect(named(name)?.["if"]).toBe(ACTIONS);
    }
  });

  test("a mistyped mode fails before anything is built", () => {
    const check = steps.findIndex((s) => s["name"] === "Check the deploy mode");
    const build = steps.findIndex((s) => String(s["run"] ?? "").includes("createrepo_c repo/yum"));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(build);
    expect(String(steps[check]?.["run"])).toContain("exit 1");
  });

  test("older RPMs are staged before the prune, so retention still decides what stays", () => {
    const script = String(
      steps.find((s) => String(s["run"] ?? "").includes("createrepo_c"))?.["run"],
    );
    const stage = script.indexOf("--stage-yum-rpms repo/yum");
    expect(stage).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(script.indexOf("--prune-yum repo/yum"));
  });

  test("the handoff comes after signing, and the wait after the handoff", () => {
    const at = (name: string) => steps.findIndex((s) => s["name"] === name);
    expect(at("Hand the tree to linux-repo")).toBeGreaterThan(
      at("Sign apt Release + yum repomd (loopback gpg)"),
    );
    expect(at("Wait until Pages serves this release")).toBeGreaterThan(
      at("Hand the tree to linux-repo"),
    );
    expect(at("Prune old site releases")).toBeGreaterThan(
      at("Wait until Pages serves this release"),
    );
  });

  test("a failed wait fails the job: only pruning may fail quietly", () => {
    expect(named("Wait until Pages serves this release")?.["continue-on-error"]).toBeUndefined();
    expect(String(named("Wait until Pages serves this release")?.["run"])).toContain("exit 1");
    expect(named("Prune old site releases")?.["continue-on-error"]).toBe(true);
  });

  test("the wait reads this run's marker, not a version an earlier deploy may already serve", () => {
    const handoff = String(named("Hand the tree to linux-repo")?.["run"]);
    expect(handoff.indexOf("> repo/site-id.txt")).toBeGreaterThan(-1);
    expect(handoff.indexOf("> repo/site-id.txt")).toBeLessThan(handoff.indexOf("tar -C repo"));
    const wait = String(named("Wait until Pages serves this release")?.["run"]);
    expect(wait).toContain("/site-id.txt?");
    expect(wait).toContain('[ "$served" = "$SITE_TAG" ]');
    expect(wait).not.toContain("Version:");
  });

  test("one publish at a time across every tag", () => {
    const concurrency = job["concurrency"];
    expect(isRecord(concurrency) ? concurrency["group"] : undefined).toBe("publish-linux-repo");
  });
});
