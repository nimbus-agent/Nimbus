import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load as loadYaml } from "js-yaml";

import { REPO_ROOT } from "../structure-audit/lib.ts";

/**
 * `cla.yml` repeats its job's `if:` in its concurrency group, and the two copies must agree.
 *
 * Every comment on a PR starts the CLA workflow, and the job's `if:` skips all but the sign and
 * `recheck` comments. A run joins its workflow-level group when it is created, before that `if:` is
 * read, and GitHub cancels a group's pending run whenever a newer run joins. While every run shared
 * one per-PR group, a reply evicted the queued run for #1679's new head commit, which then never got
 * its required `cla` check: the PR stayed BLOCKED with every visible check green. The group now
 * sends a run the `if:` will skip to a group of its own, which holds only while both copies of the
 * condition accept the same events.
 */

const CLA_YML = join(REPO_ROOT, ".github", "workflows", "cla.yml");

const workflow = loadYaml(readFileSync(CLA_YML, "utf8")) as {
  readonly concurrency?: { readonly group?: unknown; readonly "cancel-in-progress"?: unknown };
  readonly jobs?: { readonly cla?: { readonly if?: unknown } };
};

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`cla.yml: ${what} is not a string`);
  return value;
}

/** The comment bodies a condition accepts: the array literal inside its `fromJSON('…')`. */
function acceptedComments(condition: string): string[] {
  const m = /fromJSON\('(\[[^']*\])'\)/.exec(condition);
  if (m?.[1] === undefined) throw new Error(`no fromJSON('[…]') in: ${condition}`);
  const parsed: unknown = JSON.parse(m[1]);
  if (!Array.isArray(parsed) || !parsed.every((c) => typeof c === "string")) {
    throw new Error(`fromJSON('…') is not an array of strings in: ${condition}`);
  }
  return parsed;
}

const group = text(workflow.concurrency?.group, "concurrency.group");
const jobIf = text(workflow.jobs?.cla?.if, "jobs.cla.if");

describe("cla.yml concurrency", () => {
  test("the group admits exactly the comments the job runs for", () => {
    expect(acceptedComments(group)).toEqual(acceptedComments(jobIf));
  });

  test("both admit every pull_request_target run, and comments only on a PR", () => {
    for (const condition of [group, jobIf]) {
      expect(condition).toContain("github.event_name == 'pull_request_target'");
      expect(condition).toContain("github.event.issue.pull_request");
    }
  });

  test("a run the job will skip gets a group of its own, and no run is cancelled mid-flight", () => {
    expect(group).toContain("format('cla-skipped-{0}', github.run_id)");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});
