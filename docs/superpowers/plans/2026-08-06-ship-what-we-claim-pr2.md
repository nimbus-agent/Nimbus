# What We Ship Is What We Claim — PR 2 (Embedded Assets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A released gateway binary serves its own admin console and its own OpenAPI document from assets baked into the executable, and ships the `vec0` sqlite-vec sidecar in every archive and installer so semantic memory is not silently disabled.

**Architecture:** Four `{ type: "file" }` imports in a new `ipc/embedded-assets.ts` replace two source-tree-relative path derivations in `http-server.ts`. `resolveConsoleDist(baseDir)` becomes `resolveConsoleAsset(rel)`, which in a compiled binary answers from a three-entry map (traversal structurally impossible) and in a dev tree still joins a dist directory guarded by `safeAssetPath`. The console build becomes a prerequisite of the gateway compile. The `vec0` copy moves out of `compile-gateway.ts` into a standalone script called by both that script and every `release.yml` matrix leg. A static audit then confines `import.meta.dir` out of `packages/gateway/src`.

**Tech Stack:** Bun 1.3 · TypeScript 7 strict · Biome · GitHub Actions · WiX v5 · nfpm/AppImage

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Platform equality.** Windows / macOS / Linux equally supported. Build paths with `path.join()`; never hardcode separators.
- **Every Read/Edit/Write uses the worktree absolute path** `C:\gitrep\Nimbus\.claude\worktrees\ship-claim-pr2\...`. A main-repo path silently edits the main checkout with no error.
- **New source files under `packages/{gateway,cli,mcp-connectors}` are subject to the per-file coverage floor** (≥85% line **and** ≥80% branch), which is CI-Linux-authoritative. `scripts/**` is outside the floor's scan roots (`scripts/coverage-floor/check.ts:142-146`) but still gets tests by repo convention.
- **Never `git add -A`** — `.claude/settings.local.json` is tracked.
- **Verify by exit code, never piped output.** `cmd > log 2>&1; echo $?`. A `| tail` swallows the status.
- **`bun test packages` is not the repo's test scope and hangs.** Use `bun run test` or an explicit path.
- **`lint:markdown`'s worktree exclusion is CWD-relative.** Run it from the worktree root and it lints normally (82 files); run it from the main checkout against `.claude/worktrees/**` paths and the exclusion swallows them into a "0 files" green. Always run it from inside the worktree.
- **Do not touch** `packages/cli/**`, `packages/gateway/src/ipc/agents-rpc.ts`, `packages/gateway/src/ipc/server/*`, or `packages/gateway/src/egress/mcp-brief-egress.ts` — a parallel session owns them. Additive edits to `package.json`, `scripts/lib/preflight-gates.ts` and `.github/workflows/_test-suite.yml` are fine.

## Measurements taken against this tree on 2026-08-06 (do not re-derive)

These were run before this plan was written. Four of them changed it.

| # | Measurement | Result |
|---|---|---|
| 1 | `{ type: "file" }` imports of `openapi/v1.yaml` + the console's `index.html`/`main.js`/`styles.css`, compiled | All four resolve to content-hashed bunfs paths (`B:/~BUN/root/main-zf9wbt8q.js`), `existsSync` and `readFileSync` both succeed, byte counts match the sources exactly |
| 2 | The same imports evaluated under plain `bun` (dev mode) | Resolve to the **real absolute source paths** (`…/packages/admin-console/dist/main.js`, `…/packages/gateway/openapi/v1.yaml`) |
| 3 | `tsc --noEmit` over `packages/gateway` with those four imports | `.html` and `.yaml` typecheck out of the box (bun-types). **`.css` fails TS2307 and `main.js` fails TS7016** — an ambient declaration file is required, which the design did not mention |
| 4 | Dev-mode run with `packages/admin-console/dist` **deleted** | `error: Cannot find module '../../../admin-console/dist/index.html'` — the console dist becomes a **hard runtime prerequisite of the whole gateway module graph in dev mode too**, not only at compile time |
| 5 | Root `"prepare"` script + `rm -rf dist` + `bun install --frozen-lockfile` with **warm** `node_modules` ("Checked 1280 installs … no changes") | `prepare` **still ran**; `dist/{index.html,main.js,styles.css}` were rebuilt. This is what makes measurement 4 survivable in CI |

Measurement 4 is the load-bearing one. `_test-suite.yml`'s "Unit + Coverage" and "Integration" jobs and `ci.yml`'s cross-platform `bun test packages/<pkg>/src` job all run **without** `bun run build`. Without measurement 5's mechanism, this PR would turn every gateway test that reaches `http-server.ts` red on a cache-cold checkout.

## Design decisions this plan locks in

1. **`prepare` + explicit compile-time build, not per-workflow steps.** A root `"prepare": "bun run build:console"` runs after every `bun install` — local, CI, and Docker — so no workflow needs a new step. `compile-gateway.ts` and `release.yml` additionally build it explicitly, because at compile time a stale or missing dist is baked into a user's binary and must fail loudly.
2. **The OpenAPI import needs no build.** `packages/gateway/openapi/v1.yaml` is committed, so its embedded import is safe in every runtime shape. Only the three console assets depend on a build step.
3. **The dev-mode dist directory is derived from the embedded import, not from `import.meta.dir`.** In dev, `dirname(EMBEDDED_CONSOLE_ASSETS["index.html"])` **is** `packages/admin-console/dist` (measurement 2). That is what lets the confinement audit ship with nothing to exempt.
4. **`NIMBUS_ADMIN_CONSOLE_DIST` is a dev-only affordance.** A compiled binary ignores it and answers from the map. That is the "structurally impossible rather than rejected" property; honouring an override there would re-open the traversal surface the map closes.
5. **The audit forbids `import.meta.{dir,dirname,path,file}` and `fileURLToPath(import.meta.url)`, not `import.meta.url` itself.** `db/query-guard.ts:54` and `embedding/worker-bridge.ts:46` use `new URL("./worker.ts", import.meta.url)`, which Bun's bundler rewrites and embeds — those are correct and must keep working. With that rule the allowlist is **`perf/surfaces/**` and `*.test.ts` only**; `platform/runtime-layout.ts` is named as the rule's canonical module, not exempted from it.
6. **`packages/cli/src/commands/bench.ts:31` is out of scope.** It derives `packages/gateway/src/perf/bench-runner.ts` from `import.meta.dir` — the same dev-tree-only class as `perf/surfaces/**`. The audit therefore scopes to `packages/gateway/src/**`; widening it to the CLI is a separate change, recorded in the PR body rather than exempted here.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `packages/gateway/src/ipc/embedded-assets.ts` | The four `{ type: "file" }` imports and nothing else. The only module that knows asset filenames. |
| `packages/gateway/src/ipc/embedded-assets.test.ts` | Map completeness + every embedded path readable and non-empty. |
| `packages/gateway/src/asset-modules.d.ts` | Ambient declarations for the two specifier shapes `tsc` cannot resolve (measurement 3). |
| `scripts/copy-vec0-sidecar.ts` | Resolve the platform's `vec0` from `node_modules` and copy it to a destination directory. Callable as a module and as a CLI. |
| `scripts/copy-vec0-sidecar.test.ts` | Pure-function coverage of the platform→filename/npm-segment mapping and the copy. |
| `scripts/structure-audit/check-import-meta-dir.ts` | The confinement audit. |
| `scripts/structure-audit/check-import-meta-dir.test.ts` | Fixture-driven coverage + a "the real tree is clean" assertion. |

**Modify**

