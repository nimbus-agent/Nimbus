/**
 * Bun preload for `audit:boundaries`: hands dependency-cruiser the TypeScript 6 compiler that the
 * root `typescript-compiler-api` alias pins, instead of whichever `typescript` Bun's isolated linker
 * happened to link where dependency-cruiser looks for one. `check-boundaries.ts` spawns the
 * dependency-cruiser CLI with `bun --preload <this file>`; nothing else loads it.
 *
 * WHY. dependency-cruiser 18.5.0 (the latest release) parses TypeScript only through a `typescript`
 * package in `>=2.0.0 <7.0.0`. With no compatible compiler it skips every `.ts`/`.tsx` file, prints a
 * `missing-typescript-transpiler` warning, and EXITS 0 with "no dependency violations found
 * (1 modules, 0 dependencies cruised)". The one module it still reads is
 * `packages/docs/astro.config.mjs`. It resolves `typescript` from its own real path. Under bun's
 * isolated linker that path is `node_modules/.bun/dependency-cruiser@<v>/node_modules/...`, which
 * holds no `typescript` link because it is not a declared dependency, so the lookup falls through
 * to the shared fallback link `node_modules/.bun/node_modules/typescript`. Bun points that link at
 * EITHER `typescript@6.0.3` (the alias, and `packages/docs`' own pin) OR `typescript@7.0.2` (the
 * root compiler), and the choice varies between installs of the SAME `bun.lock`. On 2026-10-05,
 * 11 local checkouts at one lockfile hash split 3 to 8. Since TypeScript 7 landed (#1049,
 * 2026-08-05), 19 of the 33 `main` pushes sampled (one per lockfile change) ran the gate inert in CI.
 *
 * HOW. Bun virtual modules (`build.module`) answer both lookups dependency-cruiser makes:
 * `require("typescript/package.json")` for its version gate, and `import("typescript")` for the
 * compiler. They are answered from the alias, so the result no longer depends on the install.
 * dependency-cruiser's `tsconfig` reader and `tsc` parser go through the same import. An `onResolve`
 * path redirect was tried first and REJECTED. On Windows, Bun 1.3.14 turns an absolute path returned
 * from a runtime `onResolve` into `file:C:\...` and fails with ENOENT, and dependency-cruiser's
 * try/catch reports that as "no compatible compiler". That is the same silent outcome this file
 * exists to remove.
 *
 * The alias is resolved from THIS file's location (the repo root), not the process cwd, so a
 * fixture cruise run from a temp directory gets the same compiler. If the alias is ever moved to
 * TypeScript 7 or removed, this either throws at preload or hands over a compiler dependency-cruiser
 * rejects. `check-boundaries.ts` fails either way, because the TypeScript sources go uncruised. It
 * never passes quietly.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { plugin } from "bun";

/** A CommonJS module object (or parsed JSON object) is a plain record of its exports. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const requireFromRepoRoot = createRequire(join(import.meta.dir, "..", "..", "package.json"));

function loadFromRepoRoot(specifier: string): Record<string, unknown> {
  const loaded: unknown = requireFromRepoRoot(specifier);
  if (!isRecord(loaded)) {
    throw new TypeError(`audit:boundaries preload: ${specifier} did not load as an object`);
  }
  return loaded;
}

const typescript = loadFromRepoRoot("typescript-compiler-api");
const typescriptManifest = loadFromRepoRoot("typescript-compiler-api/package.json");

plugin({
  name: "audit-boundaries-typescript-6",
  setup(build) {
    build.module("typescript", () => ({ exports: typescript, loader: "object" }));
    build.module("typescript/package.json", () => ({
      exports: typescriptManifest,
      loader: "object",
    }));
  },
});
