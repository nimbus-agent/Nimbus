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
