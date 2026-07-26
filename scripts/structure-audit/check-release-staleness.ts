#!/usr/bin/env bun

/**
 * audit:release-staleness — the P2 Release Train gate. Reads three version
 * "heads" for each train in .github/release-train.json (intended = release-please
 * manifest, published = latest GitHub Release with its SHA256SUMS asset,
 * distributed = each channel's live version) and fails when a channel lags the
 * published release past graceHours, or when a release phantoms. All reads are
 * public gh calls; fail-soft locally, strict in CI. See
 * docs/superpowers/specs/2026-07-24-p2-release-train-design.md.
 */

import { classifyReadFailure, isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";
import {
  ageHours,
  compareSemver,
  decideExit,
  type EdgeResult,
  type PublishedRelease,
  type ReleaseInfo,
  stripV,
} from "./_release-train-core.ts";

// The primitives live in the leaf core module (so the Phase 2 dependency readers
// can share them without an import cycle), but they are re-exported here so this
// module path stays the single entry point for the gate's callers and tests.
export {
  ageHours,
  compareSemver,
  decideExit,
  type EdgeResult,
  type EdgeVerdict,
  type PublishedRelease,
  type ReleaseInfo,
  stripV,
} from "./_release-train-core.ts";

/** `version "X.Y.Z"` from a Homebrew Formula .rb. */
export function parseBrewVersion(rb: string): string | null {
  return rb.match(/version\s+"([^"]+)"/)?.[1] ?? null;
}