| Path | Change |
|---|---|
| `packages/gateway/src/ipc/admin-console-assets.ts` | `resolveConsoleDist(baseDir)` → `resolveConsoleAsset(rel, deps)`. |
| `packages/gateway/src/ipc/admin-console-assets.test.ts` | Rewrite the `resolveConsoleDist` describe block. |
| `packages/gateway/src/ipc/http-server.ts` | Both `import.meta.dir` sites; drop the now-unused `node:path` import. |
| `packages/gateway/src/ipc/http-server.test.ts` | Comment text naming `resolveConsoleDist`. |
| `packages/gateway/compile-gateway.ts` | Build the console, then compile; vec0 copy delegates to the new script. |
| `package.json` | `build:console`, `prepare`, `audit:import-meta-dir`. |
| `scripts/lib/preflight-gates.ts` | `build:console` + `audit:import-meta-dir` gates. |
| `.github/workflows/_test-suite.yml` | Run the three static audits PR 1 and this PR add (they exist only in the local manifest today). |
| `.github/workflows/release.yml` | Console build + vec0 per gateway matrix leg; vec0 through msi/pkg/archive staging. |
| `scripts/windows/nimbus.wxs` | `vec0.dll` component. |
| `scripts/package-macos-installer.sh` | Install `vec0.dylib` beside `nimbus-gateway`. |
| `scripts/package-linux-installers.ts` | `vec0.so` into tarball / deb / rpm / AppImage. |
| `scripts/package-headless-bundle.ts` | `vec0` into the bundle. |
| `scripts/install/unix/install.sh`, `scripts/install/windows/install.ps1` | Copy the sidecar next to the gateway binary. |
| `docs/CHANGELOG.md` | Dated entry. |

---

### Task 1: The console build becomes a prerequisite

**Files:**

- Modify: `package.json` (scripts block)
- Modify: `scripts/lib/preflight-gates.ts:10-21` (FAST list head)
- Modify: `packages/gateway/compile-gateway.ts:91-110`
- Test: `scripts/preflight.test.ts` (existing drift guard — must stay green)

**Interfaces:**

- Consumes: nothing.
- Produces: the root script id **`build:console`**, relied on by `release.yml` (Task 7) and the preflight manifest. Guarantees `packages/admin-console/dist/{index.html,main.js,styles.css}` exists after any `bun install`, which every later task's imports depend on.

- [ ] **Step 1: Add the two root scripts**

In `package.json`, beside the existing `"build"` entry:

```json
"build:console": "bun run --filter @nimbus-dev/admin-console build",
"prepare": "bun run build:console",
```

`prepare` runs after every `bun install`, including `--frozen-lockfile` against a warm `node_modules` (measurement 5). This is what keeps `bun test` working on a cache-cold CI checkout once the gateway statically imports the console's build output.

- [ ] **Step 2: Prove `prepare` fires**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/ship-claim-pr2
rm -rf packages/admin-console/dist
bun install --frozen-lockfile > /tmp/t1-install.log 2>&1; echo "EXIT=$?"
ls packages/admin-console/dist
```

Expected: exit 0 and three files (`index.html`, `main.js`, `styles.css`). If `dist` is empty the rest of this plan cannot work — stop and fix here.

- [ ] **Step 3: Confirm the working tree stays clean**

```bash
git status --short
```

Expected: only `package.json` modified. `packages/admin-console/dist/` is gitignored (`.gitignore:31`), and `prepare` does not touch `bun.lock`, so the `git diff --exit-code -- bun.lock` step in `setup-nimbus-ci` is unaffected.

- [ ] **Step 4: Add the preflight gate**

In `scripts/lib/preflight-gates.ts`, insert as the **first** entry of `FAST` (it must run before `typecheck`, which reads the console's own sources, and before anything that loads the gateway graph):

```ts
  {
    // The gateway statically imports the console's build output with `{ type: "file" }`, so a
    // missing dist is a module-resolution error in the whole gateway graph, not a 503 at runtime.
    // `prepare` keeps it fresh after `bun install`; this gate keeps it fresh after a source edit.
    name: "build:console",
    cmd: ["bun", "run", "build:console"],
    tier: "fast",
  },
