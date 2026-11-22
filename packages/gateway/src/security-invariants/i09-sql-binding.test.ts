import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I9 — bound SQL parameters; identifiers go through escapeIdentifier", () => {
  test("db/write.ts defines the canonical escapeIdentifier (doubles embedded quotes)", async () => {
    const src = await read("packages/gateway/src/db/write.ts");
    expect(src).toMatch(/export function escapeIdentifier\(/);
    expect(src).toMatch(/replaceAll\('"', '""'\)/);
  });

  test("db/repair.ts imports escapeIdentifier from db/write.ts rather than defining its own copy", async () => {
    const src = await read("packages/gateway/src/db/repair.ts");
    // The import must be the SOURCE of the symbol. A regression that re-adds a
    // local `const escapeIdentifier = ...` / `function escapeIdentifier(...)`
    // shadowing definition would still satisfy a bare /escapeIdentifier/ match
    // and a bare /replaceAll\('"', '""'\)/ match (the string would just move
    // with it) — that is precisely the two-copies-of-a-security-primitive
    // drift this consolidation exists to prevent, so this test must fail in
    // that case rather than pass on the name alone.
    expect(src).toMatch(/import \{ dbRun, escapeIdentifier \} from "\.\/write\.ts"/);
    expect(src).toMatch(/escapeIdentifier\(table\)/);
    // The implementation itself must NOT be present in this file.
    expect(src).not.toMatch(/replaceAll\('"', '""'\)/);
    expect(src).not.toMatch(/(?:const|function)\s+escapeIdentifier\s*[=(]/);
  });

  test("connectors/reindex.ts imports escapeIdentifier from db/write.ts rather than defining its own copy", async () => {
    const src = await read("packages/gateway/src/connectors/reindex.ts");
    expect(src).toMatch(/import \{ dbRun, escapeIdentifier \} from "\.\.\/db\/write\.ts"/);
    expect(src).toMatch(/escapeIdentifier\(vecTable\)/);
    expect(src).not.toMatch(/replaceAll\('"', '""'\)/);
    expect(src).not.toMatch(/(?:const|function)\s+escapeIdentifier\s*[=(]/);
  });

  test("search/vec-store.ts imports escapeIdentifier from db/write.ts rather than a raw template literal", async () => {
    const src = await read("packages/gateway/src/search/vec-store.ts");
    // Same shape as reindex.ts: dims is constrained to SUPPORTED_EMBEDDING_DIMS,
    // but I9 is unconditional — the identifier is still escaped rather than
    // interpolated raw, and there must be no independent local copy.
    expect(src).toMatch(/import \{ escapeIdentifier \} from "\.\.\/db\/write\.ts"/);
    expect(src).toMatch(/escapeIdentifier\(`vec_items_\$\{String\(dims\)\}`\)/);
    expect(src).not.toMatch(/replaceAll\('"', '""'\)/);
    expect(src).not.toMatch(/(?:const|function)\s+escapeIdentifier\s*[=(]/);
  });

  test("db/repair.ts guards against NUL-byte / empty identifier names", async () => {
    const src = await read("packages/gateway/src/db/repair.ts");
    expect(src).toMatch(/String\.fromCodePoint\(0\)/);
    expect(src).toMatch(/includes\(NUL_CHAR\)/);
  });

  test("people/person-store.ts binds caller values via dbRun placeholders, never string-built SQL", async () => {
    const src = await read("packages/gateway/src/people/person-store.ts");
    expect(src).toMatch(/import \{ dbRun \} from "\.\.\/db\/write\.ts"/);
    expect(src).toMatch(/WHERE id = \?/);
    // S5-F5: no caller-supplied value is interpolated into an UPDATE/SET clause.
    expect(src).not.toMatch(/SET\s+\w+\s*=\s*\$\{/);
  });
});
