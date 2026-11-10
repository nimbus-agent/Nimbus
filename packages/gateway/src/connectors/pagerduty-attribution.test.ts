import { expect, test } from "bun:test";
import {
  extractPagerdutyActors,
  MAX_ASSIGNEES_PER_INCIDENT,
  pagerdutyEmailMapFromIncidents,
  pagerdutyUnresolvedActorIds,
} from "./pagerduty-attribution.ts";

test("harvests emails from expanded assignees and acknowledgers", () => {
  const map = pagerdutyEmailMapFromIncidents([
    {
      id: "PD-1",
      assignments: [{ assignee: { id: "PUSER1", type: "user", email: "jane@example.com" } }],
      acknowledgements: [
        { acknowledger: { id: "PUSER2", type: "user", email: "bob@example.com" } },
      ],
    },
  ]);
  expect(map.get("PUSER1")).toBe("jane@example.com");
  expect(map.get("PUSER2")).toBe("bob@example.com");
});

test("harvests across the whole page, not just the first incident", () => {
  const map = pagerdutyEmailMapFromIncidents([
    { id: "PD-1", assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }] },
    { id: "PD-2", assignments: [{ assignee: { id: "PUSER2", email: "bob@example.com" } }] },
  ]);
  expect(map.size).toBe(2);
});

// A service_reference acknowledger is an auto-ack, not a person.
test("skips a service acknowledger", () => {
  const map = pagerdutyEmailMapFromIncidents([
    {
      id: "PD-1",
      acknowledgements: [{ acknowledger: { id: "PSVC1", type: "service_reference" } }],
    },
  ]);
  expect(map.size).toBe(0);
});

test("skips an unexpanded reference that carries no email", () => {
  const map = pagerdutyEmailMapFromIncidents([
    { id: "PD-1", assignments: [{ assignee: { id: "PUSER1", type: "user_reference" } }] },
  ]);
  expect(map.size).toBe(0);
});

test("skips an actor whose email fails the guard", () => {
  const map = pagerdutyEmailMapFromIncidents([
    { id: "PD-1", assignments: [{ assignee: { id: "PUSER1", email: "unknown" } }] },
  ]);
  expect(map.size).toBe(0);
});

test("tolerates every field being absent or the wrong shape", () => {
  expect(pagerdutyEmailMapFromIncidents([null, 42, "x", {}, { assignments: "nope" }]).size).toBe(0);
});

const EMPTY = new Map<string, string>();

test("extracts assignee emails from expanded assignees", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "triggered",
      assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
    },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual(["jane@example.com"]);
  expect(actors.unattributed).toBe(0);
});

test("falls back to the id map for a bare assignee reference", () => {
  const actors = extractPagerdutyActors(
    { id: "PD-1", status: "triggered", assignments: [{ assignee: { id: "PUSER1" } }] },
    new Map([["PUSER1", "jane@example.com"]]),
  );
  expect(actors.assigneeEmails).toEqual(["jane@example.com"]);
});

test("counts an assignee it cannot resolve", () => {
  const actors = extractPagerdutyActors(
    { id: "PD-1", status: "triggered", assignments: [{ assignee: { id: "PUSER1" } }] },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual([]);
  expect(actors.unattributed).toBe(1);
});

test("dedupes a person assigned twice", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "triggered",
      assignments: [
        { assignee: { id: "PUSER1", email: "jane@example.com" } },
        { assignee: { id: "PUSER1", email: "jane@example.com" } },
      ],
    },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual(["jane@example.com"]);
  expect(actors.unattributed).toBe(0);
});

test("caps assignees and counts the overflow", () => {
  const assignments = Array.from({ length: MAX_ASSIGNEES_PER_INCIDENT + 3 }, (_, i) => ({
    assignee: { id: `PUSER${String(i)}`, email: `u${String(i)}@example.com` },
  }));
  const actors = extractPagerdutyActors({ id: "PD-1", status: "triggered", assignments }, EMPTY);
  expect(actors.assigneeEmails).toHaveLength(MAX_ASSIGNEES_PER_INCIDENT);
  expect(actors.unattributed).toBe(3);
});

test("skips a service-type assignee without counting it as unattributed", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "triggered",
      assignments: [{ assignee: { id: "PSVC1", type: "service_reference" } }],
    },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual([]);
  expect(actors.unattributed).toBe(0);
});

test("keeps exactly the cap with zero overflow at the boundary", () => {
  const assignments = Array.from({ length: MAX_ASSIGNEES_PER_INCIDENT }, (_, i) => ({
    assignee: { id: `PUSER${String(i)}`, email: `u${String(i)}@example.com` },
  }));
  const actors = extractPagerdutyActors({ id: "PD-1", status: "triggered", assignments }, EMPTY);
  expect(actors.assigneeEmails).toHaveLength(MAX_ASSIGNEES_PER_INCIDENT);
  expect(actors.unattributed).toBe(0);
});

test("overflows by exactly one past the cap boundary", () => {
  const assignments = Array.from({ length: MAX_ASSIGNEES_PER_INCIDENT + 1 }, (_, i) => ({
    assignee: { id: `PUSER${String(i)}`, email: `u${String(i)}@example.com` },
  }));
  const actors = extractPagerdutyActors({ id: "PD-1", status: "triggered", assignments }, EMPTY);
  expect(actors.assigneeEmails).toHaveLength(MAX_ASSIGNEES_PER_INCIDENT);
  expect(actors.unattributed).toBe(1);
});

