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
 *      a major is the one kind of update that needs reading. So is a PR whose bump list may
 *      be partial, since "every bump is non-breaking" cannot be said of a list with a hole
 *      in it. The request is bound to the head commit that was classified, and a request a
 *      bot enabled is withdrawn if a later refresh makes the PR stop qualifying.
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
 * no writes — and a failure on one PR is reported and does not stop the others.
 */

import {
  type DependencyBump,
  incompleteBumpsReason,
  isBreakingBump,
  isDependabotLogin,
  parseBumps,
  summaryBody,
} from "./dependabot-body.ts";

/** The `--json` fields this script reads, for `gh pr list` and `gh pr view` alike. */
export const PR_JSON_FIELDS =
  "number,title,body,author,baseRefName,isDraft,autoMergeRequest,headRefOid";

/** The fields of one open PR this script reads, as `gh pr list --json` returns them. */
export interface ShepherdPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: { readonly login: string };
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly autoMergeRequest: unknown;
  /** The head commit the title and body above describe — what an auto-merge request is bound to. */
  readonly headRefOid: string;
}

/** What the shepherd will do to one PR. Pure data, so the decisions are testable without `gh`. */
export interface PrPlan {
  readonly number: number;
  readonly newBody: string | undefined;
  readonly enableAutoMerge: boolean;
  /**
   * Withdraw an auto-merge request a BOT enabled, because the PR no longer qualifies. Dependabot
   * refreshes a group in place and a request survives that push, so a PR this script enqueued
   * as non-breaking can later acquire a major. One a person enabled is theirs and is left on.
   */
  readonly disableAutoMerge: boolean;
  /** Why auto-merge is NOT being enabled, when it is not; `undefined` when it is (or already was). */
  readonly holdReason: string | undefined;
  readonly breaking: readonly DependencyBump[];
}

/** Whether auto-merge is on and was requested by a bot rather than by a person. */
function autoMergeEnabledByBot(autoMergeRequest: unknown): boolean {
  if (typeof autoMergeRequest !== "object" || autoMergeRequest === null) return false;
  const enabledBy = (autoMergeRequest as Record<string, unknown>)["enabledBy"];
  if (typeof enabledBy !== "object" || enabledBy === null) return false;
  return (enabledBy as Record<string, unknown>)["is_bot"] === true;
}

/** Decide what to do with one PR. Never throws; an unreadable PR is left alone with a reason. */
export function planForPr(pr: ShepherdPr): PrPlan {
  const base = {
    number: pr.number,
    newBody: undefined,
    enableAutoMerge: false,
    disableAutoMerge: false,
    breaking: [],
  };
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
  const disableAutoMerge = autoMergeEnabledByBot(pr.autoMergeRequest);
  // A partial list proves nothing about the bumps it is missing, and summarising it would
  // erase them from the description for good — so neither write happens.
  const incomplete = incompleteBumpsReason(pr.title, pr.body);
  if (incomplete !== undefined) {
    return {
      ...base,
      disableAutoMerge,
      holdReason: `the bump list may be partial, left for a human: ${incomplete}`,
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
      disableAutoMerge,
      breaking,
      holdReason: `breaking bump, left for a human: ${names}`,
    };
  }
  const alreadyOn = pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined;
  return {
    number: pr.number,
    newBody,
    enableAutoMerge: !alreadyOn,
    disableAutoMerge: false,
    breaking,
    holdReason: undefined,
  };
}

/** Whether a plan writes anything — the only plans worth a second read before acting. */
export function planWrites(plan: PrPlan): boolean {
  return plan.newBody !== undefined || plan.enableAutoMerge || plan.disableAutoMerge;
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
    typeof o["headRefOid"] === "string" &&
    /^[0-9a-f]{40}$/.test(o["headRefOid"]) &&
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

/** `gh pr view --json` output for one PR, held to the same shape as a list entry. */
export function parsePr(raw: string): ShepherdPr {
  const parsed: unknown = JSON.parse(raw);
  if (!isShepherdPr(parsed)) {
    throw new Error("gh pr view returned an unexpected shape — refusing to act on it");
  }
  return parsed;
}

/**
 * The `gh` invocations that carry out a plan, in order. `classified` is the snapshot the plan
 * was made FROM, and its head is what the auto-merge request is bound to: GitHub refuses the
 * request if the branch has moved since, so a bump Dependabot added after classification can
 * never be enqueued on the strength of a decision made without it.
 */
export function ghCallsForPlan(
  plan: PrPlan,
  classified: ShepherdPr,
  repo: string,
): { readonly args: readonly string[]; readonly stdin?: string; readonly did: string }[] {
  const n = String(plan.number);
  const calls: { args: string[]; stdin?: string; did: string }[] = [];
  if (plan.disableAutoMerge) {
    calls.push({
      args: ["pr", "merge", n, "--repo", repo, "--disable-auto"],
      did: "withdrew auto-merge",
    });
  }
  if (plan.newBody !== undefined) {
    calls.push({
      args: ["pr", "edit", n, "--repo", repo, "--body-file", "-"],
      stdin: plan.newBody,
      did: "summarised description",
    });
  }
  if (plan.enableAutoMerge) {
    calls.push({
      args: [
        "pr",
        "merge",
        n,
        "--repo",
        repo,
        "--squash",
        "--auto",
        "--match-head-commit",
        classified.headRefOid,
      ],
      did: "enabled auto-merge",
    });
  }
  return calls;
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
    PR_JSON_FIELDS,
  ]);
  const prs = parsePrList(raw);
  console.log(
    `dependabot-shepherd: ${String(prs.length)} open Dependabot PR(s)${dryRun ? " (dry run)" : ""}`,
  );

  let failures = 0;
  for (const listed of prs) {
    let pr = listed;
    const did: string[] = [];
    try {
      let plan = planForPr(pr);
      if (planWrites(plan)) {
        // The list above is one snapshot for every PR, and Dependabot can refresh a group
        // while earlier PRs are being written. Re-read THIS one and plan again from that, so
        // the description written and the head the merge is bound to are the ones just read.
        pr = parsePr(
          await gh(["pr", "view", String(pr.number), "--repo", repo, "--json", PR_JSON_FIELDS]),
        );
        plan = planForPr(pr);
      }
      for (const call of ghCallsForPlan(plan, pr, repo)) {
        if (!dryRun) await gh(call.args, call.stdin);
        did.push(call.did);
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
