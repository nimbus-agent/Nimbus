/**
 * P2 Phase 2 — dependency-DAG readers. Pure functions only: every one takes
 * already-fetched text and returns a value, so the whole edge model is testable
 * without network. The impure fetch/gh callers live in check-release-staleness.ts.
 * See docs/superpowers/specs/2026-07-26-p2-phase2-dep-dag-design.md.
 */

import { isRecord } from "./_gh-audit.ts";
import { compareSemver, type PublishedRelease, type ReleaseInfo } from "./_release-train-core.ts";

export interface NpmLatest {
  version: string;
  publishedAt: string;
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
 * (`sdk-v1.6.0`), which Phase 1's `selectPublished` deliberately rejects — so
 * dep edges need their own selector rather than reusing it.
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
