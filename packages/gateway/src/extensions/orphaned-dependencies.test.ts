import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { insertExtensionRow, setInstalledAsDependency } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { clearDeps, recordInstall } from "./dependency-store.ts";
import { orphanedAfterEdgeChange, orphanedDependencies } from "./orphaned-dependencies.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function add(
  db: Database,
  id: string,
  opts: { asDependency?: boolean; kind?: "extension" | "starter-pack" } = {},
): void {
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: `/p/${id}`,
    manifest_hash: "deadbeef",
    entry_hash: "beefcafe",
    installed_at: 1,
    last_verified_at: 1,
    kind: opts.kind ?? "extension",
  });
  if (opts.asDependency === true) setInstalledAsDependency(db, id, true);
}

function deps(db: Database, id: string, on: readonly string[]): void {
  recordInstall(
    db,
    id,
    "1.0.0",
    on.map((d) => ({ id: d, range: "^1.0.0", resolvedVersion: "1.0.0", registry: null })),
    1,
  );
}

describe("orphanedDependencies", () => {
  test("removing a pack lists its dependency-installed members", () => {
    const db = freshDb();
    add(db, "pack", { kind: "starter-pack" });
    add(db, "m.b", { asDependency: true });
    add(db, "m.a", { asDependency: true });
    deps(db, "pack", ["m.b", "m.a"]);
    expect(orphanedDependencies(db, "pack").sort((a, b) => a.localeCompare(b))).toEqual([
      "m.a",
      "m.b",
    ]);
  });

  test("shared member is not orphaned", () => {
    const db = freshDb();
    add(db, "pack1", { kind: "starter-pack" });
    add(db, "pack2", { kind: "starter-pack" });
    add(db, "shared", { asDependency: true });
    add(db, "only1", { asDependency: true });
    deps(db, "pack1", ["shared", "only1"]);
    deps(db, "pack2", ["shared"]);
    expect(orphanedDependencies(db, "pack1")).toEqual(["only1"]);
  });

  test("an explicitly installed member is never offered", () => {
    const db = freshDb();
    add(db, "pack", { kind: "starter-pack" });
    add(db, "explicit");
    add(db, "dep", { asDependency: true });
    deps(db, "pack", ["explicit", "dep"]);
    // `explicit`'s own dependency stays too: `explicit` is not being removed.
    add(db, "under.explicit", { asDependency: true });
    deps(db, "explicit", ["under.explicit"]);
    expect(orphanedDependencies(db, "pack")).toEqual(["dep"]);
  });

  test("an explicitly installed sub-pack is never offered, nor its members", () => {
    const db = freshDb();
    add(db, "outer", { kind: "starter-pack" });
    add(db, "inner", { kind: "starter-pack" });
    add(db, "inner.member", { asDependency: true });
    deps(db, "outer", ["inner"]);
    deps(db, "inner", ["inner.member"]);
    expect(orphanedDependencies(db, "outer")).toEqual([]);
  });

  test("pack of packs is walked transitively, dependents first", () => {
    const db = freshDb();
    add(db, "outer", { kind: "starter-pack" });
    add(db, "inner", { kind: "starter-pack", asDependency: true });
    add(db, "code.a", { asDependency: true });
    add(db, "code.b", { asDependency: true });
    add(db, "lib", { asDependency: true });
    deps(db, "outer", ["inner", "code.b"]);
    deps(db, "inner", ["code.a"]);
    deps(db, "code.a", ["lib"]);
    deps(db, "code.b", ["lib"]);
    const out = orphanedDependencies(db, "outer");
    expect(out.sort((a, b) => a.localeCompare(b))).toEqual(["code.a", "code.b", "inner", "lib"]);
    const ordered = orphanedDependencies(db, "outer");
    const at = (id: string): number => ordered.indexOf(id);
    expect(at("inner")).toBeLessThan(at("code.a"));
    expect(at("code.a")).toBeLessThan(at("lib"));
    expect(at("code.b")).toBeLessThan(at("lib"));
  });

  test("a deep dependency shared with an outside extension stays", () => {
    const db = freshDb();
    add(db, "pack", { kind: "starter-pack" });
    add(db, "mid", { asDependency: true });
    add(db, "lib", { asDependency: true });
    add(db, "other");
    deps(db, "pack", ["mid"]);
    deps(db, "mid", ["lib"]);
    deps(db, "other", ["lib"]);
    expect(orphanedDependencies(db, "pack")).toEqual(["mid"]);
  });

  test("after --force, orphans are computed over the remaining graph", () => {
    const db = freshDb();
    // `pack` needs `member`; `member` alone needs `lib`. `member` is force-removed.
    add(db, "pack", { kind: "starter-pack" });
    add(db, "member", { asDependency: true });
    add(db, "lib", { asDependency: true });
    add(db, "sibling", { asDependency: true });
    deps(db, "pack", ["member", "sibling"]);
    deps(db, "member", ["lib"]);
    expect(orphanedDependencies(db, "member")).toEqual(["lib"]);

    // The force removal itself: the row and its forward edges go; pack -> member dangles.
    db.run("DELETE FROM extension WHERE id = 'member'");
    clearDeps(db, "member");
    db.run("DELETE FROM extension WHERE id = 'lib'");
    clearDeps(db, "lib");

    // Removing the pack later offers only what is still installed and needed by nothing else.
    expect(orphanedDependencies(db, "pack")).toEqual(["sibling"]);
  });

  test("a dependency cycle between dependency-installed packages is kept", () => {
    const db = freshDb();
    add(db, "root");
    add(db, "x", { asDependency: true });
    add(db, "y", { asDependency: true });
    deps(db, "root", ["x"]);
    deps(db, "x", ["y"]);
    deps(db, "y", ["x"]);
    expect(orphanedDependencies(db, "root")).toEqual([]);
  });

  test("an extension with no dependencies orphans nothing", () => {
    const db = freshDb();
    add(db, "solo");
    expect(orphanedDependencies(db, "solo")).toEqual([]);
  });
});

describe("orphanedAfterEdgeChange", () => {
  test("a dropped dependency-installed package and its own sole dependency, dependents first", () => {
    const db = freshDb();
    add(db, "root");
    add(db, "a", { asDependency: true });
    add(db, "b", { asDependency: true });
    add(db, "c", { asDependency: true });
    deps(db, "a", ["b"]);
    // The rewritten edges: root now depends on c only.
    deps(db, "root", ["c"]);
    expect(orphanedAfterEdgeChange(db, "root", ["a"])).toEqual(["a", "b"]);
  });

  test("never an explicitly installed, still-needed or kept package", () => {
    const db = freshDb();
    add(db, "root");
    add(db, "explicit");
    add(db, "shared", { asDependency: true });
    add(db, "other");
    deps(db, "other", ["shared"]);
    add(db, "loop", { asDependency: true });
    add(db, "root2", { asDependency: true });
    deps(db, "loop", ["root2"]);
    deps(db, "root", []);
    expect(orphanedAfterEdgeChange(db, "root", ["explicit", "shared", "gone"])).toEqual([]);
    // `root2` would follow from `loop`, but the dependent itself is never listed.
    expect(orphanedAfterEdgeChange(db, "root2", ["loop"])).toEqual(["loop"]);
  });

  test("two dropped packages, one depending on the other, come out dependents first", () => {
    const db = freshDb();
    add(db, "root");
    add(db, "a", { asDependency: true });
    add(db, "z", { asDependency: true });
    deps(db, "z", ["a"]);
    deps(db, "root", []);
    expect(orphanedAfterEdgeChange(db, "root", ["a", "z"])).toEqual(["z", "a"]);
  });
});
