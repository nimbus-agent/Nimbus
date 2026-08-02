import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The full-body store (V48) deliberately does NOT widen what the embedder
 * sees: prose types route to OpenAI when a key is set, so reading `item.body`
 * here would ship ~32x more private text off the machine on the next embed
 * pass. That property is preserved by these files NOT changing, which is
 * exactly the kind of thing a refactor undoes silently.
 *
 * Read via import.meta.dir — a CWD-relative read is ENOENT under the sharded
 * CI runner and the guard would never run.
 */
function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

for (const file of [
  "pipeline.ts",
  "create-routing-runtime.ts",
  "lazy-scheduler.ts",
  "embedding-worker-core.ts",
]) {
  test(`${file} selects body_preview and never item.body`, () => {
    const src = source(file);
    expect(src).toContain("body_preview");
    // Any `body` column reference that is not `body_preview` fails the guard.
    expect(src.match(/\bi?\.?body\b(?!_preview)/g)).toBeNull();
  });
}

test("itemTextForEmbedding reads body_preview and never falls back to item.body", () => {
  const src = source("chunker.ts");
  expect(src).toContain("item.body_preview");
  // A future "widen on demand" fallback (e.g. `item.body?.trim() ?? item.body_preview...`)
  // must fail this guard even though the positive assertion above still passes.
  expect(src.match(/\bitem\.body\b(?!_preview)/g)).toBeNull();
});
