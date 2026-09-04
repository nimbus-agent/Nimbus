/**
 * End-to-end tests for `GET /v1/items/resolve-file` — the forge-coordinate read the browser
 * client's C7 file lanes are gated on. Sibling of `items-resolve-route.test.ts`: same harness,
 * same inline-bearer-read seam, same `resolve` scope.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  startServerWithClipToken,
  startServerWithoutClipsVault,
} from "../../../src/ipc/http-api-test-server.ts";

/**
 * The bridge the route walks, as `ownership-pass.ts` and the symbol sync write it:
 *
 *   workspace(filesystem:<root>) --tracks_remote--> repo(<service>:<owner>/<name>)
 *   source_file(file:<root>:<path>)
 *
 * Seeded by hand rather than by running the passes: those need a real git checkout and a spawn
 * seam, and the traversal under test is the same either way. Duplicated from
 * `src/index/resolve-file-by-remote.test.ts` rather than shared — that copy is file-local and
 * unexported, and promoting a unit test's fixture into an exported cross-boundary helper is a
 * larger change than the twenty lines it saves.
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

/**
 * Built with the SAME serialiser the browser client uses (`gateway-client.ts`'s `getJson` calls
 * `new URLSearchParams(query).toString()`), so these tests exercise the real round-trip rather
 * than a hand-rolled encoding that could agree with a bug on both sides.
 */
function coord(service: string, repo: string, refAndPath: string): string {
  return new URLSearchParams({ service, repo, refAndPath }).toString();
}

function get(port: number, token: string | undefined, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/items/resolve-file?${query}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("GET /v1/items/resolve-file (integration)", () => {
  test("resolves a tracked file, and answers with ONLY ok and path", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/src/foo.ts"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ ok: true, path: "src/foo.ts" });
      // The disclosure guard, as an EXACT key set. `repoRoot` is the reader's local filesystem
      // path and must never cross this boundary; an exact set also fails on a field a later edit
      // adds that nobody has thought of yet, which "no repoRoot key" would not.
      expect(Object.keys(body).sort()).toEqual(["ok", "path"]);
    } finally {
      stop();
    }
  });

  test.each(["service", "repo", "refAndPath"])(
    "400s when %s is blank, rather than answering a coordinate it was not given",
    async (blank) => {
      const { port, token, stop } = await startServerWithClipToken(["resolve"]);
      try {
        const params: Record<string, string> = {
          service: "github",
          repo: "acme/web",
          refAndPath: "main/src/foo.ts",
        };
        params[blank] = "";
        const res = await get(port, token, new URLSearchParams(params).toString());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "missing_coordinate" });
      } finally {
        stop();
      }
    },
  );

  test("401s an unknown token", async () => {
    const { port, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await get(port, "not-a-real-token", coord("github", "acme/web", "main/a.ts"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      stop();
    }
  });

  // A browser paired before scopes existed holds LEGACY_SCOPES = ["clip", "briefs"]. The body's
  // `required` / `granted` are what the panel turns into a `nimbus clip scopes` line, so they are
  // asserted by value, not merely by status.
  test("403s a legacy-scoped token, naming the gap", async () => {
    const { port, token, stop } = await startServerWithClipToken(["clip", "briefs"]);
    try {
      const res = await get(port, token, coord("github", "acme/web", "main/a.ts"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "insufficient_scope",
        required: "resolve",
        granted: ["clip", "briefs"],
      });
    } finally {
      stop();
    }
  });

  // The branch the shipped browser client reads as "this gateway is older than the route": it
  // resolves to `unsupported`, withholds the file lanes and says nothing. It must stay a 404 and
  // must never fall through to the PUBLIC /v1/items/* table.
  test("404s a named refusal when the clips surface is not mounted", async () => {
    const { port, stop } = await startServerWithoutClipsVault();
    try {
      const res = await get(port, undefined, coord("github", "acme/web", "main/a.ts"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "resolve_disabled" });
    } finally {
      stop();
    }
  });

  test("remote_not_tracked when no workspace tracks the remote", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await get(port, token, coord("github", "other/unknown", "main/src/foo.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "remote_not_tracked",
        repo: "other/unknown",
      });
    } finally {
      stop();
    }
  });

  // Asserted separately from the case above, and never folded into one "miss" test: the two are
  // different facts with different remediations, and the panel prints a different sentence for
  // each. Collapsing them is the one thing the client cannot survive.
  test("file_not_indexed when the repo is tracked and the path is not in it", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/src/missing.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "file_not_indexed",
        repo: "acme/web",
      });
    } finally {
      stop();
    }
  });

  // The reason the coordinate crosses the wire UNSPLIT: a branch name may contain slashes, and
  // only the side holding the file list can tell where the ref ends. A browser that tried would
  // have to call the forge to learn the branch list.
  test("a branch name containing slashes still resolves", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "feat/auth-v2/src/foo.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, path: "src/foo.ts" });
    } finally {
      stop();
    }
  });

  // Traversal is a non-issue BY CONSTRUCTION, not by sanitisation: resolution never touches the
  // filesystem, it matches `source_file` external ids in SQLite. A `..` segment simply produces a
  // candidate no indexed entity matches. This test fails the day someone adds path normalisation
  // the route must not have.
  test("a traversal attempt is an ordinary miss, not an error", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/../../secret.txt"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "file_not_indexed",
        repo: "acme/web",
      });
    } finally {
      stop();
    }
  });

  // The space and the `+` are in the FILENAME, not the ref, on purpose: the resolver tries every
  // ref/path split, so a mangled ref would still leave a matching candidate and the test would
  // pass while decoding was broken. Put them in the path and only an exact round-trip resolves.
  // That round-trip holds because both ends use URLSearchParams — the client writes with it
  // (`gateway-client.ts`'s `getJson`), this route reads with it — so a space travels as `+` and a
  // literal `+` as `%2B`.
  test("a path carrying a space and a + survives the round trip", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/my file+v2.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/src/my file+v2.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, path: "src/my file+v2.ts" });
    } finally {
      stop();
    }
  });

  // A GitLab project nests arbitrarily deep, so `repo` ITSELF carries slashes. A different
  // parameter from the slashy ref above and a different risk: `/` has to survive URLSearchParams
  // encoding it as `%2F` and this route decoding it back. A truncated `repo` would answer
  // `remote_not_tracked` and read as an ordinary miss rather than a bug.
  test("a deep GitLab subgroup survives as the repo coordinate", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "gitlab:org/team/subgroup/repo",
        root: "/home/d/sub",
        files: ["src/foo.ts"],
      });
      const res = await get(
        port,
        token,
        coord("gitlab", "org/team/subgroup/repo", "main/src/foo.ts"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, path: "src/foo.ts" });
    } finally {
      stop();
    }
  });

  // Nothing leaves the machine, so nothing belongs in the ledger of what did. Asserted as a
  // DELTA rather than `=== 0`: what must hold is that RESOLVING appends nothing, and a test
  // pinned to an empty table would start failing for an unrelated row the server wrote at boot.
  test("appends no egress row", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const ledgerRows = (): number =>
        (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
      const before = ledgerRows();
      const res = await get(port, token, coord("github", "acme/web", "main/src/foo.ts"));
      expect(res.status).toBe(200);
      expect(ledgerRows()).toBe(before);
    } finally {
      stop();
    }
  });
});
