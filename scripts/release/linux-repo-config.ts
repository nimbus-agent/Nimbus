#!/usr/bin/env bun
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSha256Sums } from "./package-manager-manifests.ts";

/** apt distribution coordinates. `stable` tracks the latest stable release. */
export const APT_CODENAME = "stable";
export const APT_COMPONENT = "main";
export const APT_ARCH = "amd64";

/** The shared package name for both the .deb and the .rpm. */
const PACKAGE_NAME = "nimbus-headless";

function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/** Released `.deb` filename for a version, e.g. `nimbus-headless_1.2.3_amd64.deb`. */
export function debAssetName(version: string): string {
  return `${PACKAGE_NAME}_${stripV(version)}_${APT_ARCH}.deb`;
}

/** Released `.rpm` filename for a version, e.g. `nimbus-headless-1.2.3-x86_64.rpm`. */
export function rpmAssetName(version: string): string {
  return `${PACKAGE_NAME}-${stripV(version)}-x86_64.rpm`;
}

/**
 * The sha256 of a named asset, read from a SHA256SUMS string. Throws (fail
 * loud) if the asset is absent — we never publish an artifact we couldn't
 * verify against the release manifest.
 */
export function assetSha256(sha256SumsText: string, filename: string): string {
  const hash = parseSha256Sums(sha256SumsText).get(filename);
  if (!hash) {
    throw new Error(
      `linux-repo-config: required release asset not found in SHA256SUMS: ${filename}`,
    );
  }
  return hash;
}

export interface RepreproOptions {
  origin?: string;
  label?: string;
  description?: string;
}

/**
 * Render reprepro's `conf/distributions`. No `SignWith`: the workflow signs
 * the generated `Release` itself (detached `Release.gpg` + clearsigned
 * `InRelease`) with loopback gpg, mirroring `sign-linux-gpg.sh`.
 */
export function renderRepreproDistributions(opts: RepreproOptions = {}): string {
  const origin = opts.origin ?? "Nimbus";
  const label = opts.label ?? "Nimbus";
  const description = opts.description ?? "Nimbus headless apt repository";
  return [
    `Origin: ${origin}`,
    `Label: ${label}`,
    `Codename: ${APT_CODENAME}`,
    `Architectures: ${APT_ARCH}`,
    `Components: ${APT_COMPONENT}`,
    `Description: ${description}`,
    "",
  ].join("\n");
}

export interface YumRepoOptions {
  /** Repo root, e.g. `https://nimbus-agent.github.io/linux-repo` (trailing slash tolerated). */
  baseUrl: string;
}

/**
 * Render the yum client `.repo` file (`baseurl` -> /yum, `gpgkey` -> /gpg.key).
 *
 * `repo_gpgcheck=1` (verify the GPG-signed `repomd.xml`) is the trust anchor —
 * the same repo-metadata-signing model as the apt `[signed-by=...]` setup, and
 * it chains to per-package integrity via the checksums inside the signed
 * metadata. `gpgcheck=0` because the `.rpm` packages themselves are NOT
 * header-signed (`rpm --addsign`) — the release pipeline
 * emits only a detached `.asc`, so `gpgcheck=1` would make `dnf` reject
 * every install with "package is not signed". Flip to `1` only once the build
 * header-signs the RPM.
 */
export function renderYumRepoFile(opts: YumRepoOptions): string {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return [
    "[nimbus]",
    "name=Nimbus headless",
    `baseurl=${base}/yum`,
    "enabled=1",
    "gpgcheck=0",
    "repo_gpgcheck=1",
    `gpgkey=${base}/gpg.key`,
    "",
  ].join("\n");
}

/**
 * How many `nimbus-headless` releases the yum channel keeps.
 *
 * The apt side has always been self-pruning: the publish workflow runs
 * `reprepro remove stable nimbus-headless` before `includedeb`, and reprepro
 * garbage-collects the pool file that removal left unreferenced — so `apt/`
 * structurally holds exactly the newest release. `yum/` never had an
 * equivalent: every `.rpm` ever published stayed in the tree (44 of them,
 * ~3.2 GB, against the ~1 GB GitHub Pages budget, growing ~76 MB per release),
 * and past the limit `yum install nimbus-headless` degrades toward not working
 * at all.
 *
 * This is that same retention concept, made explicit as a number instead of
 * being implicit in reprepro's behaviour: keep the newest N, delete the rest,
 * then regenerate the metadata from what is left. N is >1 where apt is
 * effectively 1 because RPM has no separate pool and `dnf downgrade
 * nimbus-headless` is a real recovery path — at ~76 MB per release, 3 costs
 * ~230 MB and stays well inside the budget.
 *
 * Override per run with `--retain <n>` or `NIMBUS_LINUX_REPO_RETAIN`.
 */
