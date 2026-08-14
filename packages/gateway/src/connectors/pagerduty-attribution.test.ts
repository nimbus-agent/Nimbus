import { expect, test } from "bun:test";
import { pagerdutyEmailMapFromIncidents } from "./pagerduty-attribution.ts";

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