/** `.version` from a Scoop JSON manifest. */
export function parseScoopVersion(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const v = (parsed as { version: unknown }).version;
      return typeof v === "string" ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The upstream version of `pkgName` from an apt Packages index. The index lists
 * every package as a double-newline-separated block, so we scope to the block
 * whose `Package:` field equals `pkgName` (a future second package must not be
 * read by position). The Debian `Version:` field may carry an epoch (`N:`) and a
 * revision (`-N`); both are stripped to the core upstream version so it compares
 * as semver.
 */
export function parseLinuxVersion(packages: string, pkgName = "nimbus-headless"): string | null {
  for (const block of packages.split(/\n\n+/)) {
    if (block.match(new RegExp(`^Package:\\s*${pkgName}\\s*$`, "m"))) {
      const raw = block.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
      if (!raw) return null;
      // strip epoch "N:" prefix and "-revision" suffix -> core upstream version
      return raw.replace(/^\d+:/, "").replace(/-.*$/, "");
    }
  }
  return null;
}

/**
 * Highest stable `vX.Y.Z` release whose `asset` is attached. Skips drafts,
 * prereleases, non-`vX.Y.Z` tags (e.g. component tags), and asset-less phantom
 * releases. Returns null when nothing qualifies.
 */
export function selectPublished(releases: ReleaseInfo[], asset: string): PublishedRelease | null {
  const stable = /^v\d+\.\d+\.\d+$/;
  const eligible = releases.filter(
    (r) => !r.draft && !r.prerelease && stable.test(r.tag) && r.assets.includes(asset),
  );
  if (eligible.length === 0) return null;
  // Tags are pre-filtered to `vX.Y.Z`, so compareSemver never returns null here;
  // `?? 0` keeps the comparator total-typed for the sort.
  eligible.sort((a, b) => compareSemver(b.tag, a.tag) ?? 0);
  const top = eligible[0];
  return top ? { version: stripV(top.tag), publishedAt: top.publishedAt } : null;
}

/**
 * winget-pkgs manifests path. Every dot-segment of the package id becomes its
 * own directory: `NimbusAgent.Nimbus` -> `manifests/n/NimbusAgent/Nimbus/<ver>`,
 * `Acme.Tools.Cli` -> `manifests/a/Acme/Tools/Cli/<ver>`. The first segment's
 * lowercased first letter is the top bucket.
 */
export function wingetDirPath(packageId: string, version: string): string {
  const segments = packageId.split(".");
  const letter = (segments[0] ?? "").charAt(0).toLowerCase();
  return `manifests/${letter}/${segments.join("/")}/${version}`;
}

/**
 * winget is "caught up" if the version dir is merged OR an open PR exists.
 * `dir`/`pr` are true (known present), false (known absent), or null (the read
 * failed transiently). Covered if either is true; genuinely not covered only
 * when both are known-false; otherwise indeterminate.
 */
export function resolveWingetCoverage(
  dir: boolean | null,
  pr: boolean | null,
): { status: "read" | "indeterminate"; covered: boolean } {
  if (dir === true || pr === true) return { status: "read", covered: true };
  if (dir === false && pr === false) return { status: "read", covered: false };
  return { status: "indeterminate", covered: false };
}

export interface ChannelReading {
  kind: string;
  status: "read" | "absent" | "indeterminate";
  /** version-file channels (brew/scoop/linux); null for winget or unread. */
  version: string | null;
  /** winget only: is the published version covered; null otherwise. */
  covered: boolean | null;
}
export interface TrainEvalInput {
  name: string;
  intended: string;
  intendedBumpAgeHours: number;
  published: PublishedRelease | null;
  publishedAgeHours: number | null;
  channels: ChannelReading[];
  graceHours: number;
}

/**
 * The phantom edge: the release-please manifest says vN, so a built Release
 * carrying assets must exist for vN. "Manifest ahead of published" is legitimate
 * only inside the build window, hence the grace check on the bump's own age.
 */
function evaluatePhantomEdge(i: TrainEvalInput, pubVer: string | null): EdgeResult {
  const edge = `${i.name}:phantom`;
  const order = pubVer === null ? null : compareSemver(i.intended, pubVer);
  if (pubVer !== null && order === null) {
    // The manifest version itself is unparseable — cannot judge; do not crash.
    return {
      edge,
      verdict: "indeterminate",
      detail: `manifest version ${i.intended} is not valid semver`,
    };
  }
  const intendedAhead = pubVer === null || (order ?? 0) > 0;
  if (!intendedAhead) {
    return { edge, verdict: "ok", detail: `manifest ${i.intended} matches published ${pubVer}` };
  }
  if (i.intendedBumpAgeHours > i.graceHours) {
    return {
      edge,
      verdict: "phantom",
      detail: `manifest ${i.intended} has no built Release with assets (latest published: ${i.published?.version ?? "none"}); bump is ${Math.round(i.intendedBumpAgeHours)}h old (> ${i.graceHours}h grace)`,
    };
  }
  return {
    edge,
    verdict: "ok",
    detail: `manifest ${i.intended} ahead of published ${i.published?.version ?? "none"} but within ${i.graceHours}h grace`,
  };
}

/** One channel edge: has this distribution channel caught up to `pubVer` yet? */
function evaluateChannelEdge(ch: ChannelReading, edge: string, pubVer: string): EdgeResult {
  if (ch.status === "indeterminate") {
    return { edge, verdict: "indeterminate", detail: "channel read failed transiently" };
  }
  if (ch.status === "absent") {
    return { edge, verdict: "stale", detail: "channel file/dir absent" };
  }
  if (ch.kind === "winget") {
    return ch.covered
      ? { edge, verdict: "ok", detail: `winget covers ${pubVer} (merged dir or open PR)` }
      : { edge, verdict: "stale", detail: `no winget dir and no open PR for ${pubVer}` };
  }
  const chVer = ch.version ? stripV(ch.version) : null;
  if (chVer === null) {
    return { edge, verdict: "indeterminate", detail: "channel version missing" };
  }
  const ord = compareSemver(chVer, pubVer);
  if (ord === null) {
    return {
      edge,
      verdict: "indeterminate",
      detail: `channel version ${chVer} not comparable to ${pubVer}`,
    };
  }
  return ord >= 0
    ? { edge, verdict: "ok", detail: `${ch.kind} ${chVer} >= published ${pubVer}` }
    : { edge, verdict: "stale", detail: `${ch.kind} ${chVer} < published ${pubVer}` };
}

export function evaluateTrain(i: TrainEvalInput): EdgeResult[] {
  const pubVer = i.published ? stripV(i.published.version) : null;
  const results: EdgeResult[] = [evaluatePhantomEdge(i, pubVer)];

  // Channel edges are only meaningful once something is actually published.
  if (pubVer === null) return results;
  const pastGrace = i.publishedAgeHours !== null && i.publishedAgeHours > i.graceHours;

  for (const ch of i.channels) {
    const edge = `${i.name}:${ch.kind}`;
    results.push(
      pastGrace
        ? evaluateChannelEdge(ch, edge, pubVer)
        : { edge, verdict: "ok", detail: `within ${i.graceHours}h grace` },
    );
  }
  return results;
}

export interface ChannelSpec {
  kind: "brew" | "scoop" | "linux" | "winget";
  repo?: string;
  path?: string;
  package?: string;
  wingetRepo?: string;
}
export interface TrainSpec {
  name: string;
  source: {
    manifestRepo: string;
    manifestFile: string;
    manifestKey: string;
    releaseAsset: string;
  };
  channels: ChannelSpec[];
}
export interface TrainManifest {
  graceHours: number;
  trains: TrainSpec[];
}

export function loadTrainManifest(json: string): TrainManifest {
  const parsed: unknown = JSON.parse(json);
  if (
    !isRecord(parsed) ||
    typeof parsed["graceHours"] !== "number" ||
    !Array.isArray(parsed["trains"])
  ) {
    throw new Error("release-train.json: expected { graceHours: number, trains: [...] }");
  }
  return parsed as unknown as TrainManifest;
}

/** Decode a GitHub contents API base64 `.content` envelope to UTF-8 text. */
function decodeContents(base64Envelope: string): string {
  return Buffer.from(base64Envelope.replace(/\s/g, ""), "base64").toString("utf8");
}

/** Fallback: some apt repos serve only Packages.gz — decode it in-memory. */
function tryLinuxGz(ch: ChannelSpec): ChannelReading | null {
  const gz = runGh(["gh", "api", `repos/${ch.repo}/contents/${ch.path}.gz`, "--jq", ".content"]);
  if (!gz.ok) return null;
  try {
    const bytes = Buffer.from(gz.stdout.replace(/\s/g, ""), "base64");
    const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
    return { kind: ch.kind, status: "read", version: parseLinuxVersion(text), covered: null };
  } catch {
    // corrupt / non-gzip payload — transient, not a staleness finding
    return { kind: ch.kind, status: "indeterminate", version: null, covered: null };
  }
}

/** winget coverage: is `publishedVersion` merged as a manifest dir, or PR-open? */
function readWingetChannel(ch: ChannelSpec, publishedVersion: string | null): ChannelReading {
  // Nothing published yet => nothing for winget to be behind.
  if (!publishedVersion) return { kind: "winget", status: "read", version: null, covered: true };
  const dirRes = runGh([
    "gh",
    "api",
    `repos/${ch.wingetRepo}/contents/${wingetDirPath(ch.package ?? "", publishedVersion)}`,
    "--jq",
    "length",
  ]);
  const dir = dirRes.ok ? true : classifyReadFailure(dirRes.httpStatus) === "absent" ? false : null;
  let pr: boolean | null = false;
  if (dir !== true) {
    const prRes = runGh([
      "gh",
      "pr",
      "list",
      "--repo",
      ch.wingetRepo ?? "",
      "--state",
      "open",
      "--search",
      `in:title ${ch.package} ${publishedVersion}`,
      "--json",
      "number",
      "--jq",
      "length",
    ]);
    pr = prRes.ok ? Number(prRes.stdout.trim()) > 0 : null;
  }
  const { status, covered } = resolveWingetCoverage(dir, pr);
  return { kind: "winget", status, version: null, covered };
}

/** Read one channel's live version (or winget coverage). Public reads only. */
function readChannel(ch: ChannelSpec, publishedVersion: string | null): ChannelReading {
  if (ch.kind === "winget") return readWingetChannel(ch, publishedVersion);

  const res = runGh(["gh", "api", `repos/${ch.repo}/contents/${ch.path}`, "--jq", ".content"]);
  if (!res.ok) {
    const linuxGz = ch.kind === "linux" ? tryLinuxGz(ch) : null;
    if (linuxGz !== null) return linuxGz;
    return {
      kind: ch.kind,
      status: classifyReadFailure(res.httpStatus),
      version: null,
      covered: null,
    };
  }
  const text = decodeContents(res.stdout);
  const version =
    ch.kind === "brew"
      ? parseBrewVersion(text)
      : ch.kind === "scoop"
        ? parseScoopVersion(text)
        : parseLinuxVersion(text);
  return { kind: ch.kind, status: "read", version, covered: null };
}

/** The intended head: the version release-please claims on main, + its bump age. */
function readIntended(train: TrainSpec): { intended: string; intendedBumpAgeHours: number } {
  const manRes = runGh([
    "gh",
    "api",
    `repos/${train.source.manifestRepo}/contents/${train.source.manifestFile}?ref=main`,
    "--jq",
    ".content",
  ]);
  const intendedJson = manRes.ok ? decodeContents(manRes.stdout) : "{}";
  const intendedParsed: unknown = JSON.parse(intendedJson);
  const intended =
    isRecord(intendedParsed) && typeof intendedParsed[train.source.manifestKey] === "string"
      ? (intendedParsed[train.source.manifestKey] as string)
      : "";

  const bumpRes = runGh([
    "gh",
    "api",
    `repos/${train.source.manifestRepo}/commits?path=${train.source.manifestFile}&per_page=1`,
    "--jq",
    ".[0].commit.committer.date",
  ]);
  const intendedBumpAgeHours =
    bumpRes.ok && bumpRes.stdout.trim()
      ? ageHours(bumpRes.stdout.trim())
      : Number.POSITIVE_INFINITY;
  return { intended, intendedBumpAgeHours };
}

/** The published head: the latest stable Release that actually carries assets. */
function readPublished(train: TrainSpec): PublishedRelease | null {
  const relRes = runGh([
    "gh",
    "api",
    `repos/${train.source.manifestRepo}/releases?per_page=100`,
    "--jq",
    "[.[] | {tag: .tag_name, prerelease: .prerelease, draft: .draft, publishedAt: .published_at, assets: [.assets[].name]}]",
  ]);
  if (!relRes.ok) return null;
  const rels: unknown = JSON.parse(relRes.stdout);
  if (!Array.isArray(rels)) return null;
  return selectPublished(rels as ReleaseInfo[], train.source.releaseAsset);
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const label = "audit:release-staleness";

  // Reachability probe (mirrors cla-coverage): one public read. If gh/network is
  // unavailable at all, soft-skip locally / red in strict.
  const probe = runGh(["gh", "api", "repos/nimbus-agent/Nimbus", "--jq", ".name"]);
  if (!probe.ok) {
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const manifest = loadTrainManifest(
    await Bun.file(new URL("../../.github/release-train.json", import.meta.url)).text(),
  );

  const allResults: EdgeResult[] = [];
  for (const train of manifest.trains) {
    const { intended, intendedBumpAgeHours } = readIntended(train);
    const published = readPublished(train);
    const publishedAgeHours = published ? ageHours(published.publishedAt) : null;
    const channels = train.channels.map((ch) => readChannel(ch, published?.version ?? null));

    allResults.push(
      ...evaluateTrain({
        name: train.name,
        intended,
        intendedBumpAgeHours,
        published,
        publishedAgeHours,
        channels,
        graceHours: manifest.graceHours,
      }),
    );
  }

  const out = decideExit(allResults, strict);
  for (const m of out.messages) (m.startsWith("::error::") ? console.error : console.warn)(m);
  if (out.code === 0) {
    const current = allResults.filter((r) => r.verdict === "ok").length;
    console.log(`${label}: OK (${current} edges current)`);
  }
  process.exit(out.code);
}
