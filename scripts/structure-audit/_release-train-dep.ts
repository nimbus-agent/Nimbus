/**
 * P2 Phase 2 — dependency-DAG readers. Pure functions only: every one takes
 * already-fetched text and returns a value, so the whole edge model is testable
 * without network. The impure fetch/gh callers live in check-release-staleness.ts.
 * See docs/infrastructure-roadmap.md § P2 (Phase 2 progress log).
 */

import { isRecord } from "./_gh-audit.ts";
import {
  compareSemver,
  type EdgeResult,
  type PublishedRelease,
  type ReleaseInfo,
} from "./_release-train-core.ts";

export interface NpmLatest {
  version: string;
  publishedAt: string;
}

/**
 * How a repo's release LIST read turned out, independent of what the tag pattern
 * then matched in it.
 *
 * `absent` is a REAL FINDING — a 404 means the configured `repo` does not exist
 * (deleted, renamed, or a typo in `release-train.json`), and an edge pointed at a
 * repo that is not there can never go green on its own. `indeterminate` is the
 * transient bucket: rate limit, network, auth, unparseable body. Collapsing the
 * two would fail open on the misconfiguration exactly the way a bare `null` used
 * to — see `parseReleaseList` and `evaluatePublishEdge`.
 */
export type ReleaseListStatus = "read" | "absent" | "indeterminate";

/** One raw GitHub release row -> `ReleaseInfo`, or null if any field is the wrong shape. */
function toReleaseInfo(raw: unknown): ReleaseInfo | null {
  if (!isRecord(raw)) return null;
  const tag = raw["tag_name"];
  const prerelease = raw["prerelease"];
  const draft = raw["draft"];
  const publishedAt = raw["published_at"];
  const assets = raw["assets"];
  if (typeof tag !== "string") return null;
  if (typeof prerelease !== "boolean" || typeof draft !== "boolean") return null;
  // A DRAFT carries `published_at: null` — legitimately, since it was never
  // published. Rejecting the row would let one draft invalidate the whole list;
  // "" is safe because every consumer filters drafts before reading the date.
  if (publishedAt !== null && typeof publishedAt !== "string") return null;
  if (!Array.isArray(assets)) return null;
  const names: string[] = [];
  for (const a of assets) {
    if (!isRecord(a) || typeof a["name"] !== "string") return null;
    names.push(a["name"]);
  }
  return { tag, prerelease, draft, assets: names, publishedAt: publishedAt ?? "" };
}

/**
 * Every release across every page, from `gh api --paginate --slurp` output — an
 * array of PAGES, each an array of raw release objects.
 *
 * Returns `null` if anything is malformed, and deliberately does so for a SINGLE
 * bad row rather than skipping it. A skipped row is indistinguishable from a repo
 * that genuinely has no matching release, and that outcome is now a hard failure
 * (`evaluatePublishEdge`) — so a lenient parser would let one unexpected payload
 * red the build with a wrong reason. Losing the check for a run is the cheaper
 * error than asserting a manifest bug that is not there.
 *
 * Reading EVERY page matters for the same reason: `nimbus-sdk` releases three
 * SDKs from one repo and sat at 97 releases when this was written, so a single
 * `per_page=100` page was three releases away from being able to miss the newest
 * `typescript-v*` behind a run of `python-v*` and `sdks/go/v*` tags.
 */
export function parseReleaseList(text: string): ReleaseInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ReleaseInfo[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) return null;
    for (const raw of page) {
      const rel = toReleaseInfo(raw);
      if (rel === null) return null;
      out.push(rel);
    }
  }
  return out;
}

/**
 * `dist-tags.latest` + its publish timestamp from a FULL npm registry document.
 * The `/<pkg>/latest` endpoint is not usable here: it omits `time`, and the
 * grace rule is measured from the version's own publish time.
 */
export function parseNpmLatest(doc: string): NpmLatest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const tags = parsed["dist-tags"];
  if (!isRecord(tags)) return null;
  const version = tags["latest"];
  if (typeof version !== "string") return null;
  const time = parsed["time"];
  if (!isRecord(time)) return null;
  const publishedAt = time[version];
  if (typeof publishedAt !== "string") return null;
  return { version, publishedAt };
}