export const DEFAULT_RETAINED_RELEASES = 3;

/** Mirror of {@link rpmAssetName}: `nimbus-headless-<version>-x86_64.rpm`. */
const RPM_ASSET_PATTERN = /^nimbus-headless-(.+)-x86_64\.rpm$/;

/**
 * `Bun.semver.order` throws on an unparseable version. A yum tree is external
 * state (anyone can commit a file into the Pages repo), so an unreadable name
 * must degrade to "not one of ours" — never to a deletion candidate.
 * Same never-throw treatment as `compareSemver` in
 * `scripts/structure-audit/_release-train-core.ts`.
 */
function orderVersions(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b);
  } catch {
    return 0;
  }
}

/**
 * The release version encoded in a yum-tree filename, or `null` when the entry
 * is not a recognisable `nimbus-headless` RPM (a directory such as `repodata/`,
 * a detached `.asc`, a hand-added file, or a name whose version is not semver).
 * `null` means "leave it alone" everywhere below.
 */
export function rpmVersionOf(filename: string): string | null {
  const version = RPM_ASSET_PATTERN.exec(filename)?.[1];
  if (version === undefined) return null;
  try {
    Bun.semver.order(version, version);
  } catch {
    return null;
  }
  return version;
}

export interface YumRetentionInput {
  /** Directory listing of the yum tree (`readdirSync(repo/yum)`). */
  entries: readonly string[];
  /** The version being published right now; never a deletion candidate. */
  currentVersion: string;
  /**
   * Releases to keep; defaults to {@link DEFAULT_RETAINED_RELEASES}. Spelled
   * `| undefined` because `exactOptionalPropertyTypes` is on and callers pass a
   * possibly-unset CLI flag straight through.
   */
  retain?: number | undefined;
}

export interface YumRetentionPlan {
  /**
   * RPMs that stay, newest first: the newest {@link YumRetentionPlan.retain}
   * releases, plus the release being published when it is not already among
   * them — so this can hold `retain + 1` entries on a re-publish of an old tag.
   */
  keep: string[];
  /** RPMs to delete, newest first. Disjoint from {@link YumRetentionPlan.keep}. */
  remove: string[];
  /** The effective retention count after clamping. */
  retain: number;
}

function normalizeRetain(retain: number | undefined): number {
  if (retain === undefined || !Number.isFinite(retain)) return DEFAULT_RETAINED_RELEASES;
  // Never below 1: a 0/negative retention would delete the release we are
  // publishing this very run and leave the channel with no package at all.
  return Math.max(1, Math.floor(retain));
}

/**
 * Decide which RPMs the yum tree keeps — pure, so "which files survive" is
 * verifiable without running the workflow.
 *
 * Rules, all of them fail-safe (the failure direction of a wrong answer is a
 * slightly larger repo, never a broken channel):
 * - only entries matching {@link RPM_ASSET_PATTERN} with a semver version are
 *   ever candidates; anything else is untouched and absent from both lists;
 * - the newest `retain` releases are kept;
 * - the version being published is kept as well, even when older tags sort
 *   above it (a re-publish of an older tag must not delete the RPM just
 *   staged).
 *
 * The last two are a UNION, not a priority order, and that is the whole point:
 * seeding the keep-set with the current release first and then filling up to
 * `retain` made the current release CROWD OUT the newest ones, so a
 * `workflow_dispatch` re-publish of an old tag at a low retain deleted every
 * newer RPM in the channel (entries 1.0.0/2.0.0/2.1.0/2.2.0 at
 * `currentVersion=1.0.0, retain=1` kept 1.0.0 alone). Keeping the union means
 * `retain` is the floor on how many newest releases survive and the plan can
 * hold at most one extra entry (the republished tag) — a slightly larger repo,
 * which is the safe direction.
 */
export function planYumRetention(input: YumRetentionInput): YumRetentionPlan {
  const retain = normalizeRetain(input.retain);
  const currentRpm = rpmAssetName(input.currentVersion);

  const candidates = [...new Set(input.entries)]
    .map((file) => ({ file, version: rpmVersionOf(file) }))
    .filter((c): c is { file: string; version: string } => c.version !== null)
    // Newest first; filename as the tie-break keeps the plan deterministic.
    .sort((a, b) => orderVersions(b.version, a.version) || a.file.localeCompare(b.file));

  const keep = new Set<string>();
  for (const { file } of candidates) {
    if (keep.size >= retain) break;
    keep.add(file);
  }
  // Added AFTER the newest-N pass, never before it: the release being published
  // joins the keep-set, it never takes a slot away from a newer release.
  if (candidates.some((c) => c.file === currentRpm)) keep.add(currentRpm);

  return {
    keep: candidates.filter((c) => keep.has(c.file)).map((c) => c.file),
    remove: candidates.filter((c) => !keep.has(c.file)).map((c) => c.file),
    retain,
  };
}

