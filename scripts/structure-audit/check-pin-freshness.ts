#!/usr/bin/env bun

/**
 * audit:pin-freshness — a SHA-pinned action must be pinned to something CURRENT.
 *
 * `audit:action-sha-pins` proves every `uses:` is a 40-hex SHA rather than a
 * moving tag. It is structurally unable to notice that the SHA is two years
 * old: to that gate an ancient pin and a fresh pin are identical. P1's first
 * sweep recorded exactly this — `harden-runner` v2.20.0 vs v2.19.4,
 * `actions/checkout` v7.0.1 vs v7.0.0 — and classified it as staleness rather
 * than unpinning, deferring a freshness check as "Plan B". This is that check.
 *
 * The two gates are complementary and deliberately separate: pinning is a
 * SECURITY property (a moving tag is a supply-chain hole) and is checkable
 * offline, so it stays in the local fast tier. Freshness is a MAINTENANCE
 * property needing network, so it runs in the scheduled sweep.
 *
 * See docs/superpowers/specs/2026-07-26-p5-p3-infra-batch-design.md.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { classifyReadFailure, isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

/**
 * How stale a pin may be before it is a finding.
 *
 * 30 days, not the release-train's 6 hours, because these are different failure
 * classes. A release-train edge is an automated pipeline that should propagate
 * in minutes, so hours of lag is a defect. An action pin moves when a human or
 * Dependabot updates it; a 6-hour window would mean a permanently red sweep,
 * and a gate that is always red is one everybody learns to ignore. Thirty days
 * says "this pin sat through a full release cycle and nobody noticed", which is
 * the condition actually worth alerting on.
 */
export const DEFAULT_GRACE_DAYS = 30;

/**
 * Actions whose pin deliberately tracks a named REF rather than a release.
 *
 * "Latest release" is the right yardstick for most actions and the wrong one
 * for some. `dtolnay/rust-toolchain` is pinned here against its `stable`
 * branch (the trailing `# stable` comment says so), and its newest *release*,
 * `v1`, currently sits **12 commits behind** that branch — so measuring the pin
 * against `v1` would report a correctly-updated pin as stale, and "fixing" it
 * would move the pin backwards in code age to satisfy the gate.
 *
 * A gate that can only be satisfied by making the repo worse is a broken gate,
 * so these are compared against the ref they actually track. Keep the map tiny:
 * an entry here is a claim about intent, and the trailing comment in the
 * workflow must agree with it.
 */
export const TRACKED_REF_OVERRIDES: Readonly<Record<string, string>> = {
  "dtolnay/rust-toolchain": "heads/stable",
};

export interface PinnedAction {
  ownerRepo: string;
  sha: string;
  file: string;
}

export interface LatestRelease {
  tag: string;
  publishedAt: string;
}

export type PinVerdict = "ok" | "stale" | "indeterminate";

export interface PinResult {
  ownerRepo: string;
  verdict: PinVerdict;
  detail: string;
}

export interface WorkflowFile {
  path: string;
  text: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** ISO-8601 carrying an explicit UTC designator or numeric offset. */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Days between an ISO-8601 timestamp and now, UTC epoch-ms.
 *
 * Fails CLOSED to `+Infinity` on anything unreadable — including a timestamp
 * with no explicit zone, which would otherwise parse as LOCAL time and differ
 * by up to 14h between a laptop and a UTC runner. `+Infinity`, not `-Infinity`:
 * the age is compared with `age > graceDays`, so a NaN or `-Infinity` age would
 * satisfy `> grace === false` and silently mask a stale pin as CURRENT. An
 * unreadable date must instead push the pin past grace.
 */
function daysSince(iso: string): number {
  if (!HAS_TIMEZONE.test(iso.trim())) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 86_400_000;
}

function collectYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectYaml(full));
    else if (entry.endsWith(".yml") || entry.endsWith(".yaml")) out.push(full);
  }
  return out;
}

/**
 * Every SHA-pinned third-party action, reduced to `owner/repo` + the pinned SHA.
 *
 * Tag-pinned refs are skipped: an unpinned ref is `audit:action-sha-pins`'s
 * finding, and reporting it here too would double-count one defect. Two
 * DIFFERENT pins of the same action are both kept — that divergence is itself
 * drift worth seeing.
 */