/**
 * Highest stable release whose tag matches `pattern`, which MUST carry one
 * capture group holding the bare version. Upstream tags are component-prefixed
 * (`typescript-v1.32.0`, `client-v0.17.3`), which Phase 1's `selectPublished`
 * deliberately rejects — so dep edges need their own selector rather than
 * reusing it.
 *
 * The prefix is the RELEASING COMPONENT's name, not the npm package's: the
 * `@nimbus-dev/sdk` train releases out of the polyglot `nimbus-sdk` repo, whose
 * TypeScript tags read `typescript-v*` (its Go and Python SDKs tag their own).
 * `release-train.json` carried `^sdk-v(...)$` for that train from the start and
 * so never matched a real tag — and because an unmatched pattern yields
 * `indeterminate`, which `decideExit` downgrades to a warning, the sdk publish
 * edge reported no failure for as long as it was broken. Every fixture in this
 * module's tests supplies BOTH the pattern and the tags, so they agreed with
 * each other and never with the repo. Derive a pattern from `gh release list`,
 * not from the package name.
 */
export function selectTaggedRelease(
  releases: readonly ReleaseInfo[],
  pattern: string,
): PublishedRelease | null {
  const re = new RegExp(pattern);
  const eligible: PublishedRelease[] = [];
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const version = re.exec(r.tag)?.[1];
    if (version) eligible.push({ version, publishedAt: r.publishedAt });
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => compareSemver(b.version, a.version) ?? 0);
  return eligible[0] ?? null;
}

/**
 * Remove trailing commas so a real bun.lock (which is JSONC-ish and DOES carry
 * them) survives `JSON.parse`.
 *
 * This walks the text tracking string state rather than using a regex. The
 * obvious `text.replace(/,(\s*[}\]])/g, "$1")` is WRONG in a way that fails
 * silently: it also strips a comma inside a string value that happens to end
 * with `, }`, so `"note: a comma, }"` parses cleanly as `"note: a comma }"`.
 * A corrupted-but-parseable lockfile is precisely the class of defect this gate
 * exists to prevent, so the parser must not introduce one.
 */
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      const next = text[j];
      if (next === "}" || next === "]") continue; // trailing comma — drop it
    }
    out += ch;
  }
  return out;
}

/** Workspace package names declared by a parsed bun.lock (`workspaces[].name`). */
function workspaceNames(lock: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const ws = lock["workspaces"];
  if (!isRecord(ws)) return names;
  for (const entry of Object.values(ws)) {
    if (isRecord(entry) && typeof entry["name"] === "string") names.add(entry["name"]);
  }
  return names;
}

/**
 * The version of `pkg` a bun.lock actually resolves for the repo's OWN code.
 *
 * A bun.lock mentions a package in two places and only one is a version:
 *   workspaces[].dependencies["<pkg>"] = "^1.5.0"     <- a RANGE, never parse it
 *   packages["<path>"] = ["<pkg>@1.6.0", ...]         <- the resolution
 *
 * A resolution key is a dependency PATH: bare `<pkg>` is the hoisted copy, and
 * `<prefix>/<pkg>` is the copy `<prefix>` resolved. Only prefixes that are the
 * repo's own workspaces are this edge's business — a lower version nested under
 * a THIRD-PARTY package (e.g. `@nimbus-dev/client/@nimbus-dev/sdk`) is that
 * package's business, not ours, and counting it would report a version no local
 * code resolves. Returns the minimum of the qualifying entries, because the
 * oldest version our own code ships is the honest "caught up" signal.
 */
