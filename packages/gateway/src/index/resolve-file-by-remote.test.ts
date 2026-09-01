import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "./local-index.ts";
import { resolveFileByRemote } from "./resolve-file-by-remote.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/**
 * The bridge this resolver walks, as the ownership pass and the symbol sync write it:
 *
 *   workspace(filesystem:<root>) --tracks_remote--> repo(<service>:<owner>/<name>)
 *   source_file(file:<root>:<path>)
 *
 * Seeded by hand rather than by running the passes: those need a real git checkout and a
 * spawn seam, and the traversal under test is the same either way.
 */
function seedTrackedRepo(
  db: Database,
  args: { remote: string; root: string; files: readonly string[] },
): void {
  const wsId = `ws:${args.root}`;
  const repoId = `repo:${args.remote}`;
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'workspace', ?, ?, 'filesystem', '{}')",
    [wsId, `filesystem:${args.root}`, args.root],
  );
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'repo', ?, ?, 'github', '{}')",
    [repoId, args.remote, args.remote.split(":")[1] ?? ""],
  );
  db.run(
    "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'tracks_remote', 0)",
    [wsId, repoId],
  );
  for (const f of args.files) {
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'source_file', ?, ?, 'filesystem', '{}')",
      [`file:${args.root}:${f}`, `file:${args.root}:${f}`, f],
    );
  }
}

describe("resolveFileByRemote", () => {
  test("walks remote -> workspace -> source_file", () => {
    const db = freshDb();
    seedTrackedRepo(db, { remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
    const r = resolveFileByRemote(db, {
      service: "github",
      repo: "acme/web",
      refAndPath: "main/src/foo.ts",
    });
    expect(r).toMatchObject({ ok: true, repoRoot: "/home/d/web", path: "src/foo.ts" });
  });

  // The reason the client sends an opaque remainder rather than a split path: a branch
  // name may contain slashes, and only the side holding the file list can tell where the
  // ref ends.
  test("a branch name with slashes still finds the file", () => {
    const db = freshDb();
    seedTrackedRepo(db, { remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
    const r = resolveFileByRemote(db, {
      service: "github",
      repo: "acme/web",
      refAndPath: "feat/auth-v2/src/foo.ts",
    });
    expect(r).toMatchObject({ ok: true, path: "src/foo.ts" });
  });

  test("a tag with dots and a bare sha both resolve", () => {
    const db = freshDb();
    seedTrackedRepo(db, { remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
    for (const ref of ["v1.0.0-rc.1", "a1b2c3d4e5f6"]) {
      expect(
        resolveFileByRemote(db, {
          service: "github",
          repo: "acme/web",
          refAndPath: `${ref}/src/foo.ts`,
        }),
      ).toMatchObject({ ok: true, path: "src/foo.ts" });
    }
  });

  // `parseRemoteUrl` lower-cases the HOST but returns `ownerName` verbatim, so a checkout
  // cloned from `github.com/ACME/Web` stores a differently-cased id than the browser's
  // address bar produces.
  test("remote casing does not decide the answer", () => {
    const db = freshDb();
    seedTrackedRepo(db, { remote: "github:ACME/Web", root: "/home/d/web", files: ["src/foo.ts"] });
    expect(
      resolveFileByRemote(db, {
        service: "github",
        repo: "acme/web",
        refAndPath: "main/src/foo.ts",
      }),
    ).toMatchObject({ ok: true });
  });

  test("the two misses are distinguishable", () => {
    const empty = freshDb();
    expect(
      resolveFileByRemote(empty, {
        service: "github",
        repo: "acme/web",
        refAndPath: "main/a.ts",
      }),
    ).toMatchObject({ ok: false, reason: "remote_not_tracked" });

    const tracked = freshDb();
    seedTrackedRepo(tracked, {
      remote: "github:acme/web",
      root: "/home/d/web",
      files: ["src/foo.ts"],
    });
    expect(
      resolveFileByRemote(tracked, {
        service: "github",
        repo: "acme/web",
        refAndPath: "main/nope.ts",
      }),
    ).toMatchObject({ ok: false, reason: "file_not_indexed" });
  });

  // With git worktrees this is the common case, not the edge case.
  test("two worktrees on one remote resolve to the one that has the file, stably", () => {
    const db = freshDb();
    seedTrackedRepo(db, { remote: "github:acme/web", root: "/home/d/web", files: [] });
    // A second workspace tracking the SAME repo entity.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('ws:/home/d/hot', 'workspace', 'filesystem:/home/d/hot', '/home/d/hot', 'filesystem', '{}')",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES ('ws:/home/d/hot', 'repo:github:acme/web', 'tracks_remote', 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('file:/home/d/hot:src/foo.ts', 'source_file', 'file:/home/d/hot:src/foo.ts', 'src/foo.ts', 'filesystem', '{}')",
    );

    const first = resolveFileByRemote(db, {
      service: "github",
      repo: "acme/web",
      refAndPath: "main/src/foo.ts",
    });
    const second = resolveFileByRemote(db, {
      service: "github",
      repo: "acme/web",
      refAndPath: "main/src/foo.ts",
    });
    expect(first).toMatchObject({ ok: true, repoRoot: "/home/d/hot" });
    // Stable, not arbitrary: the same URL must not answer differently on consecutive calls.
    expect(second).toEqual(first);
  });

  test("a Windows root and a POSIX request meet", () => {
    const db = freshDb();
    seedTrackedRepo(db, {
      remote: "github:acme/web",
      root: "C:\\gitrep\\web",
      files: ["src/foo.ts"],
    });
    expect(
      resolveFileByRemote(db, {
        service: "github",
        repo: "acme/web",
        refAndPath: "main/src/foo.ts",
      }),
    ).toMatchObject({ ok: true, path: "src/foo.ts" });
  });

  test("a path that matches no split reports file_not_indexed, not a wrong file", () => {
    const db = freshDb();
    seedTrackedRepo(db, { remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
    expect(
      resolveFileByRemote(db, {
        service: "github",
        repo: "acme/web",
        refAndPath: "main/src/does-not-exist.ts",
      }),
    ).toMatchObject({ ok: false, reason: "file_not_indexed" });
  });
});
