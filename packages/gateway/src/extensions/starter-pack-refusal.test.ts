import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type ExtensionKind, insertExtensionRow } from "../automation/extension-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { recordInstall } from "./dependency-store.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import {
  refuseStarterPack,
  starterPackCodeMembers,
  starterPackRefusalMessage,
} from "./starter-pack-refusal.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

afterEach(() => {
  db.close();
});

/** A row (no files: the walk reads rows and edges only) and its recorded dependency edges. */
function pkg(id: string, kind: ExtensionKind, deps: readonly string[] = []): void {
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: `/nowhere/${id}`,
    manifest_hash: "m",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
    kind,
  });
  recordInstall(
    db,
    id,
    "1.0.0",
    deps.map((d) => ({ id: d, range: "^1.0.0", resolvedVersion: "1.0.0", registry: null })),
    1,
  );
}

describe("starterPackCodeMembers", () => {
  test("a diamond lists the shared code member once", () => {
    pkg("code.a", "extension");
    pkg("code.b", "extension");
    pkg("pack.sub", "starter-pack", ["code.a", "code.b"]);
    // code.a is reached directly and again through pack.sub.
    pkg("pack.top", "starter-pack", ["code.a", "pack.sub"]);
    expect(starterPackCodeMembers(db, "pack.top")).toEqual(["code.a", "code.b"]);
  });

  test("an edge to an id with no row is skipped", () => {
    pkg("code.a", "extension");
    pkg("pack.top", "starter-pack", ["code.a", "code.gone"]);
    expect(starterPackCodeMembers(db, "pack.top")).toEqual(["code.a"]);
  });

  test("a cycle back to the pack does not loop", () => {
    pkg("code.a", "extension");
    pkg("pack.sub", "starter-pack", ["pack.top", "code.a"]);
    pkg("pack.top", "starter-pack", ["pack.sub"]);
    expect(starterPackCodeMembers(db, "pack.top")).toEqual(["code.a"]);
  });

  test("a code member's own dependencies are not members of the pack", () => {
    pkg("code.lib", "extension");
    pkg("code.a", "extension", ["code.lib"]);
    pkg("pack.top", "starter-pack", ["code.a"]);
    expect(starterPackCodeMembers(db, "pack.top")).toEqual(["code.a"]);
  });
});

describe("starterPackRefusalMessage / refuseStarterPack", () => {
  test("names each member's approve command, joined by ' && '", () => {
    pkg("code.a", "extension");
    pkg("code.b", "extension");
    pkg("pack.top", "starter-pack", ["code.b", "code.a"]);
    expect(starterPackRefusalMessage(db, "pack.top")).toBe(
      "pack.top is a starter pack: it has no code to run. Approve its members instead: nimbus extension approve code.a && nimbus extension approve code.b",
    );
  });

  test("a pack with no code members gets the short copy", () => {
    pkg("pack.top", "starter-pack");
    expect(starterPackRefusalMessage(db, "pack.top")).toBe(
      "pack.top is a starter pack: it has no code to run.",
    );
  });

  test("refuses a pack row with ERR_EXTENSION_STARTER_PACK and passes a code row", () => {
    pkg("pack.top", "starter-pack");
    let caught: unknown;
    try {
      refuseStarterPack(db, { id: "pack.top", kind: "starter-pack" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtensionRunGrantError);
    expect((caught as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_STARTER_PACK");
    expect(() => refuseStarterPack(db, { id: "code.a", kind: "extension" })).not.toThrow();
    expect(() => refuseStarterPack(db, { id: "code.b" })).not.toThrow();
  });
});
