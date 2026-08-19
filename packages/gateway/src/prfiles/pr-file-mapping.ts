import { asRecord, stringField } from "../connectors/unknown-record.ts";

import type { ChangedFileRow, ChangedFileStatus } from "./pr-changed-file-store.ts";

/**
 * GitHub reports six statuses; we keep four. `copied` and `changed` are both content edits with no
 * distinct meaning for a touch predicate, so they normalise to `modified` rather than widening the
 * union with values nothing branches on.
 */
function normaliseGithubStatus(raw: string): ChangedFileStatus {
  switch (raw) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Map a `pulls/{n}/files` payload to one row per TOUCHED path.
 *
 * A rename yields TWO rows. GitHub reports it as a single entry on the new `filename` with a
 * `previous_filename`, but a PR that renames `tests/a.ts` to `src/a.ts` HAS touched `tests/a.ts` —
 * so a "does not touch tests/" query must not match it. Emitting both paths makes that fall out of
 * a plain membership test instead of requiring every caller to remember a second column.
 *
 * Returns `[]` for any payload that is not an array: an error body (`{"message":"Not Found"}`) must
 * produce no rows rather than throwing into the sync tick.
 */
export function mapGithubPrFiles(payload: unknown): ChangedFileRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: ChangedFileRow[] = [];
  for (const entry of payload) {
    const rec = asRecord(entry);
    if (rec === undefined) {
      continue;
    }
    const path = stringField(rec, "filename");
    if (path === undefined || path === "") {
      continue;
    }
    const status = normaliseGithubStatus(stringField(rec, "status") ?? "modified");
    const previous = stringField(rec, "previous_filename");
    if (status === "renamed" && previous !== undefined && previous !== "") {
      out.push({ path, status: "renamed", counterpartPath: previous });
      out.push({ path: previous, status: "renamed", counterpartPath: path });
      continue;
    }
    out.push({ path, status, counterpartPath: null });
  }
  return out;
}

/** Emit one row per touched path, collapsing a rename's two paths into two rows. */
function pushPair(out: ChangedFileRow[], oldPath: string, newPath: string): void {
  out.push({ path: newPath, status: "renamed", counterpartPath: oldPath });
  out.push({ path: oldPath, status: "renamed", counterpartPath: newPath });
}

/**
 * GitLab reports a change as `old_path`/`new_path` plus three booleans rather than a status
 * string. A rename is the only case where the two paths differ meaningfully, and it emits two
 * rows for the same reason GitHub's does.
 */
export function mapGitlabMrFiles(payload: unknown): ChangedFileRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: ChangedFileRow[] = [];
  for (const entry of payload) {
    const rec = asRecord(entry);
    if (rec === undefined) {
      continue;
    }
    const oldPath = stringField(rec, "old_path") ?? "";
    const newPath = stringField(rec, "new_path") ?? "";
    if (rec["renamed_file"] === true && oldPath !== "" && newPath !== "" && oldPath !== newPath) {
      pushPair(out, oldPath, newPath);
      continue;
    }
    const path = newPath !== "" ? newPath : oldPath;
    if (path === "") {
      continue;
    }
    const status: ChangedFileStatus =
      rec["new_file"] === true ? "added" : rec["deleted_file"] === true ? "removed" : "modified";
    out.push({ path, status, counterpartPath: null });
  }
  return out;
}

function bitbucketSidePath(side: unknown): string {
  const rec = asRecord(side);
  return rec === undefined ? "" : (stringField(rec, "path") ?? "");
}

/**
 * Bitbucket wraps diffstat entries in a paginated `values` envelope and reports each side as an
 * object that is `null` for an add (no `old`) or a delete (no `new`). Reading `.path` off the null
 * side is how an empty-path row would get written, so each side is resolved independently and an
 * empty result is skipped.
 */
export function mapBitbucketPrFiles(payload: unknown): ChangedFileRow[] {
  const rec = asRecord(payload);
  const values = rec?.["values"];
  if (!Array.isArray(values)) {
    return [];
  }
  const out: ChangedFileRow[] = [];
  for (const entry of values) {
    const e = asRecord(entry);
    if (e === undefined) {
      continue;
    }
    const oldPath = bitbucketSidePath(e["old"]);
    const newPath = bitbucketSidePath(e["new"]);
    const raw = stringField(e, "status") ?? "modified";
    if (raw === "renamed" && oldPath !== "" && newPath !== "" && oldPath !== newPath) {
      pushPair(out, oldPath, newPath);
      continue;
    }
    const path = newPath !== "" ? newPath : oldPath;
    if (path === "") {
      continue;
    }
    const status: ChangedFileStatus =
      raw === "added" ? "added" : raw === "removed" ? "removed" : "modified";
    out.push({ path, status, counterpartPath: null });
  }
  return out;
}