/**
 * Apply {@link planYumRetention} to a real yum tree.
 *
 * ORDERING CONTRACT — this deletes RPMs and does NOT touch `repodata/`. The
 * caller (`.github/workflows/publish-linux-repo.yml`) must run `createrepo_c`
 * AFTER this returns, so the metadata is generated from the post-prune
 * directory. That is what makes it impossible to publish repodata referencing a
 * deleted RPM: nothing deletes anything after the metadata is built.
 */
function runYumPrune(dir: string, version: string, retain: number | undefined): void {
  const plan = planYumRetention({ entries: readdirSync(dir), currentVersion: version, retain });
  for (const file of plan.remove) {
    rmSync(join(dir, file), { force: true });
    console.log(`pruned ${file}`);
  }
  console.log(
    `linux-repo prune: retain=${plan.retain} kept=${plan.keep.length} removed=${plan.remove.length} (regenerate repodata now)`,
  );
}

/** A stable release tag: the shape the publish job's own `if` accepts, `v` and no `-`. */
const STABLE_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;

/** The stable versions among release tags, newest first. Any other tag is ignored. */
export function stableVersionsNewestFirst(tags: readonly string[]): string[] {
  return tags
    .map((tag) => STABLE_TAG_PATTERN.exec(tag)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort((a, b) => orderVersions(b, a));
}

export interface StageRetainedRpmsInput {
  /** Release tags, in any order. */
  tags: readonly string[];
  /** The version being published, whose RPM the caller has already staged. */
  currentVersion: string;
  retain?: number | undefined;
  /** Puts one release's verified RPM in the yum tree. False means that release has no RPM. */
  fetchRpm: (version: string) => boolean;
}

/**
 * Fill a yum tree that starts empty with the newest RPMs retention would keep. The Git deploy
 * inherits them from the clone; a deploy that keeps no state has only the release assets.
 *
 * This only fetches. {@link planYumRetention} still decides what stays, so the two deploy modes
 * cannot disagree about it. Releases abandoned after their tag existed have no assets, so a
 * missing RPM takes no slot and the next release fills it.
 */
export function stageRetainedRpms(input: StageRetainedRpmsInput): void {
  const retain = normalizeRetain(input.retain);
  const current = stripV(input.currentVersion);
  let have = 0;
  for (const version of stableVersionsNewestFirst(input.tags)) {
    if (have >= retain) return;
    if (version === current || input.fetchRpm(version)) have += 1;
  }
}

export type GhRunner = (args: readonly string[]) => { status: number; stderr: string };

const runGh: GhRunner = (args) => {
  const proc = Bun.spawnSync(["gh", ...args], { stderr: "pipe", stdout: "ignore" });
  return { status: proc.exitCode, stderr: proc.stderr.toString() };
};

/**
 * Download one release's RPM into `yumDir`, verified against that release's SHA256SUMS.
 * False means the release has no RPM. Anything else that goes wrong throws: the alternative is a
 * channel that quietly loses the releases `dnf downgrade` relies on, or an unverified package.
 */
export function downloadVerifiedRpm(
  version: string,
  yumDir: string,
  gh: GhRunner = runGh,
  repo: string = process.env["GITHUB_REPOSITORY"] ?? "nimbus-agent/Nimbus",
): boolean {
  const rpm = rpmAssetName(version);
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-linux-repo-rpm-"));
  try {
    // prettier-ignore
    const { status, stderr } = gh([
      "release",
      "download",
      `v${stripV(version)}`,
      "--repo",
      repo,
      "--dir",
      tmp,
      "--pattern",
      rpm,
      "--pattern",
      "SHA256SUMS",
    ]);
    if (status !== 0) {
      if (stderr.includes("no assets to download") || stderr.includes("no assets match")) {
        return false;
      }
      throw new Error(`linux-repo-config: gh release download failed for ${version}: ${stderr}`);
    }
    if (!existsSync(join(tmp, rpm))) return false;
    const sumsPath = join(tmp, "SHA256SUMS");
    if (!existsSync(sumsPath)) {
      throw new Error(`linux-repo-config: ${version} has an RPM but no SHA256SUMS to verify it`);
    }
    const expected = assetSha256(readFileSync(sumsPath, "utf8"), rpm);
    const actual = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(tmp, rpm)))
      .digest("hex");
    if (actual !== expected) {
      throw new Error(`linux-repo-config: checksum mismatch for ${rpm}`);
    }
    copyFileSync(join(tmp, rpm), join(yumDir, rpm));
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function runYumStage(dir: string, version: string, retain: number | undefined): void {
  const repo = process.env["GITHUB_REPOSITORY"] ?? "nimbus-agent/Nimbus";
  const list = Bun.spawnSync(
    // Enough to step over abandoned releases, which publish no assets.
    // prettier-ignore
    [
      "gh",
      "release",
      "list",
      "--repo",
      repo,
      "--limit",
      "40",
      "--exclude-drafts",
      "--exclude-pre-releases",
      "--json",
      "tagName",
      "--jq",
      ".[].tagName",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  if (list.exitCode !== 0) {
    throw new Error(`linux-repo-config: gh release list failed: ${list.stderr.toString()}`);
  }
  stageRetainedRpms({
    tags: list.stdout.toString().split(/\r?\n/).filter(Boolean),
    currentVersion: version,
    retain,
    fetchRpm: (v) => {
      const found = downloadVerifiedRpm(v, dir);
      console.log(found ? `staged ${rpmAssetName(v)}` : `v${v} has no RPM, skipped`);
      return found;
    },
  });
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/**
 * The retention override, or `undefined` for "not configured".
 *
 * Absent/blank is the only silent fall-back: an unset `vars.*` repo variable
 * arrives as `""` (and a whitespace-only value is the same accident), which
 * must mean the default rather than parse to `NaN`. Anything else that is not
 * an integer literal — `five`, `3.5`, `1,000` — is a MISCONFIGURED override and
 * throws. Swallowing it would silently prune to
 * {@link DEFAULT_RETAINED_RELEASES} while the operator believes the repo
 * variable they set is in force, and the only evidence would be the deleted
 * RPMs. Out-of-range integers still clamp in {@link normalizeRetain}; this
 * guard is about values that are not numbers at all.
 */
function parseRetainArg(): number | undefined {
  const raw = parseArg("--retain") ?? process.env["NIMBUS_LINUX_REPO_RETAIN"];
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(
      `linux-repo-config: retention override must be an integer, got ${JSON.stringify(raw)} (--retain / NIMBUS_LINUX_REPO_RETAIN)`,
    );
  }
  return Number(trimmed);
}

/** Default mode: render the apt/yum config files + echo the verified checksums. */
function runConfigGeneration(version: string | undefined): void {
  const sha256SumsPath = parseArg("--sha256sums");
  const baseUrl = parseArg("--base-url") ?? "https://nimbus-agent.github.io/linux-repo";
  const distributionsPath = parseArg("--distributions-out");
  const repoFilePath = parseArg("--repo-file-out");
  if (!version || !sha256SumsPath) {
    console.error(
      "Usage: bun scripts/release/linux-repo-config.ts --version <v> --sha256sums <path> [--base-url <url>] [--distributions-out <path>] [--repo-file-out <path>]",
    );
    process.exit(1);
  }
  const sums = readFileSync(sha256SumsPath, "utf8");
  const deb = debAssetName(version);
  const rpm = rpmAssetName(version);
  const debSha = assetSha256(sums, deb);
  const rpmSha = assetSha256(sums, rpm);

  if (distributionsPath) {
    mkdirSync(dirname(distributionsPath), { recursive: true });
    writeFileSync(distributionsPath, renderRepreproDistributions(), "utf8");
  }
  if (repoFilePath) {
    mkdirSync(dirname(repoFilePath), { recursive: true });
    writeFileSync(repoFilePath, renderYumRepoFile({ baseUrl }), "utf8");
  }

  const lines = [`deb=${deb}`, `deb_sha256=${debSha}`, `rpm=${rpm}`, `rpm_sha256=${rpmSha}`];
  for (const line of lines) console.log(line);
  const ghOut = process.env["GITHUB_OUTPUT"];
  if (ghOut) appendFileSync(ghOut, `${lines.join("\n")}\n`);
}

if (import.meta.main) {
  const version = parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"];
  const pruneDir = parseArg("--prune-yum");
  const stageDir = parseArg("--stage-yum-rpms");
  if (pruneDir || stageDir) {
    if (!version) {
      console.error(
        "Usage: bun scripts/release/linux-repo-config.ts (--prune-yum | --stage-yum-rpms) <dir> --version <v> [--retain <n>]",
      );
      process.exit(1);
    }
    try {
      // Fail the publish rather than prune or stage with a retention nobody chose.
      const retain = parseRetainArg();
      if (stageDir) runYumStage(stageDir, version, retain);
      if (pruneDir) runYumPrune(pruneDir, version, retain);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    runConfigGeneration(version);
  }
}