export function resolvedFromBunLock(text: string, pkg: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(text));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const packages = parsed["packages"];
  if (!isRecord(packages)) return null;

  const ours = workspaceNames(parsed);
  const found: string[] = [];
  const suffix = `/${pkg}`;

  for (const [key, value] of Object.entries(packages)) {
    if (key !== pkg && !key.endsWith(suffix)) continue;
    if (key !== pkg && !ours.has(key.slice(0, key.length - suffix.length))) continue;
    if (!Array.isArray(value)) continue;
    const spec = value[0];
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0 || spec.slice(0, at) !== pkg) continue;
    found.push(spec.slice(at + 1));
  }
  if (found.length === 0) return null;
  found.sort((a, b) => compareSemver(a, b) ?? 0);
  return found[0] ?? null;
}

export interface PrRef {
  title: string;
  headRefName: string;
}

/**
 * Is one of these open PRs an in-flight bump of `pkg`? Matched in memory over
 * title + branch rather than through `gh --search`, so the gate does not depend
 * on an opaque relevance ranker and every naming variant is testable offline.
 * Both the full name (`@nimbus-dev/sdk`) and the short name (`sdk`) count —
 * Dependabot, Renovate and humans all title these differently.
 */
export function matchesBumpPr(prs: readonly PrRef[], pkg: string): boolean {
  const full = pkg.toLowerCase();
  const short = (pkg.split("/").pop() ?? pkg).toLowerCase();
  return prs.some((pr) => {
    const hay = `${pr.title} ${pr.headRefName}`.toLowerCase();
    return hay.includes(full) || hay.includes(short);
  });
}

export interface ConsumerReading {
  repo: string;
  /**
   * `read` — lockfile fetched and parsed, `resolved` is set.
   * `absent` — the lockfile itself is missing (404): a real finding.
   * `not-a-dependency` — lockfile parsed fine but has no entry: a MANIFEST bug.
   * `indeterminate` — the read failed transiently.
   */
  status: "read" | "absent" | "indeterminate" | "not-a-dependency";
  resolved: string | null;
  /** `null` = could not determine (read failed, or the PR list may be truncated). */
  bumpPrOpen: boolean | null;
}

export interface PackageEvalInput {
  name: string;
  npm: string;
  taggedRelease: PublishedRelease | null;
  taggedReleaseAgeHours: number | null;
  /**
   * How the upstream repo's release LIST read went, independent of whether
   * `tagPattern` then matched anything in it.
   *
   * All three outcomes collapse into `taggedRelease === null` otherwise, and
   * they are not the same finding. A readable list that nothing matched is a
   * manifest bug — that is what let the sdk train ship `^sdk-v(...)$` against a
   * repo tagging `typescript-v*` while the edge reported a mere warning for as
   * long as it was broken. A 404 is a DIFFERENT manifest bug: the configured
   * `repo` does not exist. Only a transient failure deserves a warning.
   *
   * `null` for a caller that cannot distinguish them; that keeps the old
   * warning-only behaviour rather than manufacturing a failure.
   */
  taggedReleaseListStatus: ReleaseListStatus | null;
  latest: NpmLatest | null;
  latestAgeHours: number | null;
  consumers: ConsumerReading[];
  graceHours: number;
}