export function collectPinnedActions(files: readonly WorkflowFile[]): PinnedAction[] {
  const usesRe = /^\s*-?\s*uses:\s*["']?([^"'\s#]+)["']?/gm;
  const out: PinnedAction[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const m of f.text.matchAll(usesRe)) {
      const ref = m[1];
      if (!ref || ref.startsWith("./") || ref.startsWith(".\\") || ref.startsWith("docker://")) {
        continue;
      }
      const at = ref.lastIndexOf("@");
      if (at <= 0) continue;
      const sha = ref.slice(at + 1);
      if (!SHA_RE.test(sha)) continue;
      const parts = ref.slice(0, at).split("/");
      if (parts.length < 2) continue;
      const ownerRepo = `${parts[0]}/${parts[1]}`;
      const key = `${ownerRepo}@${sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ownerRepo, sha, file: f.path });
    }
  }
  return out;
}

export function evaluatePin(
  pin: PinnedAction,
  latest: LatestRelease | null,
  latestSha: string | null,
  graceDays: number,
): PinResult {
  if (latest === null) {
    return {
      ownerRepo: pin.ownerRepo,
      verdict: "indeterminate",
      detail: `no readable latest release for ${pin.ownerRepo}`,
    };
  }
  if (latestSha === null) {
    return {
      ownerRepo: pin.ownerRepo,
      verdict: "indeterminate",
      detail: `cannot resolve ${pin.ownerRepo}@${latest.tag} to a commit SHA`,
    };
  }
  if (latestSha === pin.sha) {
    return {
      ownerRepo: pin.ownerRepo,
      verdict: "ok",
      detail: `${pin.ownerRepo} pinned to ${latest.tag}`,
    };
  }
  const age = daysSince(latest.publishedAt);
  if (age > graceDays) {
    return {
      ownerRepo: pin.ownerRepo,
      verdict: "stale",
      detail: `${pin.ownerRepo} is pinned to ${pin.sha.slice(0, 7)} but ${latest.tag} has been out ${Math.round(age)}d (> ${graceDays}d grace) — ${pin.file}`,
    };
  }
  return {
    ownerRepo: pin.ownerRepo,
    verdict: "ok",
    detail: `${pin.ownerRepo} behind ${latest.tag}, published ${Math.max(0, Math.round(age))}d ago (within ${graceDays}d grace)`,
  };
}

/** Same exit contract as the release-train gate, for one obvious reason: consistency. */
export function summarize(
  results: readonly PinResult[],
  strict: boolean,
): { code: 0 | 1; messages: string[] } {
  const messages: string[] = [];
  const stale = results.filter((r) => r.verdict === "stale");
  const indet = results.filter((r) => r.verdict === "indeterminate");
  const ok = results.filter((r) => r.verdict === "ok");
  for (const r of stale) messages.push(`::error::${r.detail}`);
  for (const r of indet) messages.push(`::warning::${r.detail} (indeterminate)`);
  if (stale.length > 0) return { code: 1, messages };
  if (ok.length === 0 && indet.length > 0 && strict) {
    messages.push("::error::audit:pin-freshness: nothing could be evaluated (all reads failed)");
    return { code: 1, messages };
  }
  return { code: 0, messages };
}

export function parseLatestRelease(json: string): LatestRelease | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const tag = p["tag_name"];
    const publishedAt = p["published_at"];
    if (typeof tag !== "string") return null;
    return { tag, publishedAt: typeof publishedAt === "string" ? publishedAt : "" };
  } catch {
    return null;
  }
}

/** A git ref's object SHA. An ANNOTATED tag points at a tag object, not a commit. */
export function parseTagSha(json: string): string | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const obj = p["object"];
    if (!isRecord(obj)) return null;
    const sha = obj["sha"];
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  }
}

/** `commit.committer.date` from a commit object. */
export function parseCommitDate(json: string): string | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const commit = p["commit"];
    if (!isRecord(commit)) return null;
    const committer = commit["committer"];
    if (!isRecord(committer)) return null;
    const d = committer["date"];
    return typeof d === "string" ? d : null;
  } catch {
    return null;
  }
}

export function parseTagObjectType(json: string): string | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const obj = p["object"];
    if (!isRecord(obj)) return null;
    const t = obj["type"];
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/**
 * The commit a release tag points at. An annotated tag resolves to a tag object
 * first, so it needs a second dereference — comparing a pin against the tag
 * OBJECT's sha would report every annotated-tag action as stale forever.
 */
function readTagCommitSha(ownerRepo: string, tag: string): string | null {
  const res = runGh(["gh", "api", `repos/${ownerRepo}/git/ref/tags/${tag}`]);
  if (!res.ok) return null;
  const sha = parseTagSha(res.stdout);
  if (sha === null) return null;
  if (parseTagObjectType(res.stdout) !== "tag") return sha;

  const deref = runGh(["gh", "api", `repos/${ownerRepo}/git/tags/${sha}`]);
  if (!deref.ok) return null;
  return parseTagSha(deref.stdout);
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const label = "audit:pin-freshness";
  const root = join(import.meta.dir, "..", "..");

  const probe = runGh(["gh", "api", "repos/actions/checkout", "--jq", ".name"]);
  if (!probe.ok) {
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const files = [
    ...collectYaml(join(root, ".github/workflows")),
    ...collectYaml(join(root, ".github/actions")),
  ].map((f) => ({ path: f.slice(root.length + 1), text: readFileSync(f, "utf8") }));

  const results: PinResult[] = [];
  // One release lookup per distinct action, not per call site — the same action
  // appears in a dozen workflows and the API is rate-limited.
  const cache = new Map<
    string,
    { latest: LatestRelease | null; sha: string | null; skip?: boolean }
  >();

  for (const pin of collectPinnedActions(files)) {
    let entry = cache.get(pin.ownerRepo);
    if (!entry) {
      const trackedRef = TRACKED_REF_OVERRIDES[pin.ownerRepo];
      if (trackedRef !== undefined) {
        // Compare against the ref the pin actually tracks. No release exists to
        // date it, so the ref's own head commit supplies `availableSince`.
        //
        // BOTH reads must succeed before a dated result is built. Passing an
        // empty `publishedAt` through would make `daysSince` fail closed to
        // +Infinity and turn a transient read failure into a manufactured
        // `stale` — an unreadable input must degrade to `indeterminate`, never
        // to a finding.
        const refRes = runGh(["gh", "api", `repos/${pin.ownerRepo}/git/ref/${trackedRef}`]);
        const sha = refRes.ok ? parseTagSha(refRes.stdout) : null;
        const since =
          sha === null
            ? null
            : (() => {
                const c = runGh(["gh", "api", `repos/${pin.ownerRepo}/commits/${sha}`]);
                return c.ok ? parseCommitDate(c.stdout) : null;
              })();
        entry =
          sha === null || since === null
            ? { latest: null, sha: null }
            : { latest: { tag: trackedRef.replace(/^heads\//, ""), publishedAt: since }, sha };
        cache.set(pin.ownerRepo, entry);
        results.push(evaluatePin(pin, entry.latest, entry.sha, DEFAULT_GRACE_DAYS));
        continue;
      }
      const relRes = runGh(["gh", "api", `repos/${pin.ownerRepo}/releases/latest`]);
      if (!relRes.ok && classifyReadFailure(relRes.httpStatus) === "absent") {
        // The repo publishes no releases at all (our own `nimbus-agent/.github`
        // composite actions, for one). There is nothing to be behind, and no
        // amount of retrying changes that — so skip it rather than warn
        // forever. A permanent unknown reported as indeterminate is noise that
        // trains people to ignore the gate.
        cache.set(pin.ownerRepo, { latest: null, sha: null, skip: true });
        continue;
      }
      const latest = relRes.ok ? parseLatestRelease(relRes.stdout) : null;
      const sha = latest ? readTagCommitSha(pin.ownerRepo, latest.tag) : null;

      // Measure grace from the TARGET COMMIT's date, not the release's
      // published_at. Many actions ship a ROLLING major tag: `dtolnay/rust-toolchain`'s
      // latest release is `v1` from 2022, but the tag has moved many times
      // since. Using the release date there would report "v1 has been out
      // 1472d" — technically true, wildly misleading, and it makes the grace
      // window meaningless. The commit's own date answers the question the gate
      // is actually asking: how long has the thing you should be pinned to been
      // available? Falls back to the release date when the commit is unreadable.
      let availableSince = latest?.publishedAt ?? "";
      if (sha !== null) {
        const commitRes = runGh(["gh", "api", `repos/${pin.ownerRepo}/commits/${sha}`]);
        const d = commitRes.ok ? parseCommitDate(commitRes.stdout) : null;
        if (d !== null) availableSince = d;
      }
      entry = { latest: latest ? { ...latest, publishedAt: availableSince } : null, sha };
      cache.set(pin.ownerRepo, entry);
    }
    if (entry.skip) continue;
    results.push(evaluatePin(pin, entry.latest, entry.sha, DEFAULT_GRACE_DAYS));
  }

  const out = summarize(results, strict);
  for (const m of out.messages) (m.startsWith("::error::") ? console.error : console.warn)(m);
  if (out.code === 0) {
    const current = results.filter((r) => r.verdict === "ok").length;
    console.log(`${label}: OK (${current}/${results.length} pins current)`);
  }
  process.exit(out.code);
}