```

- [ ] **Step 5: Make the console a prerequisite of the compile**

In `packages/gateway/compile-gateway.ts`, inside `main()`, immediately before the `spawnSync(process.execPath, ["build", …])` call at line 91:

```ts
  const console_ = spawnSync(process.execPath, ["run", "build:console"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if ((console_.status ?? 1) !== 0) {
    process.stderr.write(
      "compile-gateway: admin-console build failed. The gateway embeds its dist with\n" +
        "`{ type: \"file\" }` imports, so the compile cannot proceed without it.\n",
    );
    process.exit(console_.status ?? 1);
  }
```

Name it `console_` — `console` shadows the global and Biome will reject it.

- [ ] **Step 6: Verify the drift guard and the gate manifest**

```bash
bun test scripts/preflight.test.ts > /tmp/t1-drift.log 2>&1; echo "EXIT=$?"
bun run build:console > /tmp/t1-console.log 2>&1; echo "EXIT=$?"
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/lib/preflight-gates.ts packages/gateway/compile-gateway.ts
git commit -m "build: make the admin-console build a prerequisite of the gateway"
```

---

### Task 2: `ipc/embedded-assets.ts` — the four baked assets

**Files:**

- Create: `packages/gateway/src/ipc/embedded-assets.ts`
- Create: `packages/gateway/src/asset-modules.d.ts`
- Test: `packages/gateway/src/ipc/embedded-assets.test.ts`

**Interfaces:**

- Consumes: `packages/admin-console/dist/*` (Task 1 guarantees it exists).
- Produces:
  - `EMBEDDED_OPENAPI_YAML: string` — absolute path to the OpenAPI document, valid in both runtime shapes.
  - `EMBEDDED_CONSOLE_ASSETS: Readonly<Record<string, string>>` — exactly the keys `"index.html"`, `"main.js"`, `"styles.css"`, each an absolute path.
  - Both are consumed by Task 3 (`admin-console-assets.ts`) and Task 4 (`http-server.ts`).

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ipc/embedded-assets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { EMBEDDED_CONSOLE_ASSETS, EMBEDDED_OPENAPI_YAML } from "./embedded-assets.ts";

describe("embedded assets", () => {
  test("the console map holds exactly the three build outputs", () => {
    expect(Object.keys(EMBEDDED_CONSOLE_ASSETS).sort((a, b) => a.localeCompare(b))).toEqual([
      "index.html",
      "main.js",
      "styles.css",
    ]);
  });

  test("every console asset resolves to a readable, non-empty file", () => {
    for (const [name, path] of Object.entries(EMBEDDED_CONSOLE_ASSETS)) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).byteLength).toBeGreaterThan(0);
    }
  });

  test("the OpenAPI document resolves to a readable YAML file", () => {
    expect(existsSync(EMBEDDED_OPENAPI_YAML)).toBe(true);
    expect(readFileSync(EMBEDDED_OPENAPI_YAML, "utf8")).toContain("openapi:");
  });

  test("the console map is frozen", () => {
    expect(Object.isFrozen(EMBEDDED_CONSOLE_ASSETS)).toBe(true);
  });
});
```

The `name` binding in the second test is unused — destructure `[, path]` instead, or Biome's `noUnusedVariables` will fail. Write it as:

```ts
    for (const path of Object.values(EMBEDDED_CONSOLE_ASSETS)) {
```

- [ ] **Step 2: Run it to see it fail**

```bash
bun test packages/gateway/src/ipc/embedded-assets.test.ts > /tmp/t2-red.log 2>&1; echo "EXIT=$?"
```

Expected: non-zero, `Cannot find module './embedded-assets.ts'`.

- [ ] **Step 3: Write the ambient declarations**

Create `packages/gateway/src/asset-modules.d.ts`. `tsconfig.json` has `"include": ["src/**/*"]`, so a `.d.ts` under `src/` is picked up automatically.

```ts
/**
 * Ambient shapes for the `{ type: "file" }` imports in `ipc/embedded-assets.ts`.
 *
 * Such an import evaluates to a filesystem path: the real source path under `bun`, and the
 * content-hashed bunfs path inside a `bun build --compile` binary. bun-types already declares
 * `*.html` and `*.yaml`; these two specifier shapes it does not:
 *   - `*.css`            — no declaration at all (TS2307).
 *   - `*​/dist/main.js`   — TypeScript resolves the real `.js` file and, with `allowJs` off,
 *                          reports an implicit `any` (TS7016). Scoped to `dist/main.js` so it
 *                          cannot shadow an ordinary JavaScript import elsewhere.
 */
declare module "*.css" {
  const path: string;
  export default path;
}

declare module "*/dist/main.js" {
  const path: string;
  export default path;
}
```

- [ ] **Step 4: Write the module**

Create `packages/gateway/src/ipc/embedded-assets.ts`:

```ts
import consoleIndexHtml from "../../../admin-console/dist/index.html" with { type: "file" };
import consoleMainJs from "../../../admin-console/dist/main.js" with { type: "file" };
import consoleStylesCss from "../../../admin-console/dist/styles.css" with { type: "file" };
import openapiV1Yaml from "../../openapi/v1.yaml" with { type: "file" };

/**
 * Assets baked into the executable.
 *
 * `bun build --compile` embeds a `{ type: "file" }` import and rewrites it to the file's path
 * inside the binary; under `bun` the same import is the real path on disk. Nothing here is derived
 * from `import.meta.dir`, which in a compiled binary is the virtual root `/$bunfs/root`
 * (`B:\~BUN\root` on Windows) and yields paths that do not exist.
 *
 * Embedded files land in a FLAT bunfs root under content-hashed names — `main.js` becomes
 * something like `/$bunfs/root/main-zf9wbt8q.js` — so there is no directory to join a request path
 * against. The map below is the whole namespace: a lookup either hits one of three keys or misses.
 *
 * The console's build output is exactly these three files (`bun build src/main.ts --outdir dist
 * --minify`, plus a copy of `index.html` and `src/styles.css`). Adding a fourth means adding an
 * import here; `embedded-assets.test.ts` asserts the key set.
 */
export const EMBEDDED_CONSOLE_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "index.html": consoleIndexHtml,
  "main.js": consoleMainJs,
  "styles.css": consoleStylesCss,
});

/** Absolute path to the OpenAPI document. Committed source, so no build step gates it. */
export const EMBEDDED_OPENAPI_YAML: string = openapiV1Yaml;
```

- [ ] **Step 5: Run the test and the typecheck**

```bash
bun test packages/gateway/src/ipc/embedded-assets.test.ts > /tmp/t2-green.log 2>&1; echo "EXIT=$?"
bun run typecheck > /tmp/t2-tsc.log 2>&1; echo "EXIT=$?"
```

Expected: both exit 0. If `typecheck` reports TS7016 on `main.js`, the ambient pattern did not match — check the specifier is literally `…/dist/main.js`.

- [ ] **Step 6: Prove it survives compilation**

This is the property the whole PR exists for, and it is cheap to check now rather than at the end:

```bash
cd packages/gateway
bun build src/ipc/embedded-assets.ts --compile --target bun --outfile /tmp/t2-probe.exe > /tmp/t2-build.log 2>&1
echo "EXIT=$?"
cd ../..
```

Expected: exit 0, `bundle 5 modules`.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/embedded-assets.ts packages/gateway/src/ipc/embedded-assets.test.ts packages/gateway/src/asset-modules.d.ts
git commit -m "feat(gateway): bake the console + openapi assets into the binary"
```

---

### Task 3: `resolveConsoleAsset` replaces `resolveConsoleDist`

**Files:**

- Modify: `packages/gateway/src/ipc/admin-console-assets.ts:24-37`
- Test: `packages/gateway/src/ipc/admin-console-assets.test.ts:23-64` (replace the `resolveConsoleDist` describe block)

**Interfaces:**

- Consumes: `EMBEDDED_CONSOLE_ASSETS` (Task 2); `isCompiledBinary()` from `../platform/runtime-layout.ts` (shipped by PR 1).
- Produces:
  - `type ConsoleAssetResult = { kind: "file"; path: string } | { kind: "not-built" } | { kind: "not-found" }`
  - `interface ConsoleAssetDeps { compiled: boolean; assets: Readonly<Record<string,string>>; distOverride: string | undefined; exists: (p: string) => boolean }`
  - `function defaultConsoleAssetDeps(): ConsoleAssetDeps` — **a function, not a frozen constant.**
    A module-scope `const` would snapshot `process.env["NIMBUS_ADMIN_CONSOLE_DIST"]` at import
    time, and `http-server.test.ts` sets it per test long after the import. That regressed the
    existing "console not built → 503" test to a 200 during execution; the previous
    `resolveConsoleDist` read `process.env` per call, and this must too.

  - `function resolveConsoleAsset(rel: string, overrideDeps?: ConsoleAssetDeps): ConsoleAssetResult`
  - `contentTypeFor` and `safeAssetPath` keep their current signatures. Task 4 consumes all of it.

The three-way result keeps the three distinct HTTP outcomes the route already has (503 not-built / 404 not-found / 200) instead of collapsing "not built" into a 404 and losing the operator hint.

- [ ] **Step 1: Write the failing tests**

Replace the entire `describe("resolveConsoleDist", …)` block (lines 23-64) of `packages/gateway/src/ipc/admin-console-assets.test.ts` with:

```ts
describe("resolveConsoleAsset — compiled binary", () => {
  const deps: ConsoleAssetDeps = {
    compiled: true,
    assets: { "index.html": "/$bunfs/root/index-a.html", "main.js": "/$bunfs/root/main-b.js" },
    distOverride: "/tmp/attacker-controlled",
    exists: () => true,
  };

  test("serves a mapped asset", () => {
    expect(resolveConsoleAsset("index.html", deps)).toEqual({
      kind: "file",
      path: "/$bunfs/root/index-a.html",
    });
  });

  test("an unmapped name misses — there is no directory to walk", () => {
    expect(resolveConsoleAsset("styles.css", deps)).toEqual({ kind: "not-found" });
  });

  test("inherited Object keys are not assets", () => {
    expect(resolveConsoleAsset("constructor", deps)).toEqual({ kind: "not-found" });
    expect(resolveConsoleAsset("__proto__", deps)).toEqual({ kind: "not-found" });
    expect(resolveConsoleAsset("toString", deps)).toEqual({ kind: "not-found" });
  });

  test("the dist override is ignored when compiled", () => {
    expect(resolveConsoleAsset("main.js", deps)).toEqual({
      kind: "file",
      path: "/$bunfs/root/main-b.js",
    });
  });

  test("never reports not-built when compiled — the assets are in the executable", () => {
    const empty: ConsoleAssetDeps = { ...deps, assets: {} };
    expect(resolveConsoleAsset("index.html", empty)).toEqual({ kind: "not-found" });
  });
});

describe("resolveConsoleAsset — dev tree", () => {
  let tmp: string;
  let dist: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-console-"));
    dist = join(tmp, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "main.js"), "export {};");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function devDeps(distOverride: string | undefined): ConsoleAssetDeps {
    return {
      compiled: false,
      assets: { "index.html": join(dist, "index.html") },
      distOverride,
      exists: existsSync,
    };
  }

  test("serves from the dist directory derived from the embedded index.html", () => {
    expect(resolveConsoleAsset("main.js", devDeps(undefined))).toEqual({
      kind: "file",
      path: join(dist, "main.js"),
    });
  });

  test("a missing file in a built dist is not-found", () => {
    expect(resolveConsoleAsset("styles.css", devDeps(undefined))).toEqual({ kind: "not-found" });
  });

  test("an override with an index.html wins over the derived dist", () => {
    const other = join(tmp, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "index.html"), "<!doctype html>");
    expect(resolveConsoleAsset("index.html", devDeps(other))).toEqual({
      kind: "file",
      path: join(other, "index.html"),
    });
  });

  test("an override without an index.html is not-built", () => {
    expect(resolveConsoleAsset("index.html", devDeps(join(tmp, "nothing-here")))).toEqual({
      kind: "not-built",
    });
  });

  test("a blank override is treated as absent", () => {
    expect(resolveConsoleAsset("main.js", devDeps("   "))).toEqual({
      kind: "file",
      path: join(dist, "main.js"),
    });
  });

  test("a dist whose index.html has gone missing is not-built", () => {
    rmSync(join(dist, "index.html"));
    expect(resolveConsoleAsset("main.js", devDeps(undefined))).toEqual({ kind: "not-built" });
  });
});
```

Update the file's imports to:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsoleAssetDeps,
  contentTypeFor,
  resolveConsoleAsset,
  safeAssetPath,
} from "./admin-console-assets.ts";
```

