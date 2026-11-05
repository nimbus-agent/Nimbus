/**
 * Plan R5 (owner ruling: labels and assignees are add-only). The gateway offers the model four
 * label/assignee writes whose previews say "adds only; removes none". That is true only because
 * the INSTALLED connector's requests add: GitHub `POST .../labels` and `POST .../assignees` (a
 * `PUT` would replace, a `DELETE` remove), GitLab labels through `PUT` with `add_labels` and no
 * `labels` key (which would replace), and GitLab assignees through GraphQL `issueSetAssignees` in
 * `APPEND` mode (`REPLACE` would drop the current ones). This pins each, so a connectors bump that
 * changes one fails CI here.
 */
import { describe, expect, test } from "bun:test";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

/** The mesh server a registration belongs to: its origin connector directory, `-` to `_`. */
function serverOf(origin: string): string {
  return (origin.split("/")[1] ?? "").replaceAll("-", "_");
}

/** The one registration of `id` on `server`: its comment-free call text and its file's text. */
function registeredCall(id: string, server: string): { call: string; file: string } {
  const hits = SCAN.registrations.filter((r) => r.id === id && serverOf(r.origin) === server);
  expect(hits, id).toHaveLength(1);
  const r = hits[0];
  if (r === undefined) throw new Error("unreachable");
  const file = stripComments(SOURCES.find((s) => s.rel === r.file)?.text ?? "");
  return { call: file.slice(r.span[0], r.span[1] + 1), file };
}

/** GitHub: the request is a `POST` and the call names no replacing or removing method. */
function githubAddsOnly(call: string): boolean {
  return call.includes('jsonInit("POST"') && !/["'](PUT|DELETE|PATCH)["']/.test(call);
}

/** GitLab labels: the body (from `jsonBody(`) is a `PUT` carrying `add_labels` only. */
function gitlabLabelsAddOnly(call: string): boolean {
  const at = call.indexOf("jsonBody(");
  if (at === -1) return false;
  const body = call.slice(at);
  return (
    body.includes('"PUT"') &&
    /\badd_labels\s*:/.test(body) &&
    !/(?<![\w])labels\s*:/.test(body) &&
    !body.includes("remove_labels")
  );
}

const APPEND_CONSTANT = "SET_ASSIGNEES_APPEND";

/** The text of `const <name> = ...;` in `file`, or `undefined`. */
function constantText(file: string, name: string): string | undefined {
  const at = file.indexOf(`const ${name} =`);
  if (at === -1) return undefined;
  const end = file.indexOf(";", at);
  return end === -1 ? undefined : file.slice(at, end + 1);
}

/** GitLab assignees: the mutation text appends and never replaces or removes. */
function gitlabAssigneesAppendOnly(mutation: string): boolean {
  return /operationMode:\s*APPEND\b/.test(mutation) && !/\b(REPLACE|REMOVE)\b/.test(mutation);
}

describe("the label and assignee writes only add (connector-enforced, pinned here)", () => {
  test("GitHub labels and assignees are POSTs, never PUT, PATCH or DELETE", () => {
    for (const [id, path] of [
      ["github_issue_labels_add", "/labels"],
      ["github_issue_assignees_add", "/assignees"],
    ] as const) {
      const { call } = registeredCall(id, "github");
      expect(call, id).toContain(`"${id}"`);
      expect(call, id).toContain(path);
      expect(githubAddsOnly(call), id).toBe(true);
    }
  });

  test("GitLab labels are a PUT with add_labels only: no labels key, no remove_labels", () => {
    const { call } = registeredCall("gitlab_issue_labels_add", "gitlab");
    expect(call).toContain('"gitlab_issue_labels_add"');
    expect(gitlabLabelsAddOnly(call)).toBe(true);
  });

  test("GitLab assignees go through the APPEND mutation, which neither replaces nor removes", () => {
    const { call, file } = registeredCall("gitlab_issue_assignees_add", "gitlab");
    expect(call).toContain('"gitlab_issue_assignees_add"');
    expect(call).toMatch(new RegExp(`query:\\s*${APPEND_CONSTANT}\\b`));
    const mutation = constantText(file, APPEND_CONSTANT);
    expect(mutation).toBeDefined();
    expect(mutation).toContain("issueSetAssignees");
    expect(gitlabAssigneesAppendOnly(mutation ?? "")).toBe(true);
  });

  test("guard: each matcher fails a replacing or removing request", () => {
    expect(githubAddsOnly('(p) => jsonInit("POST", { labels: p.labels })')).toBe(true);
    expect(githubAddsOnly('(p) => jsonInit("PUT", { labels: p.labels })')).toBe(false);
    expect(githubAddsOnly('(p) => jsonInit("POST", {}), m: "DELETE"')).toBe(false);
    expect(githubAddsOnly("(p) => fetch(url)")).toBe(false);

    expect(gitlabLabelsAddOnly('jsonBody("PUT", { add_labels: parsed.labels.join(",") })')).toBe(
      true,
    );
    expect(gitlabLabelsAddOnly('jsonBody("PUT", { labels: parsed.labels })')).toBe(false);
    expect(
      gitlabLabelsAddOnly('jsonBody("PUT", { add_labels: a, remove_labels: parsed.labels })'),
    ).toBe(false);
    expect(gitlabLabelsAddOnly('jsonBody("POST", { add_labels: a })')).toBe(false);
    expect(gitlabLabelsAddOnly("labels: parsed.labels")).toBe(false);

    expect(gitlabAssigneesAppendOnly("issueSetAssignees(input: { operationMode: APPEND })")).toBe(
      true,
    );
    expect(gitlabAssigneesAppendOnly("issueSetAssignees(input: { operationMode: REPLACE })")).toBe(
      false,
    );
    expect(
      gitlabAssigneesAppendOnly("operationMode: APPEND }) issueSetAssignees(operationMode: REMOVE"),
    ).toBe(false);
    expect(gitlabAssigneesAppendOnly("issueSetAssignees(input: {})")).toBe(false);
  });
});
