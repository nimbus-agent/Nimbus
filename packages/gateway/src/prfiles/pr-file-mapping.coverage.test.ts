/**
 * The defensive arms of the three changed-file mappers: entries that are not objects, missing or
 * empty paths and statuses, and "renames" that do not actually name two different paths. Each of
 * these reaches the mappers from a forge API payload, so every one is a shape a real response can
 * take — and a wrong answer here is a false "this PR does not touch X".
 */
import { describe, expect, test } from "bun:test";
import { mapBitbucketPrFiles, mapGithubPrFiles, mapGitlabMrFiles } from "./pr-file-mapping.ts";

const NOT_OBJECTS = [null, 7, "src/a.ts", ["src/b.ts"], true];

describe("mapGithubPrFiles", () => {
  test("entries that are not objects are skipped", () => {
    expect(mapGithubPrFiles([...NOT_OBJECTS, { filename: "src/ok.ts", status: "added" }])).toEqual([
      { path: "src/ok.ts", status: "added", counterpartPath: null },
    ]);
  });

  test("an empty filename is skipped; a missing or unknown status reads as modified", () => {
    expect(
      mapGithubPrFiles([
        { filename: "", status: "added" },
        { filename: "src/plain.ts" },
        { filename: "src/odd.ts", status: "unchanged" },
        { filename: "src/gone.ts", status: "removed" },
      ]),
    ).toEqual([
      { path: "src/plain.ts", status: "modified", counterpartPath: null },
      { path: "src/odd.ts", status: "modified", counterpartPath: null },
      { path: "src/gone.ts", status: "removed", counterpartPath: null },
    ]);
  });

  test("a rename with no usable previous_filename is one renamed row with no counterpart", () => {
    expect(
      mapGithubPrFiles([
        { filename: "src/n.ts", status: "renamed" },
        { filename: "src/m.ts", status: "renamed", previous_filename: "" },
        { filename: "src/k.ts", status: "renamed", previous_filename: 42 },
      ]),
    ).toEqual([
      { path: "src/n.ts", status: "renamed", counterpartPath: null },
      { path: "src/m.ts", status: "renamed", counterpartPath: null },
      { path: "src/k.ts", status: "renamed", counterpartPath: null },
    ]);
  });
});

describe("mapGitlabMrFiles", () => {
  test("entries that are not objects, or that name no path at all, are skipped", () => {
    expect(mapGitlabMrFiles([...NOT_OBJECTS, {}, { old_path: "", new_path: "" }])).toEqual([]);
  });

  test("a deletion with only old_path keeps that path; an addition with only new_path keeps that one", () => {
    expect(
      mapGitlabMrFiles([
        { old_path: "tests/gone.ts", deleted_file: true },
        { new_path: "src/new.ts", new_file: true },
      ]),
    ).toEqual([
      { path: "tests/gone.ts", status: "removed", counterpartPath: null },
      { path: "src/new.ts", status: "added", counterpartPath: null },
    ]);
  });

  test("a renamed_file whose paths do not differ, or lack one side, is a single row", () => {
    expect(
      mapGitlabMrFiles([
        { old_path: "src/same.ts", new_path: "src/same.ts", renamed_file: true },
        { old_path: "", new_path: "src/half.ts", renamed_file: true },
        { old_path: "src/other.ts", renamed_file: true },
        // `"true"` is not `true`: a string flag does not make a rename.
        { old_path: "src/x.ts", new_path: "src/y.ts", renamed_file: "true" },
      ]),
    ).toEqual([
      { path: "src/same.ts", status: "modified", counterpartPath: null },
      { path: "src/half.ts", status: "modified", counterpartPath: null },
      { path: "src/other.ts", status: "modified", counterpartPath: null },
      { path: "src/y.ts", status: "modified", counterpartPath: null },
    ]);
  });
});

describe("mapBitbucketPrFiles", () => {
  test("a payload that is not an object, or whose values is not an array, yields no rows", () => {
    expect(mapBitbucketPrFiles(null)).toEqual([]);
    expect(mapBitbucketPrFiles([{ values: [] }])).toEqual([]);
    expect(mapBitbucketPrFiles({ values: { 0: {} } })).toEqual([]);
  });

  test("entries that are not objects, or whose sides carry no path, are skipped", () => {
    expect(
      mapBitbucketPrFiles({
        values: [
          ...NOT_OBJECTS,
          { status: "modified", old: "src/a.ts", new: ["src/a.ts"] },
          { status: "modified", old: {}, new: { path: 5 } },
          { status: "added", old: null, new: { path: "src/kept.ts" } },
        ],
      }),
    ).toEqual([{ path: "src/kept.ts", status: "added", counterpartPath: null }]);
  });

  test("a missing status reads as modified; an unknown one does too", () => {
    expect(
      mapBitbucketPrFiles({
        values: [
          { old: { path: "src/a.ts" }, new: { path: "src/a.ts" } },
          { status: "merge conflict", old: { path: "src/b.ts" }, new: { path: "src/b.ts" } },
          { status: "removed", old: { path: "src/c.ts" }, new: null },
        ],
      }),
    ).toEqual([
      { path: "src/a.ts", status: "modified", counterpartPath: null },
      { path: "src/b.ts", status: "modified", counterpartPath: null },
      { path: "src/c.ts", status: "removed", counterpartPath: null },
    ]);
  });

  test("a renamed entry whose paths do not differ, or lack one side, is a single modified row", () => {
    expect(
      mapBitbucketPrFiles({
        values: [
          { status: "renamed", old: { path: "src/same.ts" }, new: { path: "src/same.ts" } },
          { status: "renamed", old: null, new: { path: "src/only-new.ts" } },
          { status: "renamed", old: { path: "src/only-old.ts" }, new: null },
        ],
      }),
    ).toEqual([
      { path: "src/same.ts", status: "modified", counterpartPath: null },
      { path: "src/only-new.ts", status: "modified", counterpartPath: null },
      { path: "src/only-old.ts", status: "modified", counterpartPath: null },
    ]);
  });
});