Every assertion above compares against a `join(...)` result rather than a literal separator, so `audit:cross-platform` stays quiet and the test is honest on Windows.

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/ipc/admin-console-assets.test.ts > /tmp/t3-red.log 2>&1; echo "EXIT=$?"
```

Expected: non-zero — `resolveConsoleAsset` is not exported.

- [ ] **Step 3: Rewrite the module**

Replace lines 24-37 of `packages/gateway/src/ipc/admin-console-assets.ts` (the whole `resolveConsoleDist` block) with:

```ts
export type ConsoleAssetResult =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "not-built" }
  | { readonly kind: "not-found" };

export interface ConsoleAssetDeps {
  /** True inside a `bun build --compile` executable. */
  readonly compiled: boolean;
  /** Relative asset name → absolute path. In a compiled binary this is the entire namespace. */
  readonly assets: Readonly<Record<string, string>>;
  /** `NIMBUS_ADMIN_CONSOLE_DIST`. Dev-tree only — a compiled binary ignores it. */
  readonly distOverride: string | undefined;
  readonly exists: (path: string) => boolean;
}

export const DEFAULT_CONSOLE_ASSET_DEPS: ConsoleAssetDeps = {
  compiled: isCompiledBinary(),
  assets: EMBEDDED_CONSOLE_ASSETS,
  distOverride: process.env["NIMBUS_ADMIN_CONSOLE_DIST"],
  exists: existsSync,
};

/** The dev-tree dist directory: the override when it names a built console, else the directory
 * holding the embedded `index.html` — which under `bun` is the real
 * `packages/admin-console/dist`. Deriving it from the asset map is what keeps `import.meta.dir`
 * out of this file; walking up from it breaks in a compiled binary. */
function devConsoleDist(deps: ConsoleAssetDeps): string | undefined {
  const override = deps.distOverride;
  if (override !== undefined && override.trim() !== "") {
    return deps.exists(join(override, "index.html")) ? override : undefined;
  }
  const indexHtml = deps.assets["index.html"];
  if (indexHtml === undefined) return undefined;
  const dist = dirname(indexHtml);
  return deps.exists(join(dist, "index.html")) ? dist : undefined;
}

/**
 * Resolve a `/admin/*` asset name to a readable path.
 *
 * `rel` must already have passed `safeAssetPath`. Compiled, resolution is a lookup in a
 * three-entry map, so traversal is structurally impossible rather than rejected — there is no
 * directory to escape from. In a dev tree the lookup is a join against the dist directory, which
 * is why `safeAssetPath` remains load-bearing there.
 */
export function resolveConsoleAsset(
  rel: string,
  deps: ConsoleAssetDeps = DEFAULT_CONSOLE_ASSET_DEPS,
): ConsoleAssetResult {
  if (deps.compiled) {
    // hasOwn, not `deps.assets[rel] !== undefined`: `"constructor"` and `"toString"` are truthy
    // on any plain object and would otherwise resolve to a function.
    if (!Object.hasOwn(deps.assets, rel)) return { kind: "not-found" };
    const path = deps.assets[rel];
    return path === undefined ? { kind: "not-found" } : { kind: "file", path };
  }
  const dist = devConsoleDist(deps);
  if (dist === undefined) return { kind: "not-built" };
  const path = join(dist, rel);
  return deps.exists(path) ? { kind: "file", path } : { kind: "not-found" };
}
```

Replace the file's import header with:

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiledBinary } from "../platform/runtime-layout.ts";
import { EMBEDDED_CONSOLE_ASSETS } from "./embedded-assets.ts";
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/gateway/src/ipc/admin-console-assets.test.ts > /tmp/t3-green.log 2>&1; echo "EXIT=$?"
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/admin-console-assets.ts packages/gateway/src/ipc/admin-console-assets.test.ts
git commit -m "refactor(gateway): resolve console assets by name, not by dist directory"
```

---

### Task 4: Wire `http-server.ts` — the last two `import.meta.dir` sites

**Files:**

- Modify: `packages/gateway/src/ipc/http-server.ts:2` (path import), `:19` (asset import), `:30` (openapi loader import), `:190-198`, `:337-358`
- Test: `packages/gateway/src/ipc/http-server.test.ts:664-666`, `:678-679` (comment text only)

**Interfaces:**

- Consumes: `resolveConsoleAsset`, `ConsoleAssetResult`, `contentTypeFor`, `safeAssetPath` (Task 3); `EMBEDDED_OPENAPI_YAML` (Task 2).
- Produces: a `packages/gateway/src` tree with zero `import.meta.dir` outside `perf/surfaces/**`, which is what Task 6's audit asserts.

- [ ] **Step 1: Replace the OpenAPI path derivation**

Delete line 190 (`const OPENAPI_YAML_PATH = resolve(import.meta.dir, …)`) and change `handleOpenApiJson`:

```ts
function handleOpenApiJson(): Response {
  const bytes = loadOpenApiJsonBytes(EMBEDDED_OPENAPI_YAML);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
```

`loadOpenApiJsonBytes` caches per path and reads with `node:fs`, both of which work against a bunfs path (measurement 1) — its signature does not change.

- [ ] **Step 2: Replace the console handler body**

Replace lines 337-358 (from `const dist = resolveConsoleDist(import.meta.dir);` to the end of `handleAdminConsole`) with:

```ts
  const rel = safeAssetPath(url.pathname);
  if (rel === undefined) {
    return new Response("bad request\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const asset = resolveConsoleAsset(rel);
  if (asset.kind === "not-built") {
    return new Response(
      "admin console not built — run: bun --filter @nimbus-dev/admin-console build\n",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  if (asset.kind === "not-found") {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(Bun.file(asset.path), { headers: { "content-type": contentTypeFor(rel) } });
```

Note the reordering: traversal is now rejected **before** the not-built check. A traversal attempt against an unbuilt console previously returned 503; it now returns 400. That is the stricter answer and the existing traversal test accepts both 400 and 404 while asserting only "never 200".

- [ ] **Step 3: Fix the imports**

- Line 2: delete `import { join, resolve } from "node:path";` entirely — both bindings were used only by the two sites just removed (verified: they had exactly two call sites, at `:190` and `:354`). Leaving it fails `noUnusedLocals`.
- Line 19: `import { contentTypeFor, resolveConsoleAsset, safeAssetPath } from "./admin-console-assets.ts";`
- Add: `import { EMBEDDED_OPENAPI_YAML } from "./embedded-assets.ts";` in import-sorted position (Biome sorts; run `bun run lint` and let it tell you).

- [ ] **Step 4: Update the two stale test comments**

In `packages/gateway/src/ipc/http-server.test.ts`:

- line 665: `// Force resolveConsoleDist → undefined by pointing the override at a path with no index.html.` → `// Force the not-built result by pointing the override at a path with no index.html.`
- line 679: `// Point the override at a real built dist so resolveConsoleDist resolves, exercising the` → `// Point the override at a real built dist so the asset resolves, exercising the`
- line 30 mentions `resolveConsoleDist()` in the `builtConsoleDist()` helper comment → `resolveConsoleAsset()`.

`audit:doc-refs` does not scan test comments, but a stale name is exactly the drift this repo has been bitten by.

- [ ] **Step 5: Run the affected tests**

```bash
bun test packages/gateway/src/ipc/http-server.test.ts > /tmp/t4-http.log 2>&1; echo "EXIT=$?"
bun run typecheck > /tmp/t4-tsc.log 2>&1; echo "EXIT=$?"
bun run lint > /tmp/t4-lint.log 2>&1; echo "EXIT=$?"
```

Expected: all exit 0. In particular the `/admin` 503, `/admin` traversal, and `GET /v1/openapi.json` tests must pass.

- [ ] **Step 6: Prove the compiled binary actually serves both**

The unit tests all run in dev mode. Build the real binary and check the compiled path:

```bash
bun run build > /tmp/t4-build.log 2>&1; echo "BUILD_EXIT=$?"
ls -la dist/nimbus-gateway*
```

