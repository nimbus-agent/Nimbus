/**
 * A forge file coordinate, resolved to the reader's own checkout.
 *
 * A browser knows `github.com/acme/web/blob/main/src/foo.ts`. The graph keys files by the
 * LOCAL path they live at — `source_file` external ids are `file:<repoRoot>:<path>` — and
 * `agents/ownership.ts` refuses a path "outside every configured root". So a browser
 * cannot name a file the agents accept, and must not guess: it does not know the reader's
 * filesystem and has no business inventing one.
 *
 * The bridge already exists and nothing exposed it. `ownership-pass.ts`'s `bindRootRemote`
 * writes `workspace --tracks_remote--> repo`, where the workspace is `filesystem:<root>`
 * and the repo is `<service>:<owner>/<name>`. This walks it backwards.
 */
import type { Database } from "bun:sqlite";
import { fileExternalId } from "../ownership/ownership-pass.ts";

export type ResolveFileResult =
  | {
      readonly ok: true;
      readonly fileEntityId: string;
      readonly repoRoot: string;
      readonly path: string;
    }
  | {
      readonly ok: false;
      /**
       * Two situations, never collapsed. `remote_not_tracked` means the reader has no
       * local checkout of this repository at all — permanent, and nothing they can do
       * from the page. `file_not_indexed` means the checkout exists and this path is not
       * in it. Different sentences, different remediations, so the client branches on a
       * value rather than matching prose that a later rewording would break.
       */
      readonly reason: "remote_not_tracked" | "file_not_indexed";
      readonly repo: string;
    };

export type ForgeFileCoordinate = {
  readonly service: string;
  /** `owner/name`, as the forge URL spells it. */
  readonly repo: string;
  /**
   * Everything after `/blob/` (or Bitbucket's `/src/`) — ref AND path together, still
   * joined.
   *
   * Deliberately not split by the caller. A branch name may contain slashes, so
   * `feat/auth-v2/src/foo.ts` is ambiguous without the repository's branch list, which a
   * browser would have to make a forge API call to learn. This side holds the file list
   * instead, so it can simply try the splits.
   */
  readonly refAndPath: string;
};

/** Rows of one workspace tracking the requested remote. */
type WorkspaceRow = { external_id: string };

/**
 * POSIX separators, because that is what the forge sends and what the indexer stores in a
 * `source_file` label. `repoRoot` keeps its native shape (it is a real local path and is
 * compared to nothing), so a Windows root and a POSIX request still meet at the path.
 */
function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

export function resolveFileByRemote(db: Database, input: ForgeFileCoordinate): ResolveFileResult {
  const wantedRepo = `${input.service}:${input.repo}`;

  // Case-insensitive, and NOT by rewriting stored ids. `parseRemoteUrl` lower-cases the
  // host but returns `ownerName` verbatim, so a checkout cloned from `github.com/ACME/Web`
  // stores `github:ACME/Web` while the address bar yields `github:acme/web`. Lower-casing
  // the stored id would change existing `graph_entity` external ids and need a migration,
  // for a problem a comparison solves.
  const workspaces = db
    .query(
      `SELECT w.external_id AS external_id
         FROM graph_entity r
         JOIN graph_relation tr ON tr.to_id = r.id AND tr.type = 'tracks_remote'
         JOIN graph_entity w    ON w.id = tr.from_id AND w.type = 'workspace'
        WHERE r.type = 'repo' AND LOWER(r.external_id) = LOWER(?)
        ORDER BY w.external_id ASC`,
    )
    .all(wantedRepo) as WorkspaceRow[];

  if (workspaces.length === 0) {
    return { ok: false, reason: "remote_not_tracked", repo: input.repo };
  }

  const remainder = toPosix(input.refAndPath);
  const segments = remainder.split("/").filter((s) => s !== "");

  // Shortest ref first: try `<seg0>` as the ref, then `<seg0>/<seg1>`, and so on. One
  // extra probe per segment, against an already-scoped set — and it terminates at the
  // last segment, since a path needs at least one of its own.
  const candidatePaths: string[] = [];
  for (let refLen = 1; refLen < segments.length; refLen += 1) {
    candidatePaths.push(segments.slice(refLen).join("/"));
  }

  // Every (root, candidate path) hit, so ties can be broken deliberately rather than by
  // whichever row SQLite happened to return first.
  const hits: Array<{ fileEntityId: string; repoRoot: string; path: string; updatedAt: number }> =
    [];

  for (const ws of workspaces) {
    // `filesystem:<root>` — the external id the ownership pass writes.
    const repoRoot = ws.external_id.startsWith("filesystem:")
      ? ws.external_id.slice("filesystem:".length)
      : ws.external_id;

    for (const path of candidatePaths) {
      // The WRITER's own formatter, imported rather than re-derived: `ownership-pass.ts`
      // and `syncCodeSymbolGraph` already build this string byte-identically, and a third
      // copy here would be a third thing to keep in step.
      const externalId = fileExternalId(repoRoot, path);
      const row = db
        .query(
          `SELECT e.id AS id, COALESCE(MAX(r.created_at), 0) AS created_at
             FROM graph_entity e
             LEFT JOIN graph_relation r ON r.from_id = e.id
            WHERE e.type = 'source_file' AND e.external_id = ?
            GROUP BY e.id
            LIMIT 1`,
        )
        .get(externalId) as { id?: string; created_at?: number } | null;
      if (row?.id !== undefined) {
        hits.push({
          fileEntityId: row.id,
          repoRoot,
          path,
          updatedAt: row.created_at ?? 0,
        });
      }
    }
  }

  if (hits.length === 0) {
    return { ok: false, reason: "file_not_indexed", repo: input.repo };
  }

  // Most recently touched wins — with a worktree per branch, that is the checkout the
  // reader is actually working in. `fileEntityId` breaks the tie after it, so the same URL
  // cannot answer differently on two consecutive calls.
  hits.sort((a, b) =>
    b.updatedAt !== a.updatedAt
      ? b.updatedAt - a.updatedAt
      : a.fileEntityId.localeCompare(b.fileEntityId),
  );
  const best = hits[0];
  if (best === undefined) {
    return { ok: false, reason: "file_not_indexed", repo: input.repo };
  }
  return {
    ok: true,
    fileEntityId: best.fileEntityId,
    repoRoot: best.repoRoot,
    path: best.path,
  };
}
