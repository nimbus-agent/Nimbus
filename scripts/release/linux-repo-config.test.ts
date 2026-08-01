import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

import {
  APT_ARCH,
  APT_CODENAME,
  APT_COMPONENT,
  assetSha256,
  DEFAULT_RETAINED_RELEASES,
  debAssetName,
  planYumRetention,
  renderRepreproDistributions,
  renderYumRepoFile,
  rpmAssetName,
  rpmVersionOf,
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
    // The current release counts against the budget, so N stays a hard cap.
    expect(plan.keep).toHaveLength(2);
    expect(plan.keep).toEqual(rpms("2.2.0", "1.0.0"));
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
    return { steps: workflowSteps(yaml.load(text)), parseError: null };
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