Then start it against a scratch config dir, request `/admin` and `/v1/openapi.json` with the admin bearer, and confirm 200 with console content. Record the two status codes in the PR body — this is the assertion PR 3 automates in `install-smoke.yml`, and doing it by hand once here is what proves the change before that lands.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/http-server.ts packages/gateway/src/ipc/http-server.test.ts
git commit -m "fix(gateway): serve the console and openapi doc from embedded assets"
```

---

### Task 5: Extract `scripts/copy-vec0-sidecar.ts`

**Files:**

- Create: `scripts/copy-vec0-sidecar.ts`
- Create: `scripts/copy-vec0-sidecar.test.ts`
- Modify: `packages/gateway/compile-gateway.ts:36-70` (delete the four moved functions), `:109`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `function vec0Filename(platform: NodeJS.Platform): string`
  - `function npmOsSegment(platform: NodeJS.Platform): string`
  - `function resolveVec0SourceOrThrow(platform?: NodeJS.Platform, arch?: string): string` —
    resolution must start from `packages/gateway/package.json`, not from this script's own URL.
    `sqlite-vec` is declared by the gateway package, not the root, so the verbatim
    `createRequire(import.meta.url)` that worked inside `packages/gateway` throws
    `Cannot find package 'sqlite-vec'` once the file moves to `scripts/`.

  - `function copyVec0Sidecar(destDir: string): string` — returns the destination path
  - CLI: `bun scripts/copy-vec0-sidecar.ts --dest <dir>` (default `dist`), consumed by `release.yml` (Task 7).

No gateway code changes: `tryLoadFromSidecar()` already resolves `dirname(process.execPath)` (`packages/gateway/src/index/sqlite-vec-load.ts:64-68`) and `sidecarFilename()` there already returns `vec0.dll` / `vec0.dylib` / `vec0.so`. This task only moves the *copy* out of a script the release pipeline never runs.

- [ ] **Step 1: Write the failing test**

Create `scripts/copy-vec0-sidecar.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyVec0Sidecar,
  npmOsSegment,
  resolveVec0SourceOrThrow,
  vec0Filename,
} from "./copy-vec0-sidecar.ts";

const TMP = mkdtempSync(join(tmpdir(), "nimbus-vec0-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("vec0Filename", () => {
  test("maps every platform to its loadable-extension suffix", () => {
    expect(vec0Filename("win32")).toBe("vec0.dll");
    expect(vec0Filename("darwin")).toBe("vec0.dylib");
    expect(vec0Filename("linux")).toBe("vec0.so");
    expect(vec0Filename("freebsd")).toBe("vec0.so");
  });
});

describe("npmOsSegment", () => {
  test("maps platforms to the sqlite-vec npm package segment", () => {
    expect(npmOsSegment("win32")).toBe("windows");
    expect(npmOsSegment("darwin")).toBe("darwin");
    expect(npmOsSegment("linux")).toBe("linux");
  });
});

describe("resolveVec0SourceOrThrow", () => {
  test("resolves the host platform's binary from node_modules", () => {
    expect(existsSync(resolveVec0SourceOrThrow())).toBe(true);
  });

  test("names the missing package when a platform is not installed", () => {
    expect(() => resolveVec0SourceOrThrow("linux", "s390x")).toThrow(/sqlite-vec-linux-s390x/);
  });
});

