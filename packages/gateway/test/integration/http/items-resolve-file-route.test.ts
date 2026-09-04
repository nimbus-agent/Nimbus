/**
 * End-to-end tests for `GET /v1/items/resolve-file` — the forge-coordinate read the browser
 * client's C7 file lanes are gated on. Sibling of `items-resolve-route.test.ts`: same harness,
 * same inline-bearer-read seam, same `resolve` scope.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
// `startServerWithoutClipsVault` is deliberately NOT imported yet: Task 2 adds it together with
// the test that uses it. Biome fails an unused import, so Step 7's lint would go red here.
import { startServerWithClipToken } from "../../../src/ipc/http-api-test-server.ts";

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
});
