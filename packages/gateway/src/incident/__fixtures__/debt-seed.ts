import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  upsertGraphEntity,
  upsertGraphEntityNamespaced,
  upsertGraphRelation,
} from "../../graph/relationship-graph.ts";
import { fileExternalId } from "../../ownership/ownership-pass.ts";
import { recordPrChangedFiles } from "../../prfiles/pr-changed-file-store.ts";
import type { IncidentRecordV1 } from "../incident-record-types.ts";
import { upsertIncidentRecord } from "../incident-store.ts";
import { resolverFor, serviceConfig, writeMergedPr } from "./index-writers.ts";
import { buildRecord } from "./record-builder.ts";

/**
 * Seeds for the technical-debt tests (IC7b): the graph a workspace, a repo, files and symbols make, and an
 * incident record whose change lane names a pull request with indexed files. Written through the real graph,
 * pull-request-file and incident stores.
 */

export const DEBT_DAY = 86_400_000;
export const DEBT_NOW = Date.parse("2026-11-17T12:00:00Z");
export const DEBT_ROOT = resolve("/work/web");
export const DEBT_REPO = "acme/web";

/** `workspace --tracks_remote--> repo`, the file entities and the symbols defined in them (graph writers). */
export function seedGraph(
  d: Database,
  args: { root?: string; repo?: string; files: Record<string, string[]> },
): void {
  const root = args.root ?? DEBT_ROOT;
  const repo = args.repo ?? `github:${DEBT_REPO}`;
  const ws = upsertGraphEntityNamespaced(d, {
    type: "workspace",
    externalId: `filesystem:${root}`,
    label: root,
    service: "filesystem",
    writer: "symbols",
    metadata: {},
  });
  const repoId = upsertGraphEntityNamespaced(d, {
    type: "repo",
    externalId: repo,
    label: repo,
    service: "github",
    writer: "ownership",
    metadata: {},
  });
  upsertGraphRelation(d, ws, repoId, "tracks_remote", 0);
  for (const [file, names] of Object.entries(args.files)) {
    const fid = upsertGraphEntityNamespaced(d, {
      type: "source_file",
      externalId: fileExternalId(root, file),
      label: file,
      service: "filesystem",
      writer: "symbols",
      metadata: {},
    });
    for (const n of names) {
      const sid = upsertGraphEntity(d, {
        type: "symbol",
        externalId: `sym:${root}:${file}:${n}`,
        label: `${n} \u2014 ${file}`,
        service: "filesystem",
        metadata: { file, name: n, repoRoot: root },
      });
      upsertGraphRelation(d, sid, fid, "defined_in", 0);
    }
  }
}

let seq = 0;
/** An incident record whose change lane names `prNumber`'s PR, with that PR's changed files indexed. */
export function incident(
  d: Database,
  args: { pr: number; files?: string[]; openedAtMs?: number; title?: string; status?: "removed" },
): string {
  seq += 1;
  const prId = writeMergedPr(d, resolverFor(serviceConfig()), { number: args.pr, repo: DEBT_REPO });
  if (args.files !== undefined) {
    recordPrChangedFiles(d, {
      itemId: prId,
      repoFull: DEBT_REPO,
      files: args.files.map((path) => ({
        path,
        status: args.status ?? "modified",
        counterpartPath: null,
      })),
      apiFileCount: args.files.length,
      truncated: false,
      nowMs: DEBT_NOW,
    });
  }
  const base = buildRecord({
    itemId: `pagerduty:PD${String(seq)}`,
    title: args.title ?? `Incident ${String(seq)}`,
    openedAtMs: args.openedAtMs ?? DEBT_NOW - 10 * DEBT_DAY,
  });
  const record: IncidentRecordV1 = {
    ...base,
    change: {
      ...base.change,
      pr: {
        id: prId,
        title: "pr",
        url: null,
        service: "github",
        mergedAtMs: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        rule: "merge_commit_sha",
      },
    },
  };
  return upsertIncidentRecord(d, {
    record,
    markdown: "md",
    recordSha256: `h${String(seq)}`,
    citedServices: ["pagerduty"],
    nowMs: DEBT_NOW,
  }).recordId;
}
