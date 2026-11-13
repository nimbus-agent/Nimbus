import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proposalsWaitingToast } from "./capture-toast.ts";

test("one waiting proposal reads in the singular", () => {
  expect(proposalsWaitingToast(1)).toEqual({
    title: "Nimbus: agent proposals waiting",
    body: "1 agent proposal waiting. Review with: nimbus approvals",
  });
});

test("several read in the plural", () => {
  expect(proposalsWaitingToast(7).body).toBe(
    "7 agent proposals waiting. Review with: nimbus approvals",
  );
});

test("the only parameter is a number: a string cannot reach the toast", () => {
  // @ts-expect-error a request-derived string is not a number
  proposalsWaitingToast("slack.message.post: hi");
  expect(proposalsWaitingToast.length).toBe(1);
});

test("the module imports nothing: no request-derived text can enter by another route", () => {
  const src = readFileSync(join(import.meta.dir, "capture-toast.ts"), "utf8");
  expect(src).not.toMatch(/^import /m);
});