/** Short repo name for edge labels: `nimbus-agent/nimbus-vscode` -> `nimbus-vscode`. */
function shortRepo(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

/** The publish edge: a tagged release must reach npm. */
function evaluatePublishEdge(i: PackageEvalInput): EdgeResult {
  const edge = `${i.name}:publish`;
  if (i.taggedRelease === null) {
    // Two of the three outcomes are manifest bugs and must FAIL, not warn — a
    // config error never fixes itself, so a warning here is a permanent silence.
    // Only a transient read failure is worth a warning. See `taggedReleaseListStatus`.
    if (i.taggedReleaseListStatus === "absent") {
      return {
        edge,
        verdict: "stale",
        detail: `manifest error: the repo configured for ${i.npm} returned 404 — it is deleted, renamed, or misspelled in release-train.json, so this edge can never go green`,
      };
    }
    if (i.taggedReleaseListStatus === "read") {
      return {
        edge,
        verdict: "stale",
        detail: `manifest error: no release in the upstream repo matches this train's tagPattern for ${i.npm} — the pattern names a component that does not tag under that prefix, so this edge has never been evaluated. Derive it from \`gh release list\`, not from the package name`,
      };
    }
    return {
      edge,
      verdict: "indeterminate",
      detail: `no release tag matched for ${i.npm} — releases unreadable`,
    };
  }
  if (i.latest === null) {
    return { edge, verdict: "indeterminate", detail: `npm registry unreadable for ${i.npm}` };
  }
  const order = compareSemver(i.taggedRelease.version, i.latest.version);
  if (order === null) {
    return {
      edge,
      verdict: "indeterminate",
      detail: `cannot compare tag ${i.taggedRelease.version} to npm ${i.latest.version}`,
    };
  }
  if (order <= 0) {
    return {
      edge,
      verdict: "ok",
      detail: `${i.npm} tag ${i.taggedRelease.version} published as ${i.latest.version}`,
    };
  }
  const age = i.taggedReleaseAgeHours ?? Number.POSITIVE_INFINITY;
  if (age > i.graceHours) {
    return {
      edge,
      verdict: "phantom",
      detail: `${i.npm} ${i.taggedRelease.version} is tagged but npm still serves ${i.latest.version}; release is ${Math.round(age)}h old (> ${i.graceHours}h grace)`,
    };
  }
  return {
    edge,
    verdict: "ok",
    detail: `${i.npm} ${i.taggedRelease.version} tagged within ${i.graceHours}h grace (npm: ${i.latest.version})`,
  };
}

/** One consumer edge: has this repo's lockfile caught up to npm @latest? */
function evaluateConsumerEdge(
  c: ConsumerReading,
  edge: string,
  npm: string,
  latest: NpmLatest,
  pastGrace: boolean,
  graceHours: number,
): EdgeResult {
  if (c.status === "indeterminate") {
    return { edge, verdict: "indeterminate", detail: `lockfile read failed transiently` };
  }
  if (c.status === "not-a-dependency") {
    return {
      edge,
      verdict: "indeterminate",
      detail: `manifest error: ${c.repo} does not depend on ${npm} — remove this consumer from release-train.json`,
    };
  }
  if (c.status === "absent") {
    return { edge, verdict: "stale", detail: `lockfile absent in ${c.repo}` };
  }
  if (c.resolved === null) {
    return { edge, verdict: "indeterminate", detail: `no resolved version for ${npm}` };
  }
  const order = compareSemver(c.resolved, latest.version);
  if (order === null) {
    return {
      edge,
      verdict: "indeterminate",
      detail: `resolved ${c.resolved} not comparable to npm ${latest.version}`,
    };
  }
  if (order >= 0) {
    return { edge, verdict: "ok", detail: `${c.resolved} >= npm ${latest.version}` };
  }
  if (!pastGrace) {
    return { edge, verdict: "ok", detail: `npm ${latest.version} within ${graceHours}h grace` };
  }
  if (c.bumpPrOpen === true) {
    return {
      edge,
      verdict: "ok",
      detail: `${c.resolved} < ${latest.version} but a bump PR is open`,
    };
  }
  if (c.bumpPrOpen === null) {
    // We know it is behind, but not whether a bump is already in flight. Report
    // unknown rather than staleness — an unread PR list must not manufacture a
    // finding.
    return {
      edge,
      verdict: "indeterminate",
      detail: `${c.resolved} < npm ${latest.version}, but the open-PR list could not be read conclusively`,
    };
  }
  return {
    edge,
    verdict: "stale",
    detail: `${c.resolved} < npm ${latest.version} and no bump PR open`,
  };
}

export function evaluatePackage(i: PackageEvalInput): EdgeResult[] {
  const results: EdgeResult[] = [evaluatePublishEdge(i)];
  const pastGrace = (i.latestAgeHours ?? Number.POSITIVE_INFINITY) > i.graceHours;
  for (const c of i.consumers) {
    const edge = `${i.name}:${shortRepo(c.repo)}`;
    results.push(
      i.latest === null
        ? { edge, verdict: "indeterminate", detail: `npm registry unreadable for ${i.npm}` }
        : evaluateConsumerEdge(c, edge, i.npm, i.latest, pastGrace, i.graceHours),
    );
  }
  return results;
}
