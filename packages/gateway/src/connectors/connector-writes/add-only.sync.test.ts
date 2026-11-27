/**
 * Plan R5 (owner ruling: labels and assignees are add-only). The gateway offers the model four
 * label/assignee writes whose previews say "adds only; removes none". That is true only because
 * the INSTALLED connector's requests add: GitHub `POST .../labels` and `POST .../assignees` (a
 * `PUT` would replace, a `DELETE` remove), GitLab labels through `PUT` with `add_labels` and no
 * `labels` key (which would replace), and GitLab assignees through GraphQL `issueSetAssignees` in
 * `APPEND` mode (`REPLACE` would drop the current ones). This pins each, so a connectors bump that
 * changes one fails CI here. Since connectors 0.19.0 the removes and the Linear label add are
 * pinned the same way (below).
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

/** The text of `async function <name>(` up to its closing brace at column 0, or `undefined`. */
function functionText(file: string, name: string): string | undefined {
  const at = file.indexOf(`async function ${name}(`);
  if (at === -1) return undefined;
  const end = file.indexOf("\n}\n", at);
  return end === -1 ? undefined : file.slice(at, end + 2);
}

/** The shared GitLab helper posts exactly `{ query, variables }`, the query being its parameter. */
function setAssigneesSendsItsQuery(file: string): boolean {
  const fn = functionText(file, "setIssueAssignees") ?? "";
  return (
    /^async function setIssueAssignees\(\s*query: string,/.test(fn) &&
    /JSON\.stringify\(\{\s*query,\s*variables:/.test(fn)
  );
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
    // Since 0.19.0 the request is the shared `setIssueAssignees(<mutation>, parsed)`, which sends
    // the mutation it is given as the GraphQL query and nothing else.
    expect(call).toMatch(new RegExp(String.raw`setIssueAssignees\(\s*${APPEND_CONSTANT}\b`));
    expect(setAssigneesSendsItsQuery(file)).toBe(true);
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
    expect(
      setAssigneesSendsItsQuery(
        "async function setIssueAssignees(query: string, p) { JSON.stringify({ query, variables: {} }) }\n}\n",
      ),
    ).toBe(true);
    expect(
      setAssigneesSendsItsQuery(
        "async function setIssueAssignees(query: string, p) { JSON.stringify({ query: Q, variables: {} }) }\n}\n",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Connectors 0.19.0 (owner rulings 2026-11-27): the label and assignee removes, whose previews say
// "removes only; adds none", and the Linear label add, whose preview says "adds only". True only
// because the INSTALLED connector's requests do exactly that: GitHub `DELETE`s each named label
// (never the `PUT` that replaces the set) and `DELETE`s the named assignees; GitLab labels through
// `PUT` with `remove_labels` only; GitLab assignees through `issueSetAssignees` in `REMOVE` mode;
// Linear through `issueUpdate` with `addedLabelIds` or `removedLabelIds`, never `labelIds`.
// ---------------------------------------------------------------------------------------------

/** GitHub removes: a `DELETE` and no adding or replacing method. */
function githubRemovesOnly(call: string): boolean {
  return /\bDELETE\b/.test(call) && !/["'](PUT|POST|PATCH)["']/.test(call);
}

/** GitLab label remove: the body is a `PUT` carrying `remove_labels` only. */
function gitlabLabelsRemoveOnly(call: string): boolean {
  const at = call.indexOf("jsonBody(");
  if (at === -1) return false;
  const body = call.slice(at);
  return (
    body.includes('"PUT"') &&
    /\bremove_labels\s*:/.test(body) &&
    !/(?<![\w])labels\s*:/.test(body) &&
    !body.includes("add_labels")
  );
}

/** GitLab assignee remove: the mutation removes and never appends or replaces. */
function gitlabAssigneesRemoveOnly(mutation: string): boolean {
  return /operationMode:\s*REMOVE\b/.test(mutation) && !/\b(REPLACE|APPEND)\b/.test(mutation);
}

/** Linear: the one label helper sends `input: { <field>: $labelIds }`, `field` an add or remove list. */
function linearLabelsDelta(file: string): boolean {
  const fn = functionText(file, "changeIssueLabels") ?? "";
  return (
    /field: "addedLabelIds" \| "removedLabelIds"/.test(fn) &&
    fn.includes(`input: { ${"$"}{field}: $labelIds }`) &&
    !/input:\s*\{[^}]*\blabelIds\s*:/.test(fn)
  );
}

describe("the 0.19.0 label and assignee changes do only what their previews say", () => {
  test("GitHub label and assignee removes are DELETEs, never PUT, POST or PATCH", () => {
    for (const [id, path] of [
      ["github_issue_labels_remove", "/labels/"],
      ["github_issue_assignees_remove", "/assignees"],
    ] as const) {
      const { call } = registeredCall(id, "github");
      expect(call, id).toContain(`"${id}"`);
      expect(call, id).toContain(path);
      expect(githubRemovesOnly(call), id).toBe(true);
    }
    // One label per request, by name, encoded into the path.
    expect(registeredCall("github_issue_labels_remove", "github").call).toContain(
      "encodeURIComponent(label)",
    );
  });

  test("GitLab label remove is a PUT with remove_labels only; assignee remove is the REMOVE mutation", () => {
    const labels = registeredCall("gitlab_issue_labels_remove", "gitlab");
    expect(gitlabLabelsRemoveOnly(labels.call)).toBe(true);
    const { call, file } = registeredCall("gitlab_issue_assignees_remove", "gitlab");
    expect(call).toMatch(/setIssueAssignees\(\s*SET_ASSIGNEES_REMOVE\b/);
    expect(setAssigneesSendsItsQuery(file)).toBe(true);
    const mutation = constantText(file, "SET_ASSIGNEES_REMOVE") ?? "";
    expect(mutation).toContain("issueSetAssignees");
    expect(gitlabAssigneesRemoveOnly(mutation)).toBe(true);
  });

  test("Linear label add and remove send only the added or removed ids, never the whole set", () => {
    const add = registeredCall("linear_issue_labels_add", "linear");
    expect(add.call).toContain('changeIssueLabels("addedLabelIds", parsed)');
    const remove = registeredCall("linear_issue_labels_remove", "linear");
    expect(remove.call).toContain('changeIssueLabels("removedLabelIds", parsed)');
    expect(linearLabelsDelta(add.file)).toBe(true);
  });

  test("guard: each matcher fails an adding or replacing request", () => {
    expect(githubRemovesOnly('{ method: "DELETE" }')).toBe(true);
    expect(githubRemovesOnly('jsonInit("PUT", { labels: [] }) DELETE')).toBe(false);
    expect(githubRemovesOnly('jsonInit("POST", { assignees: a })')).toBe(false);
    expect(gitlabLabelsRemoveOnly('jsonBody("PUT", { remove_labels: a })')).toBe(true);
    expect(gitlabLabelsRemoveOnly('jsonBody("PUT", { labels: a })')).toBe(false);
    expect(gitlabLabelsRemoveOnly('jsonBody("PUT", { remove_labels: a, add_labels: b })')).toBe(
      false,
    );
    expect(gitlabAssigneesRemoveOnly("operationMode: REMOVE")).toBe(true);
    expect(gitlabAssigneesRemoveOnly("operationMode: REPLACE")).toBe(false);
    const linear = (input: string): string =>
      `async function changeIssueLabels(\n  field: "addedLabelIds" | "removedLabelIds",\n) {\n  const q = \`issueUpdate(id: $id, input: ${input})\`;\n}\n`;
    expect(linearLabelsDelta(linear(`{ ${"$"}{field}: $labelIds }`))).toBe(true);
    expect(linearLabelsDelta(linear("{ labelIds: $labelIds }"))).toBe(false);
  });
});
