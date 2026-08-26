#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GATEWAY_PKG = join(REPO_ROOT, "packages", "gateway", "package.json");
const PACKAGE_NAME = "@nimbus-dev/connectors";
const REGISTRY = "https://registry.npmjs.org";

export type Skew =
  | { readonly kind: "ok"; readonly pinned: string; readonly latest: string }
  | { readonly kind: "patch"; readonly pinned: string; readonly latest: string }
  | { readonly kind: "behind"; readonly pinned: string; readonly latest: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

/**
 * The lowest version a range admits — `^0.1.1` → `0.1.1`.
 *
 * Deliberately not a semver-range parser. The gateway pins this package with a caret or an exact
 * version and nothing else; anything unrecognised returns undefined and the audit degrades to
 * indeterminate rather than guessing a number it will then compare.
 */
export function floorOf(range: string): string | undefined {
  const m = /^\s*[\^~]?\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(range);
  return m === null ? undefined : `${m[1]}.${m[2]}.${m[3]}`;
}

function parts(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Classify the gap between what the gateway pins and what the registry serves.
 *
 * A MINOR gap is a failure, not a warning: a connector capability has shipped that this gateway
 * cannot load. A PATCH gap is a warning — a fix the gateway has not picked up yet, worth saying and
 * not worth blocking a PR over. Ahead-of-registry is `ok`: that is what a release in flight looks
 * like, and failing it would red every PR between the version bump and the publish.
 */
export function classify(pinned: string, latest: string): Skew {
  const p = parts(pinned);
  const l = parts(latest);
  if (p === undefined || l === undefined) {
    return {
      kind: "indeterminate",
      reason: `unparseable version: pinned=${pinned} latest=${latest}`,
    };
  }
  if (p[0] < l[0] || (p[0] === l[0] && p[1] < l[1])) return { kind: "behind", pinned, latest };
  if (p[0] === l[0] && p[1] === l[1] && p[2] < l[2]) return { kind: "patch", pinned, latest };
  return { kind: "ok", pinned, latest };
}

export async function checkVersionSkew(
  fetchLatest: () => Promise<string> = defaultFetchLatest,
): Promise<Skew> {
  let pinnedRange: unknown;
  try {
    const pkg: unknown = JSON.parse(readFileSync(GATEWAY_PKG, "utf8"));
    if (typeof pkg !== "object" || pkg === null) throw new Error("manifest is not an object");
    const deps = (pkg as Record<string, unknown>)["dependencies"];
    if (typeof deps !== "object" || deps === null) throw new Error("no dependencies block");
    pinnedRange = (deps as Record<string, unknown>)[PACKAGE_NAME];
  } catch (e) {
    return { kind: "indeterminate", reason: `cannot read ${GATEWAY_PKG}: ${String(e)}` };
  }
  if (typeof pinnedRange !== "string") {
    return {
      kind: "indeterminate",
      reason: `${PACKAGE_NAME} is not pinned in the gateway manifest`,
    };
  }
  const pinned = floorOf(pinnedRange);
  if (pinned === undefined) {
    return { kind: "indeterminate", reason: `unrecognised version range: ${pinnedRange}` };
  }

  let latest: string;
  try {
    latest = await fetchLatest();
  } catch (e) {
    // An unreachable registry is an OBSERVATION failure, not skew. Offline development and a
    // registry outage must not fail a gate about version drift — the alternative is a gate people
    // learn to ignore, which is worse than no gate.
    return { kind: "indeterminate", reason: `registry unreachable: ${String(e)}` };
  }
  return classify(pinned, latest);
}

async function defaultFetchLatest(): Promise<string> {
  const r = await fetch(`${REGISTRY}/${PACKAGE_NAME.replace("/", "%2F")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
  const body: unknown = await r.json();
  const tags =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["dist-tags"]
      : undefined;
  const latest =
    typeof tags === "object" && tags !== null
      ? (tags as Record<string, unknown>)["latest"]
      : undefined;
  if (typeof latest !== "string") throw new Error("registry response has no dist-tags.latest");
  return latest;
}

/**
 * Print the verdict and return the process exit code.
 *
 * Split out, and written as guards rather than a `switch`, because the two linters disagree about
 * a switch here: `process.exit()` returns `never`, so tsc calls a following `break` unreachable
 * code, while biome — which does not model that — calls the case without one a fallthrough. There
 * is no arrangement of the switch that satisfies both. Returning a code satisfies both and makes
 * the reporting testable without spawning a process.
 */
export function report(skew: Skew): number {
  if (skew.kind === "behind") {
    console.error(
      `::error file=packages/gateway/package.json::${PACKAGE_NAME} is pinned at ${skew.pinned} but ${skew.latest} is published — a connector capability has shipped that this gateway cannot load`,
    );
    console.log(`connector version skew: BEHIND (${skew.pinned} < ${skew.latest})`);
    return 1;
  }
  if (skew.kind === "patch") {
    console.warn(
      `::warning file=packages/gateway/package.json::${PACKAGE_NAME} is pinned at ${skew.pinned}; ${skew.latest} is published`,
    );
    console.log(`connector version skew: patch behind (${skew.pinned} < ${skew.latest})`);
    return 0;
  }
  if (skew.kind === "indeterminate") {
    console.log(`connector version skew: indeterminate — ${skew.reason}`);
    return 0;
  }
  console.log(`connector version skew: ok (pinned ${skew.pinned}, latest ${skew.latest})`);
  return 0;
}

if (import.meta.main) {
  process.exit(report(await checkVersionSkew()));
}