describe("copyVec0Sidecar", () => {
  test("copies the host sidecar into the destination and returns its path", () => {
    const dest = copyVec0Sidecar(TMP);
    expect(dest).toBe(join(TMP, vec0Filename(process.platform)));
    expect(existsSync(dest)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test scripts/copy-vec0-sidecar.test.ts > /tmp/t5-red.log 2>&1; echo "EXIT=$?"
```

Expected: non-zero, module not found.

- [ ] **Step 3: Write the script**

Create `scripts/copy-vec0-sidecar.ts`, moving the logic verbatim from `compile-gateway.ts:36-70` and parameterising platform/arch so both branches are testable:

```ts
#!/usr/bin/env bun
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/**
 * The sqlite-vec loadable extension, copied beside the gateway binary.
 *
 * `tryLoadFromSidecar()` looks for it at `dirname(process.execPath)`
 * (packages/gateway/src/index/sqlite-vec-load.ts), so the copy has to land in every archive and
 * installer. It previously lived only in `compile-gateway.ts`, which the release pipeline never
 * runs — released binaries shipped without it and semantic memory failed at `log.debug` level,
 * silently. That is why this is a standalone script called from both places.
 */
export function vec0Filename(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

export function npmOsSegment(platform: NodeJS.Platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  return "linux";
}

export function resolveVec0SourceOrThrow(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const pkg = `sqlite-vec-${npmOsSegment(platform)}-${arch}`;
  const fname = vec0Filename(platform);
  try {
    const sqliteVecIndex = createRequire(import.meta.url).resolve("sqlite-vec");
    return createRequire(sqliteVecIndex).resolve(`${pkg}/${fname}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `copy-vec0-sidecar: native dep "${pkg}" not found in node_modules (${msg}); ` +
        `bun install may have skipped it on this platform — the resulting gateway binary cannot load semantic memory.`,
    );
  }
}

export function copyVec0Sidecar(destDir: string): string {
  const src = resolveVec0SourceOrThrow();
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, vec0Filename(process.platform));
  copyFileSync(src, dest);
  return dest;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--dest");
  const destArg = i >= 0 ? process.argv[i + 1] : undefined;
  const destDir = resolve(destArg ?? "dist");
  const dest = copyVec0Sidecar(destDir);
  process.stdout.write(`copy-vec0-sidecar: → ${dest} (${String(statSync(dest).size)} bytes)\n`);
}
```

This file uses `import.meta.url` via `createRequire`, which the Task 6 audit permits (it is not a `import.meta.dir` path derivation), and it lives under `scripts/`, which the audit does not scan.

- [ ] **Step 4: Rewire `compile-gateway.ts`**

Delete `npmOsSegment`, `vec0Filename`, `resolveVec0SourceOrThrow` and `copyVec0Sidecar` (lines 36-70) plus the now-unused `copyFileSync`, `statSync` and `createRequire` imports. Add:

```ts
import { copyVec0Sidecar } from "../../scripts/copy-vec0-sidecar.ts";
```

and change line 109 to:

```ts
  const sidecar = copyVec0Sidecar(distDir);
  process.stdout.write(`compile-gateway: copied sqlite-vec sidecar → ${sidecar}\n`);
```

Check the remaining `node:fs` import still needs `existsSync`, `renameSync`, `unlinkSync` — it does (`rotateExistingBinaryOrThrow`).

- [ ] **Step 5: Run the tests**

```bash
bun test scripts/copy-vec0-sidecar.test.ts > /tmp/t5-green.log 2>&1; echo "EXIT=$?"
bun run typecheck > /tmp/t5-tsc.log 2>&1; echo "EXIT=$?"
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/copy-vec0-sidecar.ts scripts/copy-vec0-sidecar.test.ts packages/gateway/compile-gateway.ts
git commit -m "refactor(build): extract the vec0 sidecar copy so the release can call it"
```

---

### Task 6: The `import.meta.dir` confinement audit

**Files:**

- Create: `scripts/structure-audit/check-import-meta-dir.ts`
- Create: `scripts/structure-audit/check-import-meta-dir.test.ts`
- Modify: `package.json` (scripts), `scripts/lib/preflight-gates.ts` (FAST), `.github/workflows/_test-suite.yml:125-131` (Static job)

**Interfaces:**

- Consumes: `stripComments` from `scripts/structure-audit/lib.ts`.
- Produces: `export interface PathDerivationViolation { file: string; line: number; snippet: string }` and `export function checkImportMetaDir(dir?: string): PathDerivationViolation[]`; root script id `audit:import-meta-dir`.

PR 1 deferred this audit because its only two violations were the ones Task 4 just removed. It ships now with **nothing exempted but `perf/surfaces/**` and test files** — if implementing it makes you want to add a third exemption, something in Tasks 2-4 was missed.

- [ ] **Step 1: Write the failing test**

Create `scripts/structure-audit/check-import-meta-dir.test.ts`, modelled on `check-connector-entrypoints.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkImportMetaDir } from "./check-import-meta-dir.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-meta-dir-audit-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(rel: string, source: string): void {
  const full = join(ROOT, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, source);
}

fixture("ipc/bad-dir.ts", `const p = resolve(import.meta.dir, "..", "x.yaml");\n`);
fixture("ipc/bad-dirname.ts", `const p = join(import.meta.dirname, "x");\n`);
fixture("ipc/bad-path.ts", `const p = import.meta.path;\n`);
fixture("ipc/bad-file.ts", `const p = import.meta.file;\n`);
fixture("ipc/bad-fileurl.ts", `const d = dirname(fileURLToPath(import.meta.url));\n`);
fixture("ipc/ok-comment.ts", `// baseDir is the caller's import.meta.dir\nexport const x = 1;\n`);
fixture("ipc/ok-worker.ts", `new Worker(new URL("./w.ts", import.meta.url).href);\n`);
fixture("ipc/ok-asset.ts", `import p from "./a.html" with { type: "file" };\n`);
fixture("perf/surfaces/bench-x.ts", `const p = resolve(import.meta.dir, "..", "index.ts");\n`);
fixture("ipc/thing.test.ts", `const p = join(import.meta.dir, "fixture.json");\n`);
fixture("platform/runtime-layout.ts", `const D = dirname(fileURLToPath(import.meta.url));\n`);

describe("checkImportMetaDir", () => {
  const files = (): string[] =>
    checkImportMetaDir(ROOT)
      .map((v) => v.file)
      .sort((a, b) => a.localeCompare(b));

  test("flags every filesystem-path form of import.meta", () => {
    expect(files()).toEqual([
      "ipc/bad-dir.ts",
      "ipc/bad-dirname.ts",
      "ipc/bad-file.ts",
      "ipc/bad-fileurl.ts",
      "ipc/bad-path.ts",
    ]);
  });

  test("reports a 1-based line number and the offending source line", () => {
    const v = checkImportMetaDir(ROOT).find((x) => x.file === "ipc/bad-dir.ts");
    expect(v?.line).toBe(1);
    expect(v?.snippet).toContain("import.meta.dir");
  });

  test("ignores prose mentions in comments", () => {
    expect(files()).not.toContain("ipc/ok-comment.ts");
  });

  test("ignores the bundler-rewritten Worker URL form", () => {
    expect(files()).not.toContain("ipc/ok-worker.ts");
  });

  test("ignores perf bench surfaces and test files", () => {
    expect(files()).not.toContain("perf/surfaces/bench-x.ts");
    expect(files()).not.toContain("ipc/thing.test.ts");
  });

  test("allows the canonical runtime-layout module", () => {
    expect(files()).not.toContain("platform/runtime-layout.ts");
  });

  test("the real gateway source tree is clean", () => {
    expect(checkImportMetaDir()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test scripts/structure-audit/check-import-meta-dir.test.ts > /tmp/t6-red.log 2>&1; echo "EXIT=$?"
```

Expected: non-zero, module not found.

- [ ] **Step 3: Write the audit**

Create `scripts/structure-audit/check-import-meta-dir.ts`:

```ts
#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { stripComments } from "./lib.ts";

export const GATEWAY_SRC = resolve(import.meta.dir, "..", "..", "packages", "gateway", "src");

/**
 * The single module allowed to derive a filesystem path from its own module URL. It exists to
 * answer "am I a compiled binary?" and to build self-spawn commands; every other module gets its
 * paths from it or from an embedded asset import.
 */
const CANONICAL_MODULE = "platform/runtime-layout.ts";

/** Dev-only by construction: these spawn source entrypoints from a source tree that a released
 * binary does not have, and they are never reached from a release build. */
const DEV_ONLY_PREFIX = "perf/surfaces/";

/**
 * Forms of `import.meta` that yield a FILESYSTEM PATH. In a `bun build --compile` binary they all
 * point into the virtual root (`/$bunfs/root`, `B:\~BUN\root` on Windows), so walking up from one
 * produces a path that does not exist — the defect this whole cluster exists to remove.
 *
 * `import.meta.url` alone is NOT here: `new Worker(new URL("./w.ts", import.meta.url))` is the
 * form Bun's bundler rewrites and embeds, and `db/query-guard.ts` + `embedding/worker-bridge.ts`
 * depend on it. Only its path-producing use — `fileURLToPath(import.meta.url)` — is forbidden.
 */
const FORBIDDEN = [
  /\bimport\.meta\.(?:dir|dirname|path|file)\b/,
  /\bfileURLToPath\s*\(\s*import\.meta\.url\s*\)/,
];

export interface PathDerivationViolation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) yield full;
  }
}

export function checkImportMetaDir(root: string = GATEWAY_SRC): PathDerivationViolation[] {
  const out: PathDerivationViolation[] = [];
  for (const full of walk(root)) {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
    if (rel.endsWith(".d.ts")) continue;
    if (rel.startsWith(DEV_ONLY_PREFIX)) continue;
    if (rel === CANONICAL_MODULE) continue;
    const lines = stripComments(readFileSync(full, "utf8")).split("\n");
    lines.forEach((text, i) => {
      if (FORBIDDEN.some((re) => re.test(text))) {
        out.push({ file: rel, line: i + 1, snippet: text.trim() });
      }
    });
  }
  return out;
}

if (import.meta.main) {
  const violations = checkImportMetaDir();
  for (const v of violations) {
    console.error(
      `::error file=packages/gateway/src/${v.file},line=${String(v.line)}::` +
        `derives a filesystem path from import.meta — this resolves inside the read-only bunfs ` +
        `root in a compiled binary. Use platform/runtime-layout.ts or an embedded asset import. ` +
        `(${v.snippet})`,
    );
  }
  console.log(
    violations.length === 0
      ? "import.meta path confinement: ok"
      : `import.meta path confinement: ${String(violations.length)} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
```

`stripComments` preserves newlines for block comments (`lib.ts:36-41`), so the reported line numbers stay accurate.

- [ ] **Step 4: Run the test, and red-prove the guard**

```bash
bun test scripts/structure-audit/check-import-meta-dir.test.ts > /tmp/t6-green.log 2>&1; echo "EXIT=$?"
bun run audit:import-meta-dir > /tmp/t6-real.log 2>&1; echo "EXIT=$?"
```

Both exit 0. Then prove the guard actually bites — a guard that has never been seen red is not a guard:

```bash
cp packages/gateway/src/ipc/http-server.ts /tmp/http-server.bak.ts
printf '\nconst __probe = import.meta.dir;\n' >> packages/gateway/src/ipc/http-server.ts
bun run audit:import-meta-dir > /tmp/t6-redprove.log 2>&1; echo "EXIT=$? (expect 1)"
cp /tmp/http-server.bak.ts packages/gateway/src/ipc/http-server.ts
bun run audit:import-meta-dir > /tmp/t6-restored.log 2>&1; echo "EXIT=$? (expect 0)"
```

Copy the file aside; do **not** use `git stash push/pop` — the stash stack is shared across worktrees and a push with no changes makes the paired pop grab an unrelated session's stash.

- [ ] **Step 5: Register the script and the gate**

`package.json`, beside `audit:connector-deps`:

```json
"audit:import-meta-dir": "bun scripts/structure-audit/check-import-meta-dir.ts",
```

`scripts/lib/preflight-gates.ts`, after the `audit:connector-deps` entry:

```ts
  {
    // A source-tree-relative path derived from `import.meta.dir` resolves inside the read-only
    // bunfs root in a compiled binary, so it silently points at nothing. Two such sites made the
    // admin console and the OpenAPI route unreachable in every released binary.
    name: "audit:import-meta-dir",
    cmd: ["bun", "run", "audit:import-meta-dir"],
    tier: "fast",
  },
```

- [ ] **Step 6: Make the three static audits run in CI**

`audit:connector-entrypoints` and `audit:connector-deps` landed in PR 1 in the preflight manifest only — no workflow invokes them, so they gate nothing on a contributor's PR. Add all three to the Static job of `.github/workflows/_test-suite.yml`, immediately before the existing `regen-slo drift check` step (line 127):

```yaml
      - name: Connector entrypoint contract (bundled-registry startability)
        run: bun run audit:connector-entrypoints

      - name: Connector dependency allowlist (pure-JS only — the binary bundles them)
        run: bun run audit:connector-deps

      - name: import.meta path confinement (compiled-binary asset resolution)
        run: bun run audit:import-meta-dir
```

All three are already in the manifest, so `scripts/preflight.test.ts`'s drift guard stays green. Keep the `name:` values free of `#` — an unquoted Actions `name:` containing `#` truncates silently.

- [ ] **Step 7: Verify and commit**

```bash
bun test scripts/preflight.test.ts scripts/structure-audit/check-import-meta-dir.test.ts > /tmp/t6-final.log 2>&1; echo "EXIT=$?"
bun run audit:workflow-lint > /tmp/t6-wf.log 2>&1; echo "EXIT=$?"
git add scripts/structure-audit/check-import-meta-dir.ts scripts/structure-audit/check-import-meta-dir.test.ts package.json scripts/lib/preflight-gates.ts .github/workflows/_test-suite.yml
git commit -m "test(build): confine import.meta path derivation out of the gateway"
```

---

### Task 7: `release.yml` — build the console, ship the sidecar

**Files:**

- Modify: `.github/workflows/release.yml:120-175` (build-gateway), `:292-297` (build-msi staging), `:357-370` (build-pkg staging), `:451-455` (linux bundle), `:490-520` (macOS/Windows archives)

**Interfaces:**

- Consumes: root script `build:console` (Task 1); `scripts/copy-vec0-sidecar.ts --dest` (Task 5).
- Produces: each `nimbus-gateway-<target>` artifact now also contains `vec0.{so,dylib,dll}`, which Task 8's packaging steps consume.

- [ ] **Step 1: Build the console before each gateway compile**

In the `build-gateway` job, insert after the `Setup Bun and install dependencies` step (line 115-118) and before both compile steps:

```yaml
      - name: Build the admin console (embedded into the gateway binary)
        run: bun run build:console
```

`prepare` already runs it during install; this is the explicit, fail-loud form for the one place where a missing dist would be baked into a user's binary.

- [ ] **Step 2: Copy the vec0 sidecar in each matrix leg**

Insert after the two mutually exclusive compile steps (i.e. after line 146) and before the signing steps:

```yaml
      - name: Copy sqlite-vec sidecar
        run: bun scripts/copy-vec0-sidecar.ts --dest dist
```

Runs on every leg, resolving the host platform's binary — which is correct because each leg runs on its own OS. `bun scripts/...` is not a `bun run <id>` invocation, so the preflight drift guard does not require a manifest entry for it.

- [ ] **Step 3: Include it in the uploaded artifact**

Change the `Upload artifact` step's `path` (line 173) from a single line to:

```yaml
          path: |
            dist/${{ matrix.target.artifact }}${{ matrix.target.ext }}*
            dist/vec0.*
```

Both entries live under `dist/`, so the least-common-ancestor stays `dist/` and every file still lands at the artifact root — `dist/<artifact-name>/vec0.so` after download, alongside the binary. The `Stage release assets`, `Compute SHA256SUMS` and `Flatten artifact dir` steps all glob on the `nimbus-gateway-*` prefix, so none of them picks the sidecar up as a standalone release asset. That is intended: the sidecar ships inside archives and installers, not as a loose download.

- [ ] **Step 4: Thread it through `build-msi`**

Extend the `Stage exes` step (line 292-297):

```yaml
          Copy-Item dist/nimbus-gateway-windows-x64/vec0.dll dist/msi-bin/vec0.dll
```

- [ ] **Step 5: Thread it through `build-pkg`**

In the per-arch loop (after line 365):

```bash
            cp "dist/nimbus-gateway-macos-$arch/vec0.dylib"                  "$stage/vec0.dylib"
```

- [ ] **Step 6: Thread it through the Linux bundle and the archives**

`Linux installers` step, after line 454:

```bash
          cp dist/nimbus-gateway-linux-x64/vec0.so dist/headless-bundle/vec0.so
```

`Build macOS + Windows archives` step — one line per stage, beside each `cp … nimbus-gateway`:

```bash
          cp dist/nimbus-gateway-macos-x64/vec0.dylib       dist/stage-macos-x64/vec0.dylib
          cp dist/nimbus-gateway-macos-arm64/vec0.dylib     dist/stage-macos-arm64/vec0.dylib
          cp dist/nimbus-gateway-windows-x64/vec0.dll       dist/stage-windows-x64/vec0.dll
```

- [ ] **Step 7: Lint the workflow and commit**

```bash
bun run audit:workflow-lint > /tmp/t7-wf.log 2>&1; echo "EXIT=$?"
bun run audit:action-sha-pins > /tmp/t7-pins.log 2>&1; echo "EXIT=$?"
bun test scripts/preflight.test.ts > /tmp/t7-drift.log 2>&1; echo "EXIT=$?"
git add .github/workflows/release.yml
git commit -m "ci(release): build the console and ship the vec0 sidecar per target"
```

---

### Task 8: Installers and archives install the sidecar

**Files:**

- Modify: `scripts/windows/nimbus.wxs`, `scripts/package-macos-installer.sh:20-35`, `scripts/package-linux-installers.ts`, `scripts/package-headless-bundle.ts`, `scripts/install/unix/install.sh:35-94`, `scripts/install/windows/install.ps1:20-56`
- Test: `scripts/package-linux-installers.test.ts` (existing — must stay green)

**Interfaces:**

- Consumes: a staged directory containing `vec0.{so,dylib,dll}` beside the gateway binary (Task 7).
- Produces: an installed layout where the sidecar sits in the same directory as `nimbus-gateway`, which is the only place `tryLoadFromSidecar()` looks (`dirname(process.execPath)`).

The sidecar is **optional at every site**: copy it when present, never fail when absent. A packaging script that hard-fails on it would break local `bun run package:headless` runs on a machine where `bun install` skipped the platform's optional dependency.

- [ ] **Step 1: WiX component**

In `scripts/windows/nimbus.wxs`, inside `<ComponentGroup Id="NimbusComponents">`, after the `NimbusGateway` component:

```xml
      <!-- sqlite-vec loadable extension. tryLoadFromSidecar() resolves it from -->
      <!-- dirname(process.execPath), so it must install into the same bin dir. -->
      <Component Id="NimbusVec0" Bitness="always64">
        <File Id="Vec0Dll" Source="$(BinDir)\vec0.dll" KeyPath="yes" />
      </Component>
```

Also extend the pre-flight loop at line 25 so a missing sidecar is caught at package time rather than by a WiX error:

```powershell
foreach ($f in @("nimbus.exe", "nimbus-gateway.exe", "vec0.dll")) {
  if (-not (Test-Path (Join-Path $BinDir $f))) { throw "Missing $f in $BinDir" }
}
```

- [ ] **Step 2: macOS `.pkg`**

In `scripts/package-macos-installer.sh`, after the `install -m 0755 … nimbus-gateway` line (34):

```bash
if [ -f "${BIN_DIR}/vec0.dylib" ]; then
  install -m 0644 "${BIN_DIR}/vec0.dylib" "${ROOT}/nimbus/bin/vec0.dylib"
fi
```

- [ ] **Step 3: Linux installers**

In `scripts/package-linux-installers.ts`, beside `const gw` / `const cli` (lines 96-97):

```ts
const vec0 = join(bundleDir, "vec0.so");
const hasVec0 = existsSync(vec0);
```

Then add a copy at each of the four staging sites, matching the `sandboxHelper` pattern already there:

- `buildTarball()` — after line 222, into `tarBin`
- the `.deb` staging — after line 305, into `debInst`
- the `.rpm` staging — after line 399, into `rpmBinDir`
- the AppImage staging — after line 473, into `usrBin`

Each as:

```ts
  if (hasVec0) copyFileSync(vec0, join(<targetDir>, "vec0.so"));
```

- [ ] **Step 4: Headless bundle**

In `scripts/package-headless-bundle.ts`, copy `dist/vec0.so` (or the host's `vec0Filename(process.platform)`) into the bundle directory when it exists, so `bun run package:headless` locally produces the same layout the release does. Import `vec0Filename` from `./copy-vec0-sidecar.ts` rather than re-deriving the name.

- [ ] **Step 5: Install scripts**

`scripts/install/unix/install.sh`, after line 94 (`chmod +x …`):

```sh
# sqlite-vec loadable extension. Optional: absent on an unsupported platform, in which
# case semantic memory is disabled but everything else works.
VEC0_SRC=""
for cand in "${SCRIPT_DIR}/vec0.so" "${SCRIPT_DIR}/vec0.dylib" \
            "${SCRIPT_DIR}/bin/vec0.so" "${SCRIPT_DIR}/bin/vec0.dylib"; do
  [ -f "$cand" ] && VEC0_SRC="$cand" && break
done
if [ -n "$VEC0_SRC" ]; then
  cp "$VEC0_SRC" "${INSTALL_DIR}/$(basename "$VEC0_SRC")"
fi
```

`scripts/install/windows/install.ps1`, after line 56:

```powershell
$Vec0Src = @(
  (Join-Path $ScriptDir "vec0.dll"),
  (Join-Path $ScriptDir "bin\vec0.dll")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($Vec0Src) {
  Copy-Item -Path $Vec0Src -Destination (Join-Path $InstallDir "vec0.dll") -Force
}
```

- [ ] **Step 6: Verify**

```bash
bun test scripts/package-linux-installers.test.ts > /tmp/t8-linux.log 2>&1; echo "EXIT=$?"
bun run typecheck > /tmp/t8-tsc.log 2>&1; echo "EXIT=$?"
bun run lint > /tmp/t8-lint.log 2>&1; echo "EXIT=$?"
bun run audit:cross-platform > /tmp/t8-xp.log 2>&1; echo "EXIT=$?"
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/windows/nimbus.wxs scripts/package-macos-installer.sh scripts/package-linux-installers.ts scripts/package-headless-bundle.ts scripts/install/unix/install.sh scripts/install/windows/install.ps1
git commit -m "build: install the sqlite-vec sidecar beside the gateway in every package"
```

---

### Task 9: Changelog and full verification

**Files:**

- Modify: `docs/CHANGELOG.md`

**Interfaces:**

- Consumes: everything above.
- Produces: a branch that is ready to push.

- [ ] **Step 1: Add the changelog entry**

Follow the existing dated-entry format at the top of `docs/CHANGELOG.md`. State the user-visible facts: `/admin` and `/v1/openapi.json` now work in a released binary; semantic memory now works because `vec0` ships in every archive and installer. Name the audit that keeps it from regressing.

- [ ] **Step 2: Full local preflight**

```bash
bun run preflight > /tmp/t9-preflight.log 2>&1; echo "EXIT=$?"
```

Expected: exit 0. Preflight fail-fasts, so a non-zero exit means every later gate went **unrun** — fix and re-run the whole thing rather than assuming the rest was fine. Read the log's tail for which gate stopped it.

- [ ] **Step 3: Docker-Linux verification, full tier**

```bash
bun run verify:docker --full > /tmp/t9-docker.log 2>&1; echo "EXIT=$?"
```

Expected: exit 0. This is the only run that exercises `audit:coverage-floor`, which is CI-Linux-authoritative. `packages/gateway/src/ipc/embedded-assets.ts` is a new source file under the per-file floor (≥85% line, ≥80% branch) — if it misses, write tests. Do **not** add it to `scripts/coverage-floor/exclusions.ts`; for genuinely new code an exclusion there is the false green this repo has been bitten by, and `audit:exclusion-parity` is one-directional so it will not warn you about the `sonar-project.properties` half either.

If Docker is unavailable, fall back to WSL on a Linux-native copy of the tree — never `/mnt/c`.

- [ ] **Step 4: Lint the markdown from the main checkout**

`lint:markdown` is a false green inside `.claude/worktrees/`. Copy the two changed docs to a scratch directory outside the worktree, or run the linter from `C:\gitrep\Nimbus` against a copy, and confirm the exit code.

**Verified result (2026-08-06).** All six relevant files pass the floor on Linux; the Windows run's
four "violations" are a platform-measurement artifact in files this branch does not touch:

| File | Windows | Linux |
|---|---|---|
| `ipc/embedded-assets.ts` | 100% / 100% ✓ | 100% / 100% ✓ |
| `ipc/admin-console-assets.ts` | 100% / 96.97% ✓ | 100% / 96.97% ✓ |
| `ipc/http-server.ts` | 96.47% / 92.12% ✓ | 96.47% / 92.12% ✓ |
| `ipc/server/dispatchers.ts` | 79.89% branch ✗ | 80.07% ✓ |
| `ipc/server/socket-listeners.ts` | 66.67% line ✗ | 91.67% ✓ |
| `platform/linux.ts` | 82.56% / 75% ✗ | 97.67% / 90% ✓ |

The full-tier `verify:docker --full` run OOM-killed (exit 137) during `test:ci`: this machine's
`.wslconfig` caps the WSL2 VM at 8 GB. Its static tier, `build` and `test:connector-boot` all
passed; the numbers above came from a gateway-only instrumented run in the same container
(12,566 tests, 0 fail).

- [ ] **Step 5: Compiled-binary smoke, by hand**

`bun run build` (the preflight `build` gate) produces `dist/nimbus-gateway`. Start it, and confirm with a valid admin bearer:

- `GET /admin` → **200**, body contains the console's `<title>Nimbus Admin Console</title>`
- `GET /admin/main.js` → **200**, `content-type: text/javascript`
- `GET /v1/openapi.json` → **200**, parses as JSON with an `openapi` key
- `ls dist/vec0.*` → the sidecar is present beside the binary

Record the four results in the PR body. PR 3 turns them into `install-smoke.yml` assertions; until then this is the only evidence that the headline claim holds.

**Verified result (2026-08-06).** The admin bearer resolves from the Vault (`http_api.deployment_token`), so sandboxing a full gateway boot would mean writing to the developer's real vault. Instead a throwaway entry compiled the **real** `startReadOnlyHttpServer` into a binary and drove it over HTTP — the same `handleAdminConsole` → `resolveConsoleAsset` production path, with `isCompiledBinary()` reporting `true`:

```text
compiled binary: true
PASS  console index  /admin            -> 200  ct=text/html; charset=utf-8        bytes=460
PASS  console js     /admin/main.js    -> 200  ct=text/javascript; charset=utf-8  bytes=5896
PASS  console css    /admin/styles.css -> 200  ct=text/css; charset=utf-8         bytes=1059
PASS  openapi doc    /v1/openapi.json  -> 200  ct=application/json; charset=utf-8 bytes=12177
PASS  unmapped asset /admin/nope.js    -> 404
```

The last row is the point of the map: an unmapped name misses, with no directory to walk. `dist/vec0.dll` sits beside `dist/nimbus-gateway.exe` after `compile-gateway.ts`.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin dev/asaf/ship-what-we-claim-pr2
```

The **PR title** carries the conventional-commit type — release-please parses that subject line, and local commit messages are discarded on squash. Use:

```text
fix(gateway): serve the admin console and OpenAPI doc from a compiled binary
```

The **PR body** becomes the permanent commit. It must record:

- the five measurements above, especially #4 (the dist is a hard dev-mode prerequisite) and #5 (`prepare` is what makes that survivable in CI);
- that `packages/cli/src/commands/bench.ts:31` is a known remaining `import.meta.dir` site, deliberately out of the audit's scope as a dev-tree-only surface, not an exemption;
- that `audit:connector-entrypoints` and `audit:connector-deps` shipped in PR 1 without any CI invocation and now run in the Static job;
- the four compiled-binary smoke results from step 5;
- that PR 3 carries the `install-smoke.yml` assertions and the documentation subtraction pass.

Do not put a bare `Release-As:` line in the body.

- [ ] **Step 7: Return the main checkout to `main`**

```bash
cd C:/gitrep/Nimbus && git switch main && git rev-parse --abbrev-ref HEAD
```
