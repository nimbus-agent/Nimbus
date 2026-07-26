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

export function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/**
 * Semver ordering that never throws. `Bun.semver.order` throws on an unparseable
 * version ("Invalid SemVer: ..."), and channel files are external — a format
 * quirk must degrade to "indeterminate", not crash the whole audit. Returns
 * -1 | 0 | 1, or null when either side is not valid semver.
 */
export function compareSemver(a: string, b: string): number | null {
  try {
    return Bun.semver.order(stripV(a), stripV(b));
  } catch {
    return null;
  }
}

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

export interface ReleaseInfo {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  assets: string[];
  publishedAt: string;
}
export interface PublishedRelease {
  version: string;
  publishedAt: string;
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

export type EdgeVerdict = "ok" | "stale" | "phantom" | "indeterminate";
export interface EdgeResult {
  edge: string;
  verdict: EdgeVerdict;
  detail: string;
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

/**
 * Exit decision. Any stale/phantom edge => red. Otherwise green with a warning
 * per indeterminate edge — EXCEPT a run where nothing was evaluable (no ok, only
 * indeterminate) under --strict is red: "indeterminate" must not read as "all
 * clear" in the scheduled sweep (the team-reachability rule).
 */
export function decideExit(
  results: EdgeResult[],
  strict: boolean,
): { code: 0 | 1; messages: string[] } {
  const messages: string[] = [];
  const hard = results.filter((r) => r.verdict === "phantom" || r.verdict === "stale");
  const indet = results.filter((r) => r.verdict === "indeterminate");
  const ok = results.filter((r) => r.verdict === "ok");
  for (const r of hard) messages.push(`::error::${r.edge}: ${r.detail}`);
  for (const r of indet) messages.push(`::warning::${r.edge}: ${r.detail} (indeterminate)`);
  if (hard.length > 0) return { code: 1, messages };
  if (ok.length === 0 && indet.length > 0 && strict) {
    messages.push(
      "::error::release-staleness: indeterminate — nothing could be evaluated (all reads failed transiently)",
    );
    return { code: 1, messages };
  }
  return { code: 0, messages };
}