test("resolves last_status_change_by only when the incident is resolved", () => {
  const row = {
    id: "PD-1",
    status: "acknowledged",
    last_status_change_by: { id: "PUSER1", type: "user_reference" },
  };
  const map = new Map([["PUSER1", "jane@example.com"]]);
  expect(extractPagerdutyActors(row, map).resolvedByEmail).toBeNull();
  expect(extractPagerdutyActors({ ...row, status: "resolved" }, map).resolvedByEmail).toBe(
    "jane@example.com",
  );
});

test("a service_reference resolver attributes to nobody without counting a failure", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "resolved",
      last_status_change_by: { id: "PSVC1", type: "service_reference" },
    },
    EMPTY,
  );
  expect(actors.resolvedByEmail).toBeNull();
  expect(actors.unattributed).toBe(0);
});

test("counts a resolved incident whose resolver cannot be resolved", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "resolved",
      last_status_change_by: { id: "PUSER9", type: "user_reference" },
    },
    EMPTY,
  );
  expect(actors.resolvedByEmail).toBeNull();
  expect(actors.unattributed).toBe(1);
});

test("collects only the actor ids still missing an email", () => {
  const incidents = [
    {
      id: "PD-1",
      status: "resolved",
      assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
      last_status_change_by: { id: "PUSER9", type: "user_reference" },
    },
    {
      id: "PD-2",
      status: "resolved",
      last_status_change_by: { id: "PSVC1", type: "service_reference" },
    },
  ];
  const map = pagerdutyEmailMapFromIncidents(incidents);
  expect(pagerdutyUnresolvedActorIds(incidents, map)).toEqual(["PUSER9"]);
});

test("the email map skips service actors, malformed rows, id-less actors and unusable emails, and keeps the first email per id", () => {
  const map = pagerdutyEmailMapFromIncidents([
    "junk",
    {
      assignments: [
        { assignee: { id: "SVC", type: "service_reference", email: "svc@example.com" } },
        { assignee: { email: "noid@example.com" } },
        { assignee: { id: "", email: "empty@example.com" } },
        { assignee: { id: "U1", email: "not an email" } },
        { assignee: { id: "U2", email: "first@example.com" } },
        { assignee: { id: "U2", email: "second@example.com" } },
        "no assignee",
        { assignee: "x" },
      ],
      acknowledgements: "nope",
    },
  ]);
  expect([...map.entries()]).toEqual([["U2", "first@example.com"]]);
});

test("a non-list assignments value yields no assignees", () => {
  expect(extractPagerdutyActors({ assignments: "x" }, new Map())).toEqual({
    assigneeEmails: [],
    resolvedByEmail: null,
    unattributed: 0,
  });
});

test("an assignee is resolved through the page map, repeats collapse, and the rest are unattributed", () => {
  const actors = extractPagerdutyActors(
    {
      assignments: [
        { assignee: { id: "U1" } },
        { assignee: { id: "U1b", email: "mapped@example.com" } },
        { assignee: { id: "U1" } },
        { assignee: { id: "U9" } },
        { assignee: { email: "" } },
        { assignee: { id: "SVC", type: "service_reference" } },
      ],
    },
    new Map([["U1", "mapped@example.com"]]),
  );
  expect(actors.assigneeEmails).toEqual(["mapped@example.com"]);
  expect(actors.unattributed).toBe(2);
});

test("a resolver counts only on a resolved incident and only when it is a person", () => {
  const map = new Map([["R1", "res@example.com"]]);
  const resolved = (by: unknown, status = "resolved") =>
    extractPagerdutyActors({ status, last_status_change_by: by }, map);
  expect(resolved({ id: "R1" }).resolvedByEmail).toBe("res@example.com");
  expect(resolved({ id: "R1" }, "triggered")).toEqual({
    assigneeEmails: [],
    resolvedByEmail: null,
    unattributed: 0,
  });
  expect(resolved({ id: "SVC", type: "service_reference" }).unattributed).toBe(0);
  expect(resolved({ id: "UNKNOWN" })).toMatchObject({ resolvedByEmail: null, unattributed: 1 });
  expect(resolved({ email: "" }).unattributed).toBe(1);
});

test("unresolved actor ids exclude services, known emails, known ids and id-less actors, and include a resolved incident's resolver", () => {
  const ids = pagerdutyUnresolvedActorIds(
    [
      "junk",
      {
        status: "resolved",
        last_status_change_by: { id: "R9" },
        assignments: [
          { assignee: { id: "A1" } },
          { assignee: { id: "A2", email: "has@example.com" } },
          { assignee: { id: "KNOWN" } },
          { assignee: { id: "SVC", type: "service_reference" } },
          { assignee: {} },
          { assignee: { id: "" } },
        ],
        acknowledgements: [{ acknowledger: { id: "ACK" } }],
      },
    ],
    new Map([["KNOWN", "k@example.com"]]),
  );
  expect(ids.sort()).toEqual(["A1", "ACK", "R9"]);
});
