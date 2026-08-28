#!/usr/bin/env bun

/**
 * audit:review-coverage — asserts every gated org repo carries a `.coderabbit.yaml`
 * that is present, parseable, AND ACTIVE.
 *
 * This is P3's org-wide half. `check-coderabbit-config.test.ts` already validates
 * THIS repo's config in depth (invariant ids, instruction quality); nothing
 * validated the satellites', which is the "controls stop where they were written"
 * pattern this sub-program exists to break.
 *
 * Why "active" and not just "present": the lesson from the CLA outage and from
 * `audit:actions-allowlist` is that a control can be committed, valid-looking and
 * completely inert. A `.coderabbit.yaml` with `auto_review.enabled: false`, or one
 * whose `base_branches` no longer lists the branch PRs actually target, reviews
 * nothing — and reads as covered. Presence alone would have passed all three.
 *
 * Deliberately NOT checked: instruction CONTENT. The repos are different products
 * under different licences (the SDK must stay dependency-free; the gateway carries
 * I1-I34), so a shared-content assertion could only be satisfied by making the
 * instructions vaguer. Per-repo content is the local test's job, in the repo that
 * owns it.
 *
 * Same fail-soft-local / strict-in-CI contract as the other org-drift-sweep gates.
 */

import { parse } from "yaml";

import { classifyReadFailure, type GhResult, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** Classify one per-repo contents read into read / absent / indeterminate. */
export function classifyRepoRead(res: GhResult): { kind: "read" | "absent" | "indeterminate" } {
  if (res.ok) return { kind: "read" };
  return { kind: classifyReadFailure(res.httpStatus) };
}

/**
 * Repos whose PRs carry source worth an automated review pass.
 *
 * `awesome-nimbus` is deliberately absent: it is a curated link list with no
 * source tree, so a review config there would assert a control that reviews
 * nothing. Recorded as an explicit exemption rather than an omission, so the
 * next person can tell "decided" from "forgotten".
 */
const GATED_REPOS = [
  "Nimbus",
  "nimbus-sdk",
  "nimbus-client",
  "nimbus-vscode",
  "nimbus-web-clipper",
  // Has a source tree and takes PRs, so a review pass is worth asserting. It
  // already carries a `.coderabbit.yaml` with `auto_review.enabled: true`;
  // adding it here is what makes that a gated fact rather than a coincidence.
  "create-nimbus-connector",
];

export const EXEMPT_REPOS: Readonly<Record<string, string>> = {
  "awesome-nimbus": "curated link list — no source tree to review",
};

/** The branch PRs are expected to target across the org. */
const EXPECTED_BASE = "main";

/**
 * What a repo's config looked like when read.
 *
 * `null` = no `.coderabbit.yaml`. `"unparseable"` = the file exists but is not
 * valid YAML — distinct from absent, because CodeRabbit silently ignores a config
 * it cannot parse, which looks exactly like having none.
 */
export type LiveConfig = Record<string, unknown> | null | "unparseable";

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Pure diff — the whole verdict, so it is unit-testable without network.
 *
 * Every check reports the repo by name, because the repair differs per finding:
 * "add a config" is a different job from "someone turned auto_review off".
 */
export function diffReviewCoverage(repos: string[], live: Record<string, LiveConfig>): AuditResult {
  const errors: string[] = [];
  for (const repo of repos) {
    const cfg = live[repo];
    if (cfg === null || cfg === undefined) {
      errors.push(`${repo}: no .coderabbit.yaml`);
      continue;
    }
    if (cfg === "unparseable") {
      errors.push(`${repo}: .coderabbit.yaml is not valid YAML (CodeRabbit ignores it silently)`);
      continue;
    }
    const reviews = asRecord(cfg["reviews"]);
    if (!reviews) {
      errors.push(`${repo}: .coderabbit.yaml has no \`reviews\` section`);
      continue;
    }

    const auto = asRecord(reviews["auto_review"]);
    if (!auto) {
      errors.push(`${repo}: no \`reviews.auto_review\` — PRs are not reviewed automatically`);
    } else {
      if (auto["enabled"] !== true) {
        errors.push(`${repo}: \`auto_review.enabled\` is not true — the config is inert`);
      }
      const bases = auto["base_branches"];
      if (!Array.isArray(bases) || !bases.includes(EXPECTED_BASE)) {
        errors.push(
          `${repo}: \`auto_review.base_branches\` does not include \`${EXPECTED_BASE}\` — PRs into ${EXPECTED_BASE} are not reviewed`,
        );
      }
    }

    const instructions = reviews["path_instructions"];
    if (!Array.isArray(instructions) || instructions.length === 0) {
      errors.push(
        `${repo}: \`reviews.path_instructions\` is empty — the config carries no repo-specific guidance`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Parse a config blob, mapping any YAML error to the `unparseable` verdict. */
export function parseConfig(yamlText: string): LiveConfig {
  let parsed: unknown;
  try {
    parsed = parse(yamlText);
  } catch {
    return "unparseable";
  }
  // A YAML document can legally be a scalar or a list; neither is a usable
  // CodeRabbit config, and both would otherwise reach the shape checks as
  // something that is not a mapping.
  return asRecord(parsed) ?? "unparseable";
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const label = "audit:review-coverage";

  // Reachability probe — same contract as cla-coverage. The gated repos are
  // public, so a per-repo 404 unambiguously means "config absent" (a real
  // finding) rather than "unauthorized"; the only fail-soft case is `gh` or the
  // network being unavailable at all, which this single probe detects.
  const probe = runGh(["gh", "api", "repos/nimbus-agent/Nimbus", "--jq", ".name"]);
  if (!probe.ok) {
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const live: Record<string, LiveConfig> = {};
  for (const repo of GATED_REPOS) {
    const res = runGh([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/contents/.coderabbit.yaml`,
      "--jq",
      ".content",
    ]);
    // Only a 404 means "absent". A transient failure must never be recorded as
    // absence — that turns a blip into a fake "repo lost its review config" red.
    const cls = classifyRepoRead(res);
    if (cls.kind === "indeterminate") {
      const outcome = strictSkip(
        label,
        strict,
        `review-coverage indeterminate — ${repo} read failed transiently (HTTP ${res.httpStatus ?? "?"})`,
      );
      if (outcome.code === 1) console.error(outcome.message);
      else console.warn(outcome.message);
      process.exit(outcome.code);
    }
    if (cls.kind === "absent") {
      live[repo] = null;
      continue;
    }
    // `.replace(/\s/g, "")` strips the newlines GitHub inserts into the base64
    // *envelope* of the contents API response — NOT the decoded YAML.
    live[repo] = parseConfig(Buffer.from(res.stdout.replace(/\s/g, ""), "base64").toString("utf8"));
  }

  const result = diffReviewCoverage(GATED_REPOS, live);
  if (!result.ok) {
    for (const err of result.errors) console.error(`${label}: ${err}`);
    process.exit(1);
  }
  const exempt = Object.keys(EXEMPT_REPOS).length;
  console.log(`${label}: OK (${GATED_REPOS.length} repos, ${exempt} exempt)`);
}
