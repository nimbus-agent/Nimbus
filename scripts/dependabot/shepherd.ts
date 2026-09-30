#!/usr/bin/env bun
/**
 * Dependabot shepherd — the scheduled job that walks every open Dependabot PR against `main`
 * and does the two things a human did by hand for every one of them through 2026-09:
 *
 *   1. Replace the description with `summaryBody` (see `dependabot-body.ts` for why), so the
 *      squash commit it lands as always parses.
 *   2. Enable auto-merge when every bump in it is non-breaking. With the merge queue on `main`,
 *      that ENQUEUES the PR once its checks pass; the queue re-tests it on the real tip of
 *      `main` and lands it. A breaking bump (a major, or a 0.x minor) is left for a human —
 *      a major is the one kind of update that needs reading.
 *
 * WHY A SCHEDULE AND NOT `on: pull_request`. Two platform rules rule out the obvious design:
 *   - A workflow triggered by Dependabot receives only Dependabot secrets, not Actions secrets,
 *     so it cannot mint the release-bot App token.
 *   - A merge performed under the built-in GITHUB_TOKEN does not trigger `push` workflows, so
 *     `main` would receive the commit without its CI run, release-please, or the Security scan.
 * A scheduled run is not triggered BY Dependabot, so it gets the App token, and a merge
 * enabled under an App installation token triggers `push` normally.
 *
 * It never checks out or executes PR code: it reads PR metadata through the API and writes a
 * description and an auto-merge request. Idempotent — a PR already in the desired state costs
 * two reads and no writes — and a failure on one PR is reported and does not stop the others.
 */

import {
  type DependencyBump,
  isBreakingBump,
  isDependabotLogin,
  parseBumps,
  summaryBody,
} from "./dependabot-body.ts";

/** The fields of one open PR this script reads, as `gh pr list --json` returns them. */
export interface ShepherdPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: { readonly login: string };
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly autoMergeRequest: unknown;
}

/** What the shepherd will do to one PR. Pure data, so the decisions are testable without `gh`. */
export interface PrPlan {
  readonly number: number;
  readonly newBody: string | undefined;
  readonly enableAutoMerge: boolean;
  /** Why auto-merge is NOT being enabled, when it is not; `undefined` when it is (or already was). */
  readonly holdReason: string | undefined;
  readonly breaking: readonly DependencyBump[];
}

/** Decide what to do with one PR. Never throws; an unreadable PR is left alone with a reason. */
export function planForPr(pr: ShepherdPr): PrPlan {
  const base = { number: pr.number, newBody: undefined, enableAutoMerge: false, breaking: [] };
  if (!isDependabotLogin(pr.author.login))
    return { ...base, holdReason: "not authored by Dependabot" };
  if (pr.baseRefName !== "main")
    return { ...base, holdReason: `targets ${pr.baseRefName}, not main` };
  if (pr.isDraft) return { ...base, holdReason: "draft" };

  const bumps = parseBumps(pr.title, pr.body);
  if (bumps.length === 0) {
    return {
      ...base,
      holdReason: "no dependency bump could be read from the title or description",
    };
  }
  const desired = summaryBody(pr.title, pr.body);
  const newBody =
    desired !== undefined && desired !== pr.body.replace(/\r\n/g, "\n") ? desired : undefined;
  const breaking = bumps.filter(isBreakingBump);

  if (breaking.length > 0) {
    const names = breaking.map((b) => `${b.name} ${b.from} -> ${b.to}`).join(", ");
    return {
      number: pr.number,
      newBody,
      enableAutoMerge: false,
      breaking,
      holdReason: `breaking bump, left for a human: ${names}`,
    };
  }
  const alreadyOn = pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined;
  return {
    number: pr.number,
    newBody,
    enableAutoMerge: !alreadyOn,
    breaking,
    holdReason: undefined,
  };
}

function isShepherdPr(v: unknown): v is ShepherdPr {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const author = o["author"];
  return (
    typeof o["number"] === "number" &&
    typeof o["title"] === "string" &&
    typeof o["body"] === "string" &&
    typeof o["baseRefName"] === "string" &&
    typeof o["isDraft"] === "boolean" &&
    typeof author === "object" &&
    author !== null &&
    typeof (author as Record<string, unknown>)["login"] === "string"
  );
}

/** `gh pr list --json` output, refusing anything that is not the shape `planForPr` reads. */
export function parsePrList(raw: string): ShepherdPr[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isShepherdPr)) {
    throw new Error("gh pr list returned an unexpected shape — refusing to act on it");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// CLI — a thin shell over `gh`. Everything decided above.
// ---------------------------------------------------------------------------

async function gh(args: readonly string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`gh ${args.slice(0, 3).join(" ")} exited ${String(code)}: ${err.trim()}`);
  return out;
}

async function main(): Promise<void> {
  const repo = process.env["REPO"];
  if (repo === undefined || repo === "") {
    console.error("::error::REPO is not set");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const raw = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--author",
    "app/dependabot",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,body,author,baseRefName,isDraft,autoMergeRequest",
  ]);
  const prs = parsePrList(raw);
  console.log(
    `dependabot-shepherd: ${String(prs.length)} open Dependabot PR(s)${dryRun ? " (dry run)" : ""}`,
  );

  let failures = 0;
  for (const pr of prs) {
    const plan = planForPr(pr);
    const did: string[] = [];
    try {
      if (plan.newBody !== undefined) {
        if (!dryRun)
          await gh(
            ["pr", "edit", String(pr.number), "--repo", repo, "--body-file", "-"],
            plan.newBody,
          );
        did.push("summarised description");
      }
      if (plan.enableAutoMerge) {
        if (!dryRun)
          await gh(["pr", "merge", String(pr.number), "--repo", repo, "--squash", "--auto"]);
        did.push("enabled auto-merge");
      }
      const tail = plan.holdReason === undefined ? "" : ` — held: ${plan.holdReason}`;
      console.log(
        `#${String(pr.number)} ${pr.title}: ${did.length > 0 ? did.join(", ") : "no change"}${tail}`,
      );
    } catch (e) {
      failures += 1;
      console.log(
        `::warning::#${String(pr.number)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (failures > 0) {
    console.error(
      `::error::${String(failures)} PR(s) could not be shepherded — see the warnings above`,
    );
    process.exit(1);
  }
}

if (import.meta.main) await main();
