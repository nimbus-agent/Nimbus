import { expect, test } from "bun:test";

import { itemPrimaryKey } from "../index/item-key.ts";
import { storedRunIsUnfinished } from "./ci-run-refresh.ts";

const meta =
  (json: string | null) =>
  (_id: string): string | null =>
    json;

test("a stored run whose canonical conclusion is running is unfinished", () => {
  expect(
    storedRunIsUnfinished(
      meta(JSON.stringify({ conclusion: "running" })),
      "github_actions",
      "a/b#run-1",
    ),
  ).toBe(true);
});

test("finished, unknown, missing and malformed rows are not", () => {
  for (const json of [
    JSON.stringify({ conclusion: "failure" }),
    JSON.stringify({ conclusion: "unknown" }),
    JSON.stringify({}),
    "not json",
    null,
  ]) {
    expect(storedRunIsUnfinished(meta(json), "github_actions", "a/b#run-1")).toBe(false);
  }
});

test("it looks up the row by the same primary key the writer uses", () => {
  let asked = "";
  storedRunIsUnfinished(
    (id) => {
      asked = id;
      return null;
    },
    "jenkins",
    "job#7",
  );
  expect(asked).toBe(itemPrimaryKey("jenkins", "job#7"));
});
