import { expect, test } from "bun:test";

import { extractIssueRefs } from "./graph-refs.ts";

test("extracts GitHub-style numeric issue references", () => {
  expect(extractIssueRefs("closes #4 and fixes #17")).toEqual({
    numeric: [4, 17],
    ticketKeys: [],
  });
});

test("extracts ticket keys", () => {
  expect(extractIssueRefs("part of NIM-88, follows ABC-7")).toEqual({
    numeric: [],
    ticketKeys: ["NIM-88", "ABC-7"],
  });
});

test("deduplicates and preserves first-seen order", () => {
  expect(extractIssueRefs("#4 #4 NIM-1 NIM-1 #9")).toEqual({
    numeric: [4, 9],
    ticketKeys: ["NIM-1"],
  });
});

test("ignores lowercase and over-long keys that are not ticket keys", () => {
  expect(extractIssueRefs("abc-1 and VERYLONGPROJECT-2")).toEqual({
    numeric: [],
    ticketKeys: [],
  });
});

test("ignores a bare hash with no digits", () => {
  expect(extractIssueRefs("# heading and #")).toEqual({ numeric: [], ticketKeys: [] });
});

test("handles empty input", () => {
  expect(extractIssueRefs("")).toEqual({ numeric: [], ticketKeys: [] });
});
