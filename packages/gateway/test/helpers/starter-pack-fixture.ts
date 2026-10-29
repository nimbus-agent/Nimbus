import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionRunGrantEnv } from "../../src/extensions/extension-run-grants.ts";
import { installExtensionFromLocalDirectory } from "../../src/extensions/install-from-local.ts";
import { LocalIndex } from "../../src/index/local-index.ts";
import { rmDirWithRetry } from "./rm-dir-with-retry.ts";

/** The ids `installStarterPackFixture` installs. */
export const PACK_FIXTURE = {
  codeA: "fx.code.a",
  codeB: "fx.code.b",
  /** A pack whose only member is `codeB`. */
  subPack: "fx.pack.sub",
  /** A pack of `codeA` and `subPack`: its code-bearing members, transitively, are A then B. */
  topPack: "fx.pack.top",
  /** A pack with no members at all, only a connector requirement. */
  barePack: "fx.pack.bare",
} as const;

export interface StarterPackFixture {
  readonly db: Database;
  readonly root: string;
  readonly extensionsDir: string;
  readonly env: ExtensionRunGrantEnv;
  readonly cleanup: () => void;
}

/**
 * Installs, through the real local installer into a fresh temp root, two code extensions, a pack of
 * one of them, a pack of the other plus that pack, and a pack with no members. Every row is exactly
 * what production writes, `kind` included. The caller runs `cleanup` (closes the DB, removes the
 * root).
 */
export async function installStarterPackFixture(prefix: string): Promise<StarterPackFixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const cleanup = (): void => {
    db.close();
    rmDirWithRetry(root);
  };
  try {
    const extensionsDir = join(root, "data", "extensions");
    const install = async (name: string, manifest: Record<string, unknown>): Promise<void> => {
      const src = join(root, "src", name);
      mkdirSync(src, { recursive: true });
      if (manifest["entry"] !== undefined) {
        mkdirSync(join(src, "dist"), { recursive: true });
        writeFileSync(join(src, "dist", "index.js"), "export {};\n");
      }
      writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
      await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        approve: async () => true,
      });
    };
    const code = { version: "1.0.0", entry: "dist/index.js" };
    const pack = { version: "1.0.0", kind: "starter-pack" };
    await install("a", { id: PACK_FIXTURE.codeA, ...code });
    await install("b", { id: PACK_FIXTURE.codeB, ...code });
    await install("sub", {
      id: PACK_FIXTURE.subPack,
      ...pack,
      dependsOn: { [PACK_FIXTURE.codeB]: "^1.0.0" },
    });
    await install("top", {
      id: PACK_FIXTURE.topPack,
      ...pack,
      dependsOn: { [PACK_FIXTURE.subPack]: "^1.0.0", [PACK_FIXTURE.codeA]: "^1.0.0" },
    });
    await install("bare", {
      id: PACK_FIXTURE.barePack,
      ...pack,
      requires: { connectors: ["github"] },
    });
    const env: ExtensionRunGrantEnv = {
      platform: process.platform,
      protectedRoots: [join(root, "data"), join(root, "config")],
      runtimeReadPaths: [],
      realpath: (p) => realpathSync.native(p),
    };
    return { db, root, extensionsDir, env, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** The exact refusal `extension approve` gives for the fixture's top pack. */
export const TOP_PACK_REFUSAL = `${PACK_FIXTURE.topPack} is a starter pack: it has no code to run. Approve its members instead: nimbus extension approve ${PACK_FIXTURE.codeA} && nimbus extension approve ${PACK_FIXTURE.codeB}`;
