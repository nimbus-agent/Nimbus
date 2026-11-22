import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "../ipc/agents-rpc.ts";

describe("I36 — a browser-reachable file question never reaches the federation", () => {
  // BEHAVIOURAL, not an import check: the finding that prompted this asked for the guard's
  // behaviour to be verified, and a grep would pass against a guard that read the value and
  // threw nothing. `agents.ghost` and `agents.conflicts` fan out whenever `namespaces` is
  // non-empty, and the forge shape is what a browser — HTTP, `agents` scope — can produce.
  const COORD = { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" };

  function dbWithCheckout(): Database {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('ws:/r', 'workspace', 'filesystem:/r', '/r', 'filesystem', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('repo:g', 'repo', 'github:acme/web', 'acme/web', 'github', '{}')",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES ('ws:/r', 'repo:g', 'tracks_remote', 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('file:/r:src/foo.ts', 'source_file', 'file:/r:src/foo.ts', 'src/foo.ts', 'filesystem', '{}')",
    );
    return db;
  }

  test("a forge coordinate carrying namespaces is REFUSED, and nothing goes over the wire", async () => {
    const db = dbWithCheckout();
    let sent = 0;
    const ctx = {
      db,
      notify: () => {},
      sendOverWire: () => {
        sent += 1;
        return Promise.resolve(null);
      },
    } as unknown as Parameters<typeof dispatchAgentsRpc>[2];

    for (const method of ["agents.ghost", "agents.conflicts"]) {
      // Both spellings the parser accepts.
      for (const extra of [{ namespaces: ["peer-1"] }, { namespace: "peer-1" }]) {
        await expect(dispatchAgentsRpc(method, { ...COORD, ...extra }, ctx)).rejects.toThrow(
          /locally only/,
        );
      }
    }
    expect(sent).toBe(0);
  });

  test("the bound is on the SHAPE: a local path with namespaces is ACCEPTED", async () => {
    // What this proves, exactly: the refusal is scoped to the forge shape, so a terminal
    // caller naming a path on their own disk may still ask for federation.
    //
    // It does NOT prove the namespaces stay active downstream, and it deliberately does
    // not try. Measured rather than assumed: dispatching this with a `sendOverWire` spy
    // records ZERO wire calls, because fan-out additionally needs a KnownNamespaceStore,
    // a self identity and an index that this context does not build. Asserting "one wire
    // call" here would fail against correct code. That property belongs to `ghost`'s own
    // federation tests, where the fixture exists; the invariant this block guards is the
    // shape distinction, and that is what is asserted.
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const out = await dispatchAgentsRpc(
      "agents.ghost",
      { file: "src/foo.ts", namespaces: ["peer-1"] },
      { db, notify: () => {} } as unknown as Parameters<typeof dispatchAgentsRpc>[2],
    );
    expect(out.kind).toBe("hit");
  });
});
