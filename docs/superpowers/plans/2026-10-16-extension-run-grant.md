# Extension Runtime PR 2 — Run Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the local owner approve, behind the executor's HITL gate, an installed extension to run with a specific, resolved set of grants, and revoke that approval, without anything spawning yet.

**Architecture:** A new V70 `extension_run_grant` table, owned by one store (static rule D33(b)), records exactly what the owner approved: the code (tree digest and version), the resolved grants and a stable `ext_` service id. `approveExtensionRun` resolves everything first (refusing protected or self-write grants before any prompt), asks through a new I2 action type `extension.run`, re-checks the bytes after approval and only then stores. The IPC methods `extension.approveRun` / `extension.revokeRun` are CLI-only and LAN-forbidden. `extension.list` / `info` gain `runGrant` and `runState`.

**Tech Stack:** Bun 1.4, TypeScript strict, `bun:sqlite`, `bun test`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-11-extension-runtime-design.md` — §§ 4.2, 4.4, 4.5 and § 10 item 2, **as amended by § 11** (read § 11 first: it overrides the schema number, the static rule name, the cascade, what `permissions_json` stores, and how declared reads inside the install path are treated).

## Global Constraints

- Worktree: `C:\gitrep\Nimbus\.claude\worktrees\extension-run-grant`, branch `dev/asafgolombek/extension-run-grant`. Run `git rev-parse --abbrev-ref HEAD` before every commit; it must print that branch.
- Commit messages via `git commit -F <file>` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No `any`. External data is `unknown`. SQLite writes only through `dbRun` / `dbExec` (I14 / D12).
- Schema **V70**; `CURRENT_SCHEMA_VERSION` becomes **70**.
- Service ids match `/^ext_[a-z0-9_]{1,62}$/`; the slug is the manifest id lowercased with every char outside `[a-z0-9]` mapped to `_`.
- Error codes, exactly: `ERR_EXTENSION_SERVICE_ID_INVALID`, `ERR_EXTENSION_SERVICE_ID_COLLISION`, `ERR_EXTENSION_GRANT_PATH_RELATIVE`, `ERR_EXTENSION_GRANT_PATH_MISSING`, `ERR_EXTENSION_GRANT_PROTECTED`, `ERR_EXTENSION_GRANT_SELF_WRITE`, `ERR_EXTENSION_NOT_FOUND`, `ERR_EXTENSION_RUN_DISABLED`, `ERR_EXTENSION_RUN_UNVERIFIED`, `ERR_EXTENSION_RUN_NO_DIGEST`, `ERR_EXTENSION_RUN_TREE_CHANGED`, `ERR_EXTENSION_RUN_NOT_APPROVED`, `ERR_EXTENSION_RUN_CHANGED`.
- New HITL action type `extension.run`, in the I2 frozen set.
- `extension.approveRun` and `extension.revokeRun`: CLI-only, LAN-forbidden, NOT on the Tauri allowlist (stays at 107).
- `model_access` is always `0` in this PR. `runState` is `"disabled" | "no_grant" | "grant_stale" | "ready"` — no `"running"`.
- Nothing spawns an extension in this PR. Every user-facing string that could imply otherwise says so.
- Test data lives only in `mkdtemp` directories under `os.tmpdir()` and `:memory:` databases. Never touch the real Nimbus data/config dirs or the real Vault.
- Close every `Database` before asserting on files or removing temp dirs (an EBUSY cleanup error replaces the real failure on Windows).

## Review Focus

1. **A declared read path that is a symlink into the data dir** — must be refused as `ERR_EXTENSION_GRANT_PROTECTED` after `realpath`, not admitted by its spelling. (Task 2 test.)
2. **A declared read of the extension's own install path, on a platform where the extensions dir is under the protected data dir** — must be silently covered (dropped), not refused. (Task 2 test.)
3. **A declared write path that is a PARENT of the install path** (e.g. the user's home) — must be `ERR_EXTENSION_GRANT_SELF_WRITE`, because it lets the extension rewrite its own code. (Task 2 test.)
4. **Files change while the owner is reading the prompt** — must refuse `ERR_EXTENSION_RUN_CHANGED` and store nothing. (Task 4 test.)
5. **Re-approval after an update** (version and digest moved) — the list shows `grant_stale`, approving again prompts, replaces the grant and KEEPS the original service id. (Task 4 + Task 5 tests.)

---

## File Structure

| File | Responsibility |
| --- | --- |
| Create `packages/gateway/src/util/path-overlap.ts` | `pathApiFor`, `isSameOrInside`, `pathsOverlap`, `findProtectedOverlap` — extracted from `user-mcp-registration.ts` |
| Create `packages/gateway/src/util/service-id-prefix.ts` | `findServiceIdPrefixCollision` — extracted from `user-mcp-registration.ts` |
| Modify `packages/gateway/src/connectors/user-mcp-registration.ts` | use the two helpers; behaviour unchanged |
| Create `packages/gateway/src/extensions/run-grant-error.ts` | `ExtensionRunGrantError` + code union |
| Create `packages/gateway/src/extensions/extension-service-id.ts` | derive + collision-check the `ext_` service id |
| Create `packages/gateway/src/extensions/extension-run-grants.ts` | resolve declared permissions into grants; serialize them |
| Create `packages/gateway/src/index/extension-run-grant-v70-sql.ts` | V70 DDL |
| Modify `packages/gateway/src/index/migrations/runner.ts`, `packages/gateway/src/index/local-index.ts` | register V70; bump version |
| Create `packages/gateway/src/extensions/run-grant-store.ts` | the ONLY code naming `extension_run_grant` |
| Modify `packages/gateway/src/automation/extension-store.ts` | `deleteExtensionById` clears the grant |
| Modify `scripts/structure-audit/check-nimbus-invariants.ts` | D33(b), sharing D32(a)'s regex builder |
| Create `packages/gateway/src/extensions/approve-run.ts` | `approveExtensionRun`, `revokeExtensionRun` |
| Create `packages/gateway/src/extensions/run-state.ts` | `extensionRunState`, `extensionRunFields` |
| Modify `packages/gateway/src/ipc/automation-rpc.ts` | two handlers; `runGrantEnv`; list/info fields |
| Modify `packages/gateway/src/ipc/server/dispatchers.ts` | owner gate + env for `extension.approveRun` |
| Modify `packages/gateway/src/engine/executor.ts` | `extension.run` in I2 |
| Modify `packages/gateway/src/ipc/lan-rpc.ts` | both methods LAN-forbidden |
| Create `packages/gateway/test/e2e/_fixtures/real-gateway-client.ts` | shared real-socket client + gateway boot (extracted from `explain-last.e2e.test.ts`) |
| Create `packages/gateway/test/e2e/extension-run-grant.e2e.test.ts` | routing proof over a real socket |
| Modify `packages/cli/src/commands/extension.ts` | `approve` / `revoke` |
| Docs | `docs/cli-reference.md`, `docs/schema-reference.md`, `docs/architecture.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` |

---

### Task 1: Extract the path-overlap and service-id-prefix helpers

**Files:**
- Create: `packages/gateway/src/util/path-overlap.ts`, `packages/gateway/src/util/path-overlap.test.ts`
- Create: `packages/gateway/src/util/service-id-prefix.ts`, `packages/gateway/src/util/service-id-prefix.test.ts`
- Modify: `packages/gateway/src/connectors/user-mcp-registration.ts` (remove the private `pathApi`, `isSameOrInside`, the body of `checkIdCollision` and of `assertNotProtected`)

**Interfaces:**
- Produces:
  - `pathApiFor(platform: NodeJS.Platform): typeof path.posix`
  - `isSameOrInside(platform: NodeJS.Platform, a: string, b: string): boolean` — is `a` the same as, or inside, `b`
  - `pathsOverlap(platform: NodeJS.Platform, a: string, b: string): boolean`
  - `findProtectedOverlap(candidate: string, roots: readonly string[], platform: NodeJS.Platform, realpath: (p: string) => string): string | undefined` — returns the ROOT as configured
  - `findServiceIdPrefixCollision(candidate: string, existing: readonly string[]): string | undefined`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/util/path-overlap.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { findProtectedOverlap, isSameOrInside, pathsOverlap } from "./path-overlap.ts";

const identity = (p: string): string => p;

describe("isSameOrInside", () => {
  test("posix: same, inside, and a sibling that only shares a prefix", () => {
    expect(isSameOrInside("linux", "/a/b", "/a/b")).toBe(true);
    expect(isSameOrInside("linux", "/a/b/c", "/a/b")).toBe(true);
    expect(isSameOrInside("linux", "/a/bc", "/a/b")).toBe(false);
    expect(isSameOrInside("linux", "/a", "/a/b")).toBe(false);
  });

  test("win32: case-insensitive, and a different drive is never inside", () => {
    expect(isSameOrInside("win32", "C:\\Users\\X\\Data\\f", "c:\\users\\x\\data")).toBe(true);
    expect(isSameOrInside("win32", "D:\\data", "C:\\data")).toBe(false);
  });
});

describe("pathsOverlap", () => {
  test("either direction counts", () => {
    expect(pathsOverlap("linux", "/home/u", "/home/u/.local/share/nimbus")).toBe(true);
    expect(pathsOverlap("linux", "/home/u/.local/share/nimbus/x", "/home/u/.local/share/nimbus")).toBe(true);
    expect(pathsOverlap("linux", "/srv/a", "/srv/b")).toBe(false);
  });
});

describe("findProtectedOverlap", () => {
  test("returns the configured root a candidate overlaps", () => {
    expect(findProtectedOverlap("/data/x", ["/cfg", "/data"], "linux", identity)).toBe("/data");
  });

  test("a parent of a protected root overlaps it", () => {
    expect(findProtectedOverlap("/", ["/data"], "linux", identity)).toBe("/data");
  });

  test("matches against the root's realpath too", () => {
    const realpath = (p: string): string => (p === "/link/data" ? "/real/data" : p);
    expect(findProtectedOverlap("/real/data/f", ["/link/data"], "linux", realpath)).toBe(
      "/link/data",
    );
  });

  test("a root that does not exist yet is compared by its spelling", () => {
    const realpath = (p: string): string => {
      throw new Error(`ENOENT ${p}`);
    };
    expect(findProtectedOverlap("/data/f", ["/data"], "linux", realpath)).toBe("/data");
    expect(findProtectedOverlap("/elsewhere", ["/data"], "linux", realpath)).toBeUndefined();
  });
});
```

`packages/gateway/src/util/service-id-prefix.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { findServiceIdPrefixCollision } from "./service-id-prefix.ts";

describe("findServiceIdPrefixCollision", () => {
  test("equal, extends, and extended-by at an underscore boundary all collide", () => {
    expect(findServiceIdPrefixCollision("ext_a", ["ext_a"])).toBe("ext_a");
    expect(findServiceIdPrefixCollision("ext_a", ["ext_a_b"])).toBe("ext_a_b");
    expect(findServiceIdPrefixCollision("ext_a_b", ["ext_a"])).toBe("ext_a");
  });

  test("a shared prefix without an underscore boundary does not collide", () => {
    expect(findServiceIdPrefixCollision("ext_ab", ["ext_a"])).toBeUndefined();
    expect(findServiceIdPrefixCollision("ext_a", [])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/gateway && bun test src/util/path-overlap.test.ts src/util/service-id-prefix.test.ts`
Expected: FAIL — `Cannot find module './path-overlap.ts'` / `'./service-id-prefix.ts'`.

- [ ] **Step 3: Implement the helpers**

`packages/gateway/src/util/path-overlap.ts`:

```ts
import path from "node:path";

/** The path module whose rules match `platform`, so a win32 path is parsed as one on any host. */
export function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Is `a` the same as, or inside, `b`? Case-insensitive on win32; another drive is never inside. */
export function isSameOrInside(platform: NodeJS.Platform, a: string, b: string): boolean {
  const api = pathApiFor(platform);
  const norm = (p: string): string => (platform === "win32" ? api.normalize(p).toLowerCase() : p);
  const rel = api.relative(norm(b), norm(a));
  if (rel === "") return true;
  if (api.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${api.sep}`);
}

/** Two paths overlap when either is the same as, or inside, the other. */
export function pathsOverlap(platform: NodeJS.Platform, a: string, b: string): boolean {
  return isSameOrInside(platform, a, b) || isSameOrInside(platform, b, a);
}

/**
 * The first protected root that `candidate` overlaps in either direction — so a grant of `/` is
 * caught as surely as a grant of `<dataDir>/x`. Each root is compared by its configured spelling AND
 * its realpath; a root that does not exist yet keeps its spelling. Returns the root as configured.
 */
export function findProtectedOverlap(
  candidate: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
  realpath: (p: string) => string,
): string | undefined {
  for (const root of roots) {
    let canonical = root;
    try {
      canonical = realpath(root);
    } catch {
      // Not created yet: compare by the configured spelling.
    }
    for (const r of new Set([root, canonical])) {
      if (pathsOverlap(platform, candidate, r)) return root;
    }
  }
  return undefined;
}
```

`packages/gateway/src/util/service-id-prefix.ts`:

```ts
/**
 * The first existing service id that equals `candidate`, or extends it or is extended by it at an
 * `_` boundary. MCP tool keys are `<serviceId>_<tool>`, so two such ids produce keys nobody can split
 * back apart (`ext_a` + `b_tool` vs `ext_a_b` + `tool`).
 */
export function findServiceIdPrefixCollision(
  candidate: string,
  existing: readonly string[],
): string | undefined {
  return existing.find(
    (id) => id === candidate || id.startsWith(`${candidate}_`) || candidate.startsWith(`${id}_`),
  );
}
```

- [ ] **Step 4: Point `user-mcp-registration.ts` at the helpers**

In `packages/gateway/src/connectors/user-mcp-registration.ts`:

1. Delete the local `pathApi` and `isSameOrInside` functions. Add imports:
   ```ts
   import { findProtectedOverlap, pathApiFor } from "../util/path-overlap.ts";
   import { findServiceIdPrefixCollision } from "../util/service-id-prefix.ts";
   ```
   Replace every remaining `pathApi(` call with `pathApiFor(`. Remove the `import path from "node:path";` line only if nothing else uses `path` (the `typeof path.posix` parameter types still do — keep it then).
2. Replace `checkIdCollision`'s body:
   ```ts
   function checkIdCollision(serviceId: string, existing: readonly string[]): void {
     const id = findServiceIdPrefixCollision(serviceId, existing);
     if (id !== undefined) {
       throw new UserMcpRegistrationError(
         "ERR_USER_MCP_ID_COLLISION",
         `Service id "${serviceId}" collides with registered service id "${id}" (one is a prefix of the other at an underscore boundary).`,
       );
     }
   }
   ```
3. Replace `assertNotProtected`'s body (keep its signature so the two call sites are unchanged):
   ```ts
   function assertNotProtected(
     candidate: string,
     label: string,
     env: UserMcpRegistrationEnv,
     _api: typeof path.posix,
   ): void {
     const root = findProtectedOverlap(candidate, env.protectedRoots, env.platform, (p) =>
       env.realpath(p),
     );
     if (root !== undefined) {
       throw new UserMcpRegistrationError(
         "ERR_USER_MCP_READ_PATH_PROTECTED",
         `${label} "${candidate}" overlaps the protected Nimbus directory "${root}".`,
       );
     }
   }
   ```
   If Biome flags the unused `_api`, remove the parameter and drop the argument at its two call sites instead.

- [ ] **Step 5: Run the new tests and the user-MCP suites**

Run: `cd packages/gateway && bun test src/util src/connectors/user-mcp-registration.test.ts src/ipc/connector-rpc-handlers`
Expected: PASS, with no change to any pre-existing user-MCP test. If a user-MCP test changed outcome, the extraction altered behaviour — fix the extraction, never the test.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/util/path-overlap.ts packages/gateway/src/util/path-overlap.test.ts packages/gateway/src/util/service-id-prefix.ts packages/gateway/src/util/service-id-prefix.test.ts packages/gateway/src/connectors/user-mcp-registration.ts
git commit -F <msg-file>   # "refactor(gateway): share the protected-path and service-id-prefix checks"
```

---

### Task 2: Service id and grant resolution

**Files:**
- Create: `packages/gateway/src/extensions/run-grant-error.ts`
- Create: `packages/gateway/src/extensions/extension-service-id.ts`, `packages/gateway/src/extensions/extension-service-id.test.ts`
- Create: `packages/gateway/src/extensions/extension-run-grants.ts`, `packages/gateway/src/extensions/extension-run-grants.test.ts`

**Interfaces:**
- Consumes (Task 1): `findProtectedOverlap`, `isSameOrInside`, `pathsOverlap`, `pathApiFor`, `findServiceIdPrefixCollision`.
- Produces:
  - `class ExtensionRunGrantError extends Error { readonly code: ExtensionRunGrantErrorCode }` — `message` is `"<CODE>: <text>"`
  - `EXTENSION_SERVICE_ID_PATTERN: RegExp`
  - `deriveExtensionServiceId(manifestId: string): string`
  - `assertExtensionServiceIdFree(serviceId: string, existing: readonly string[]): void`
  - `type ExtensionRunGrantEnv = { readonly platform: NodeJS.Platform; readonly protectedRoots: readonly string[]; readonly runtimeReadPaths: readonly string[]; realpath(p: string): string }`
  - `type ResolvedRunGrants = { readonly network: readonly string[]; readonly read: readonly string[]; readonly write: readonly string[] }`
  - `resolveExtensionRunGrants(declared: SandboxPermissions, installPath: string, env: ExtensionRunGrantEnv): ResolvedRunGrants`
  - `serializeRunGrants(grants: ResolvedRunGrants): string`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/extensions/extension-service-id.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { CONNECTOR_SERVICE_IDS } from "../connectors/connector-catalog.ts";
import {
  assertExtensionServiceIdFree,
  deriveExtensionServiceId,
  EXTENSION_SERVICE_ID_PATTERN,
} from "./extension-service-id.ts";

describe("deriveExtensionServiceId", () => {
  test("lowercases and maps every non-alphanumeric to _", () => {
    expect(deriveExtensionServiceId("Com.Example-Tool")).toBe("ext_com_example_tool");
  });

  test("refuses an id whose slug exceeds 62 characters", () => {
    expect(() => deriveExtensionServiceId("a".repeat(63))).toThrow(
      /ERR_EXTENSION_SERVICE_ID_INVALID/,
    );
    expect(deriveExtensionServiceId("a".repeat(62))).toBe(`ext_${"a".repeat(62)}`);
  });

  test("no first-party connector id lives in the ext_ namespace", () => {
    expect(CONNECTOR_SERVICE_IDS.filter((id) => id.startsWith("ext_"))).toEqual([]);
    expect(EXTENSION_SERVICE_ID_PATTERN.test("ext_a")).toBe(true);
    expect(EXTENSION_SERVICE_ID_PATTERN.test("mcp_a")).toBe(false);
  });
});

describe("assertExtensionServiceIdFree", () => {
  test("two manifest ids that slug to the same service id collide", () => {
    const first = deriveExtensionServiceId("a.b");
    expect(() => assertExtensionServiceIdFree(deriveExtensionServiceId("a_b"), [first])).toThrow(
      /ERR_EXTENSION_SERVICE_ID_COLLISION/,
    );
  });

  test("a prefix at an underscore boundary collides in both directions", () => {
    expect(() => assertExtensionServiceIdFree("ext_a_b", ["ext_a"])).toThrow(/COLLISION/);
    expect(() => assertExtensionServiceIdFree("ext_a", ["ext_a_b"])).toThrow(/COLLISION/);
    expect(() => assertExtensionServiceIdFree("ext_ab", ["ext_a"])).not.toThrow();
  });
});
```

`packages/gateway/src/extensions/extension-run-grants.test.ts` (uses REAL temp directories so `realpath` is real; the protected root is a temp dir standing in for `dataDir`):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ExtensionRunGrantEnv,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";
import type { SandboxPermissions } from "./permissions-validator.ts";

let root: string;
let dataDir: string;
let installPath: string;
let outside: string;

function env(): ExtensionRunGrantEnv {
  return {
    platform: process.platform,
    protectedRoots: [dataDir],
    runtimeReadPaths: [],
    realpath: (p) => realpathSync.native(p),
  };
}

function perms(read: string[], write: string[] = [], network: string[] = []): SandboxPermissions {
  return { network, filesystem: { read, write } };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-run-grants-")));
  dataDir = join(root, "data");
  // As on macOS/Linux: the extensions dir sits UNDER the protected data dir.
  installPath = join(dataDir, "extensions", "com.example.a");
  outside = join(root, "outside");
  mkdirSync(installPath, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveExtensionRunGrants", () => {
  test("an ordinary read and write resolve to their canonical paths", () => {
    const g = resolveExtensionRunGrants(perms([outside], [outside]), installPath, env());
    expect(g).toEqual({ network: [], read: [outside], write: [outside] });
  });

  test("hosts are lowercased and deduplicated", () => {
    const g = resolveExtensionRunGrants(
      perms([], [], ["API.Example.com", "api.example.com"]),
      installPath,
      env(),
    );
    expect(g.network).toEqual(["api.example.com"]);
  });

  test("a relative path is refused", () => {
    expect(() => resolveExtensionRunGrants(perms(["rel/x"]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PATH_RELATIVE/,
    );
  });

  test("a path that does not exist is refused", () => {
    expect(() =>
      resolveExtensionRunGrants(perms([join(root, "missing")]), installPath, env()),
    ).toThrow(/ERR_EXTENSION_GRANT_PATH_MISSING/);
  });

  test("a read inside the data dir is refused", () => {
    const inside = join(dataDir, "index");
    mkdirSync(inside);
    expect(() => resolveExtensionRunGrants(perms([inside]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test("a read of a PARENT of the data dir is refused", () => {
    expect(() => resolveExtensionRunGrants(perms([root]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test.skipIf(process.platform === "win32")(
    "Review Focus 1: a symlink pointing into the data dir is refused by its target",
    () => {
      const link = join(outside, "innocent");
      symlinkSync(dataDir, link);
      expect(() => resolveExtensionRunGrants(perms([link]), installPath, env())).toThrow(
        /ERR_EXTENSION_GRANT_PROTECTED/,
      );
    },
  );

  test("Review Focus 2: a read of the extension's own install path is dropped, not refused", () => {
    mkdirSync(join(installPath, "dist"));
    const g = resolveExtensionRunGrants(
      perms([installPath, join(installPath, "dist"), outside]),
      installPath,
      env(),
    );
    expect(g.read).toEqual([outside]);
  });

  test("a write inside the install path is a self-write", () => {
    mkdirSync(join(installPath, "dist"));
    expect(() =>
      resolveExtensionRunGrants(perms([], [join(installPath, "dist")]), installPath, env()),
    ).toThrow(/ERR_EXTENSION_GRANT_SELF_WRITE/);
  });

  test("Review Focus 3: a write of a PARENT of the install path is a self-write", () => {
    expect(() => resolveExtensionRunGrants(perms([], [root]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_SELF_WRITE/,
    );
  });

  test("a write into the data dir (not overlapping the install path) is protected", () => {
    const index = join(dataDir, "index");
    mkdirSync(index);
    expect(() => resolveExtensionRunGrants(perms([], [index]), installPath, env())).toThrow(
      /ERR_EXTENSION_GRANT_PROTECTED/,
    );
  });

  test("win32 compares protected roots case-insensitively", () => {
    const winEnv: ExtensionRunGrantEnv = {
      platform: "win32",
      protectedRoots: ["C:\\Users\\X\\AppData\\Local\\Nimbus\\data"],
      runtimeReadPaths: [],
      realpath: (p) => p,
    };
    expect(() =>
      resolveExtensionRunGrants(
        perms(["c:\\users\\x\\appdata\\local\\nimbus\\DATA\\index"]),
        "C:\\Users\\X\\AppData\\Local\\Nimbus\\extensions\\a",
        winEnv,
      ),
    ).toThrow(/ERR_EXTENSION_GRANT_PROTECTED/);
  });
});

describe("serializeRunGrants", () => {
  test("is stable for equal grants", () => {
    const a = serializeRunGrants({ network: ["h"], read: ["/r"], write: [] });
    const b = serializeRunGrants({ network: ["h"], read: ["/r"], write: [] });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ network: ["h"], read: ["/r"], write: [] });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/gateway && bun test src/extensions/extension-service-id.test.ts src/extensions/extension-run-grants.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/gateway/src/extensions/run-grant-error.ts`:

```ts
export type ExtensionRunGrantErrorCode =
  | "ERR_EXTENSION_SERVICE_ID_INVALID"
  | "ERR_EXTENSION_SERVICE_ID_COLLISION"
  | "ERR_EXTENSION_GRANT_PATH_RELATIVE"
  | "ERR_EXTENSION_GRANT_PATH_MISSING"
  | "ERR_EXTENSION_GRANT_PROTECTED"
  | "ERR_EXTENSION_GRANT_SELF_WRITE"
  | "ERR_EXTENSION_NOT_FOUND"
  | "ERR_EXTENSION_RUN_DISABLED"
  | "ERR_EXTENSION_RUN_UNVERIFIED"
  | "ERR_EXTENSION_RUN_NO_DIGEST"
  | "ERR_EXTENSION_RUN_TREE_CHANGED"
  | "ERR_EXTENSION_RUN_NOT_APPROVED"
  | "ERR_EXTENSION_RUN_CHANGED";

/** A refusal on the way to an extension run grant. The code leads the message, so a CLI shows it. */
export class ExtensionRunGrantError extends Error {
  readonly code: ExtensionRunGrantErrorCode;
  constructor(code: ExtensionRunGrantErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExtensionRunGrantError";
    this.code = code;
  }
}
```

`packages/gateway/src/extensions/extension-service-id.ts`:

```ts
import { findServiceIdPrefixCollision } from "../util/service-id-prefix.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

/** Disjoint from user MCP's `mcp_` and from every first-party connector id. */
export const EXTENSION_SERVICE_ID_PATTERN = /^ext_[a-z0-9_]{1,62}$/;

/**
 * `ext_<slug>`, the slug being the manifest id lowercased with everything outside `[a-z0-9]` mapped
 * to `_`. Computed ONCE, when the first grant is created, and stored: never recomputed, so a later
 * change to this rule cannot move an existing extension's tools.
 */
export function deriveExtensionServiceId(manifestId: string): string {
  const id = `ext_${manifestId.toLowerCase().replaceAll(/[^a-z0-9]/g, "_")}`;
  if (!EXTENSION_SERVICE_ID_PATTERN.test(id)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_SERVICE_ID_INVALID",
      `extension id "${manifestId}" does not yield a service id of 1-62 characters after "ext_"`,
    );
  }
  return id;
}

export function assertExtensionServiceIdFree(serviceId: string, existing: readonly string[]): void {
  const hit = findServiceIdPrefixCollision(serviceId, existing);
  if (hit !== undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_SERVICE_ID_COLLISION",
      `service id "${serviceId}" collides with "${hit}", already granted to another extension (one is a prefix of the other at an underscore boundary)`,
    );
  }
}
```

`packages/gateway/src/extensions/extension-run-grants.ts`:

```ts
import { findProtectedOverlap, isSameOrInside, pathApiFor, pathsOverlap } from "../util/path-overlap.ts";
import type { SandboxPermissions } from "./permissions-validator.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

/** What resolving a grant needs from the machine. Injected so tests never touch real Nimbus dirs. */
export type ExtensionRunGrantEnv = {
  readonly platform: NodeJS.Platform;
  /** `[dataDir, configDir, sandboxDir]` — `LazyConnectorMesh.userMcpProtectedRoots()`. */
  readonly protectedRoots: readonly string[];
  /** Read-only paths the runtime adds at spawn; SHOWN in the consent prompt, never stored. */
  readonly runtimeReadPaths: readonly string[];
  realpath(p: string): string;
};

/**
 * The declared grants after resolution — what a run grant stores (spec § 11 item 7). The install
 * path and the runtime's read paths are NOT here: the runtime adds them fresh at every spawn, since
 * the runtime paths are machine-derived and would make every grant stale on a Bun upgrade.
 */
export type ResolvedRunGrants = {
  readonly network: readonly string[];
  readonly read: readonly string[];
  readonly write: readonly string[];
};

function dedupe(items: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = platform === "win32" ? it.toLowerCase() : it;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function canonicalPath(p: string, kind: "read" | "write", env: ExtensionRunGrantEnv): string {
  if (!pathApiFor(env.platform).isAbsolute(p)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PATH_RELATIVE",
      `${kind} path must be absolute: "${p}"`,
    );
  }
  try {
    return env.realpath(p);
  } catch {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PATH_MISSING",
      `${kind} path does not exist: "${p}"`,
    );
  }
}

function assertNotProtected(p: string, kind: "read" | "write", env: ExtensionRunGrantEnv): void {
  const root = findProtectedOverlap(p, env.protectedRoots, env.platform, (x) => env.realpath(x));
  if (root !== undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PROTECTED",
      `${kind} path "${p}" overlaps the protected Nimbus directory "${root}"`,
    );
  }
}

/**
 * Resolves an extension's DECLARED permissions into the grants a run approval stores, refusing —
 * before any prompt — anything unsatisfiable: a relative or missing path, any overlap with a
 * protected Nimbus directory, and any write that overlaps the extension's own install path (an
 * extension may never write its own code, or its tree digest would be its own to change).
 */
export function resolveExtensionRunGrants(
  declared: SandboxPermissions,
  installPath: string,
  env: ExtensionRunGrantEnv,
): ResolvedRunGrants {
  let install = installPath;
  try {
    install = env.realpath(installPath);
  } catch {
    // Compare by spelling; approve-run has already verified the package is on disk.
  }
  const read: string[] = [];
  for (const p of declared.filesystem.read) {
    const c = canonicalPath(p, "read", env);
    // The runtime grants the install path at spawn anyway — and on macOS/Linux it sits under the
    // protected data dir, so checking it would refuse a harmless manifest (spec § 11 item 8).
    if (isSameOrInside(env.platform, c, install)) continue;
    assertNotProtected(c, "read", env);
    read.push(c);
  }
  const write: string[] = [];
  for (const p of declared.filesystem.write) {
    const c = canonicalPath(p, "write", env);
    if (pathsOverlap(env.platform, c, install)) {
      throw new ExtensionRunGrantError(
        "ERR_EXTENSION_GRANT_SELF_WRITE",
        `write path "${p}" overlaps the extension's own install path "${installPath}"`,
      );
    }
    assertNotProtected(c, "write", env);
    write.push(c);
  }
  return {
    network: dedupe(
      declared.network.map((h) => h.toLowerCase()),
      "linux",
    ),
    read: dedupe(read, env.platform),
    write: dedupe(write, env.platform),
  };
}

/** The canonical stored form; equal grants serialize identically, so a string compare decides. */
export function serializeRunGrants(grants: ResolvedRunGrants): string {
  return JSON.stringify({
    network: [...grants.network],
    read: [...grants.read],
    write: [...grants.write],
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/gateway && bun test src/extensions/extension-service-id.test.ts src/extensions/extension-run-grants.test.ts`
Expected: PASS (the symlink case is skipped on Windows only).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/run-grant-error.ts packages/gateway/src/extensions/extension-service-id.ts packages/gateway/src/extensions/extension-service-id.test.ts packages/gateway/src/extensions/extension-run-grants.ts packages/gateway/src/extensions/extension-run-grants.test.ts
git commit -F <msg-file>   # "feat(extensions): derive ext_ service ids and resolve run grants"
```

---

### Task 3: V70 table, grant store, remove clears the grant, static rule D33(b)

**Files:**
- Create: `packages/gateway/src/index/extension-run-grant-v70-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + one `simpleStep` after the `68 → 69` entry)
- Modify: `packages/gateway/src/index/local-index.ts` (`CURRENT_SCHEMA_VERSION = 70`)
- Modify: `packages/gateway/src/index/migrations/runner.test.ts` (the `"CURRENT_SCHEMA_VERSION is 69 …"` test → 70)
- Create: `packages/gateway/src/index/migrations/runner-v70.test.ts`
- Create: `packages/gateway/src/extensions/run-grant-store.ts`, `packages/gateway/src/extensions/run-grant-store.test.ts`
- Modify: `packages/gateway/src/automation/extension-store.ts` (`deleteExtensionById`)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`, `scripts/structure-audit/check-nimbus-invariants.test.ts`

**Interfaces:**
- Produces:
  - `EXTENSION_RUN_GRANT_V70_SQL: readonly string[]`
  - `RUN_GRANT_SCHEMA_VERSION = 70`
  - `type ExtensionRunGrantRow = { extension_id: string; service_id: string; version: string; tree_digest: string; permissions_json: string; model_access: number; approved_at: number }`
  - `getRunGrant(db: Database, extensionId: string): ExtensionRunGrantRow | null`
  - `listRunGrants(db: Database): ExtensionRunGrantRow[]`
  - `upsertRunGrant(db: Database, row: ExtensionRunGrantRow): void`
  - `deleteRunGrant(db: Database, extensionId: string): boolean`
  - `checkRunGrantTableConfinement(files: readonly FileEntry[]): Violation[]` (static rule)

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/index/migrations/runner-v70.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V70 migration — extension run grants", () => {
  test("CURRENT_SCHEMA_VERSION is at least 70", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
  });

  test("an existing V69 extension row survives and has no grant", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 69);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('com.example.old', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
      );
      runIndexedSchemaMigrations(db, 70);
      expect(db.query("SELECT COUNT(*) AS n FROM extension").get()).toEqual({ n: 1 });
      expect(db.query("SELECT COUNT(*) AS n FROM extension_run_grant").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 70 });
    } finally {
      db.close();
    }
  });

  test("service_id is UNIQUE and model_access is 0 or 1", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 70);
      const ins = (ext: string, sid: string, model: number): void => {
        db.run(
          `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at)
           VALUES (?, ?, '1.0.0', 'd', '{}', ?, 1)`,
          [ext, sid, model],
        );
      };
      ins("a", "ext_a", 0);
      expect(() => ins("b", "ext_a", 0)).toThrow();
      expect(() => ins("c", "ext_c", 2)).toThrow();
    } finally {
      db.close();
    }
  });
});
```

`packages/gateway/src/extensions/run-grant-store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { deleteExtensionById, insertExtensionRow } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  deleteRunGrant,
  type ExtensionRunGrantRow,
  getRunGrant,
  listRunGrants,
  upsertRunGrant,
} from "./run-grant-store.ts";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function db(): Database {
  const d = new Database(":memory:");
  LocalIndex.ensureSchema(d);
  open.push(d);
  return d;
}

function grant(over: Partial<ExtensionRunGrantRow> = {}): ExtensionRunGrantRow {
  return {
    extension_id: "com.example.a",
    service_id: "ext_com_example_a",
    version: "1.0.0",
    tree_digest: "a".repeat(64),
    permissions_json: '{"network":[],"read":[],"write":[]}',
    model_access: 0,
    approved_at: 1,
    ...over,
  };
}

describe("run-grant-store", () => {
  test("upsert, get, list, delete round-trip", () => {
    const d = db();
    expect(getRunGrant(d, "com.example.a")).toBeNull();
    upsertRunGrant(d, grant());
    expect(getRunGrant(d, "com.example.a")).toEqual(grant());
    upsertRunGrant(d, grant({ version: "1.1.0", tree_digest: "b".repeat(64), approved_at: 2 }));
    expect(listRunGrants(d)).toEqual([
      grant({ version: "1.1.0", tree_digest: "b".repeat(64), approved_at: 2 }),
    ]);
    expect(deleteRunGrant(d, "com.example.a")).toBe(true);
    expect(deleteRunGrant(d, "com.example.a")).toBe(false);
  });

  test("below V70 reads are empty and a write throws", () => {
    const d = new Database(":memory:");
    open.push(d);
    runIndexedSchemaMigrations(d, 69);
    expect(getRunGrant(d, "x")).toBeNull();
    expect(listRunGrants(d)).toEqual([]);
    expect(deleteRunGrant(d, "x")).toBe(false);
    expect(() => upsertRunGrant(d, grant())).toThrow(/v70/);
  });

  test("removing the extension removes its grant (FKs are OFF on the gateway connection)", () => {
    const d = db();
    insertExtensionRow(d, {
      id: "com.example.a",
      version: "1.0.0",
      install_path: "/x",
      manifest_hash: "m",
      entry_hash: "e",
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
    upsertRunGrant(d, grant());
    expect(deleteExtensionById(d, "com.example.a")).toBe("/x");
    expect(getRunGrant(d, "com.example.a")).toBeNull();
  });
});
```

In `scripts/structure-audit/check-nimbus-invariants.test.ts`, add `checkRunGrantTableConfinement` to the import from `./check-nimbus-invariants.ts` and append:

```ts
describe("D33(b) — extension_run_grant is named only by its store and its DDL", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the store and the V70 SQL module", () => {
    expect(
      checkRunGrantTableConfinement([
        file("packages/gateway/src/extensions/run-grant-store.ts", "SELECT * FROM extension_run_grant"),
        file(
          "packages/gateway/src/index/extension-run-grant-v70-sql.ts",
          "CREATE TABLE IF NOT EXISTS extension_run_grant (",
        ),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a read", "SELECT 1 FROM extension_run_grant"],
    ["a write", "INSERT INTO extension_run_grant (extension_id) VALUES (?)"],
    ["an upsert-or-replace", "INSERT OR REPLACE INTO extension_run_grant (x) VALUES (1)"],
    ["a delete", "DELETE FROM extension_run_grant WHERE extension_id = ?"],
    ["a quoted name", 'SELECT 1 FROM "extension_run_grant"'],
    ["a schema-qualified name", "UPDATE main.extension_run_grant SET version = ?"],
  ])("FAILS on %s from anywhere else", (_n, sql) => {
    expect(
      checkRunGrantTableConfinement([file("packages/gateway/src/ipc/automation-rpc.ts", sql)]),
    ).toHaveLength(1);
  });

  test("does not match a look-alike identifier, a comment, or a test file", () => {
    expect(
      checkRunGrantTableConfinement([
        file("packages/gateway/src/x.ts", "FROM extension_run_grant_v2; // FROM extension_run_grant"),
        file("packages/gateway/src/y.test.ts", "FROM extension_run_grant"),
      ]),
    ).toEqual([]);
  });
});
```

Update the existing `"CURRENT_SCHEMA_VERSION is 69, …"` test in `packages/gateway/src/index/migrations/runner.test.ts` to say and expect `70`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/gateway && bun test src/index/migrations/runner-v70.test.ts src/extensions/run-grant-store.test.ts src/index/migrations/runner.test.ts && cd ../.. && bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D33"`
Expected: FAIL — missing modules, version 69, missing export.

- [ ] **Step 3: Implement the table, step and store**

`packages/gateway/src/index/extension-run-grant-v70-sql.ts`:

```ts
/**
 * V70 — what the local owner approved an installed extension to RUN with (extension-runtime design
 * § 4.4, amended § 11). One row per extension; the row binds to bytes (`tree_digest`, `version`) and
 * to resolved grants (`permissions_json`), never to a name. `service_id` is computed once and
 * stored, never recomputed. The cascade fires only on a connection with `foreign_keys = ON`, which
 * the gateway's is not — `deleteExtensionById` deletes the grant explicitly. Only this file and
 * `extensions/run-grant-store.ts` name the table (static rule D33(b)).
 */
export const EXTENSION_RUN_GRANT_V70_SQL = [
  `CREATE TABLE IF NOT EXISTS extension_run_grant (
     extension_id     TEXT PRIMARY KEY REFERENCES extension(id) ON DELETE CASCADE,
     service_id       TEXT NOT NULL UNIQUE,
     version          TEXT NOT NULL,
     tree_digest      TEXT NOT NULL,
     permissions_json TEXT NOT NULL,
     model_access     INTEGER NOT NULL DEFAULT 0 CHECK(model_access IN (0, 1)),
     approved_at      INTEGER NOT NULL
   )`,
] as const;
```

In `packages/gateway/src/index/migrations/runner.ts`, add next to the other `-sql.ts` imports:

```ts
import { EXTENSION_RUN_GRANT_V70_SQL } from "../extension-run-grant-v70-sql.ts";
```

and after `{ fromVersion: 68, toVersion: 69, apply: migrateIndexedV68ToV69 },`:

```ts
  simpleStep(69, 70, "extension run grants (extension_run_grant)", EXTENSION_RUN_GRANT_V70_SQL),
```

In `packages/gateway/src/index/local-index.ts`: `export const CURRENT_SCHEMA_VERSION = 70;`

`packages/gateway/src/extensions/run-grant-store.ts`:

```ts
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

/**
 * The ONLY code that names `extension_run_grant` (static rule D33(b)). A grant records exactly what
 * the owner approved through the `extension.run` HITL gate — nothing else may create one.
 */
export const RUN_GRANT_SCHEMA_VERSION = 70;

export type ExtensionRunGrantRow = {
  extension_id: string;
  service_id: string;
  version: string;
  tree_digest: string;
  permissions_json: string;
  model_access: number;
  approved_at: number;
};

const COLS =
  "extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at";

function hasTable(db: Database): boolean {
  return readIndexedUserVersion(db) >= RUN_GRANT_SCHEMA_VERSION;
}

export function getRunGrant(db: Database, extensionId: string): ExtensionRunGrantRow | null {
  if (!hasTable(db)) return null;
  const row = db
    .query(`SELECT ${COLS} FROM extension_run_grant WHERE extension_id = ?`)
    .get(extensionId) as ExtensionRunGrantRow | null;
  return row ?? null;
}

export function listRunGrants(db: Database): ExtensionRunGrantRow[] {
  if (!hasTable(db)) return [];
  return db
    .query(`SELECT ${COLS} FROM extension_run_grant ORDER BY extension_id`)
    .all() as ExtensionRunGrantRow[];
}

/** Creates or replaces the extension's grant. Throws below V70 rather than dropping a grant. */
export function upsertRunGrant(db: Database, row: ExtensionRunGrantRow): void {
  if (!hasTable(db)) {
    throw new Error("Extension run grants require schema v70+");
  }
  dbRun(
    db,
    `INSERT INTO extension_run_grant (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(extension_id) DO UPDATE SET
       service_id = excluded.service_id,
       version = excluded.version,
       tree_digest = excluded.tree_digest,
       permissions_json = excluded.permissions_json,
       model_access = excluded.model_access,
       approved_at = excluded.approved_at`,
    [
      row.extension_id,
      row.service_id,
      row.version,
      row.tree_digest,
      row.permissions_json,
      row.model_access,
      row.approved_at,
    ],
  );
}

export function deleteRunGrant(db: Database, extensionId: string): boolean {
  if (!hasTable(db)) return false;
  return dbRun(db, `DELETE FROM extension_run_grant WHERE extension_id = ?`, [extensionId]).changes > 0;
}
```

In `packages/gateway/src/automation/extension-store.ts`, import `deleteRunGrant` from `../extensions/run-grant-store.ts` and change `deleteExtensionById` so the grant goes first:

```ts
  // Explicit, not left to the FK cascade: the gateway's connection never sets foreign_keys = ON.
  deleteRunGrant(db, id);
  dbRun(db, `DELETE FROM extension WHERE id = ?`, [id]);
  return path;
```

If importing from `extensions/` into `automation/` creates a cycle (`bun run audit:boundaries` / dependency-cruiser will say so), move the call to the one production caller instead — the `"extension.remove"` handler in `packages/gateway/src/ipc/automation-rpc.ts`, right after `deleteExtensionById` returns non-null — and move the third store test to `automation-rpc.run-grant.test.ts` (Task 5).

- [ ] **Step 4: Implement D33(b), sharing D32(a)'s regex**

In `scripts/structure-audit/check-nimbus-invariants.ts`, turn D32(a)'s inline regex into a builder and use it for both rules. Replace the `D32_CAPTURE_IDENT` / `D32_CAPTURE_TABLE_RE` constants with:

```ts
/**
 * A SQL reference to `table`: keyword + optional quote + optional schema qualifier + the bare
 * identifier + a non-identifier lookahead (shape documented at D32(a) below).
 */
function sqlTableReferenceRe(table: string): RegExp {
  const ident = `(?:[\`"[]?[A-Za-z_]\\w*[\`"\\]]?\\.)?[\`"[]?${table}[\`"\\]]?(?![A-Za-z0-9_])`;
  return new RegExp(
    `\\b(?:(?:FROM|INTO|UPDATE(?:\\s+OR\\s+\\w+)?|TABLE|JOIN|REFERENCES)\\s+|FROM\\s+[^;()]*?,\\s*|CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\w"\`[\\].]+\\s+ON\\s+|CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\w"\`[\\].]+\\s+[A-Za-z_,\\s]*?\\bON\\s+)${ident}`,
    "i",
  );
}

const D32_CAPTURE_TABLE_RE = sqlTableReferenceRe("capture");

function checkTableConfinement(
  files: readonly FileEntry[],
  re: RegExp,
  allowed: readonly string[],
  rule: string,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (allowed.includes(f.relPath)) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(re.source, "gi"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}
```

and make the existing export a one-liner (keep its name — tests import it):

```ts
export function checkCaptureTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D32_CAPTURE_TABLE_RE,
    D32_CAPTURE_TABLE_ALLOWED,
    "capture-table-confined",
  );
}
```

Then add the new rule after the D32 section:

```ts
// ---- D33 (extension runtime) ---------------------------------------------------------------------
// (b) `extension_run_grant` is named only by its store and its DDL — a grant is the record of an
//     owner's `extension.run` approval, so no other code may write one or read around it. Same
//     shape and same stated bound as D32(a): a dynamically composed identifier evades a text scan,
//     and capability confinement (only the store holds queries against the table) is the real
//     defense. D33(a), the self-role sentinel, lands with the runtime (extension-runtime PR 3).
const D33_RUN_GRANT_TABLE_RE = sqlTableReferenceRe("extension_run_grant");
const D33_RUN_GRANT_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/index/extension-run-grant-v70-sql.ts",
];

export function checkRunGrantTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D33_RUN_GRANT_TABLE_RE,
    D33_RUN_GRANT_TABLE_ALLOWED,
    "run-grant-table-confined",
  );
}
```

`DELETE FROM extension_run_grant` is covered by the `FROM` alternative.

D33(b)'s `RULE_ANCHORS` entry is added in Task 4 Step 3a, because the file it anchors on (`approve-run.ts`) does not exist until then and `verifyRuleAnchors()` fails on a missing anchor.

Wire it into `main`, next to the D32(a) block, inside the same `if (mode === "binary-only" || mode === "all")` shape:

```ts
  if (mode === "binary-only" || mode === "all") {
    const v = checkRunGrantTableConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(b) extension_run_grant reached outside extensions/run-grant-store.ts — a run grant could be created without the owner's extension.run approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 5: Run the tests, the whole static suite, and the static audit itself**

Run: `cd packages/gateway && bun test src/index/migrations src/extensions/run-grant-store.test.ts src/automation && cd ../.. && bun test scripts/structure-audit/check-nimbus-invariants.test.ts && bun scripts/structure-audit/check-nimbus-invariants.ts`
Expected: PASS everywhere, including every pre-existing D32(a) case (the refactor must not change a D32 result), and the audit prints no D33(b) violation against the real tree.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/extension-run-grant-v70-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/runner.test.ts packages/gateway/src/index/migrations/runner-v70.test.ts packages/gateway/src/index/local-index.ts packages/gateway/src/extensions/run-grant-store.ts packages/gateway/src/extensions/run-grant-store.test.ts packages/gateway/src/automation/extension-store.ts scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.test.ts
git commit -F <msg-file>   # "feat(extensions): V70 extension_run_grant table, its store, and static rule D33(b)"
```

---

### Task 4: Approve and revoke

**Files:**
- Create: `packages/gateway/src/extensions/approve-run.ts`, `packages/gateway/src/extensions/approve-run.test.ts`
- Create: `packages/gateway/src/extensions/run-state.ts`, `packages/gateway/src/extensions/run-state.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`RULE_ANCHORS`, Step 3a)

**Interfaces:**
- Consumes: Task 2 (`resolveExtensionRunGrants`, `serializeRunGrants`, `deriveExtensionServiceId`, `assertExtensionServiceIdFree`, `ExtensionRunGrantError`, `ExtensionRunGrantEnv`, `ResolvedRunGrants`), Task 3 (`getRunGrant`, `listRunGrants`, `upsertRunGrant`, `deleteRunGrant`, `ExtensionRunGrantRow`), existing `listExtensions` / `ExtensionRow` (`automation/extension-store.ts`), `verifyOneExtensionStrict` (`extensions/verify-extensions.ts`), `computeExtensionTreeDigest` (`extensions/tree-digest.ts`), `parseExtensionManifestJson` + `resolveExtensionManifestPath` (`extensions/manifest.ts`), `publisherKeyFingerprint` (`extensions/install-from-local.ts`).
- Produces:
  - `EXTENSION_RUN_ACTION_TYPE = "extension.run"`
  - `type ExtensionRunGate = (action: { type: string; payload: Record<string, unknown> }) => Promise<boolean>`
  - `buildRunConsentPayload(row: ExtensionRow, manifest: ExtensionManifest, serviceId: string, treeDigest: string, grants: ResolvedRunGrants, env: ExtensionRunGrantEnv): Record<string, unknown>` — publisher field named `fingerprint`, never `keyFingerprint`
  - `approveExtensionRun(extensionId: string, deps: { db: Database; env: ExtensionRunGrantEnv; gate: ExtensionRunGate; now: () => number }): Promise<ApproveExtensionRunResult>` where `ApproveExtensionRunResult = { id: string; serviceId: string; version: string; treeDigest: string; grants: ResolvedRunGrants; changed: boolean }`
  - `revokeExtensionRun(db: Database, extensionId: string, stop?: (id: string) => Promise<void>): Promise<{ id: string; revoked: boolean }>`
  - `type ExtensionRunState = "disabled" | "no_grant" | "grant_stale" | "ready"`
  - `type ExtensionRunGrantSummary = { serviceId: string; approvedAt: number; modelAccess: boolean }`
  - `extensionRunState(row: Pick<ExtensionRow, "enabled" | "version" | "tree_digest">, grant: ExtensionRunGrantRow | null): ExtensionRunState`
  - `extensionRunFields(row: ExtensionRow, grant: ExtensionRunGrantRow | null): { runGrant: ExtensionRunGrantSummary | null; runState: ExtensionRunState }`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/extensions/run-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { ExtensionRunGrantRow } from "./run-grant-store.ts";
import { extensionRunFields, extensionRunState } from "./run-state.ts";

const row = { enabled: 1, version: "1.0.0", tree_digest: "a".repeat(64) };
const grant: ExtensionRunGrantRow = {
  extension_id: "x",
  service_id: "ext_x",
  version: "1.0.0",
  tree_digest: "a".repeat(64),
  permissions_json: "{}",
  model_access: 0,
  approved_at: 5,
};

describe("extensionRunState", () => {
  test("disabled wins over everything", () => {
    expect(extensionRunState({ ...row, enabled: 0 }, grant)).toBe("disabled");
  });
  test("no grant", () => {
    expect(extensionRunState(row, null)).toBe("no_grant");
  });
  test("a grant for other code is stale — version or digest", () => {
    expect(extensionRunState({ ...row, version: "1.1.0" }, grant)).toBe("grant_stale");
    expect(extensionRunState({ ...row, tree_digest: "b".repeat(64) }, grant)).toBe("grant_stale");
    expect(extensionRunState({ ...row, tree_digest: null }, grant)).toBe("grant_stale");
  });
  test("ready", () => {
    expect(extensionRunState(row, grant)).toBe("ready");
  });
});

describe("extensionRunFields", () => {
  test("summarises the grant without its paths", () => {
    const full = {
      ...row,
      id: "x",
      install_path: "/x",
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    };
    expect(extensionRunFields(full, grant)).toEqual({
      runGrant: { serviceId: "ext_x", approvedAt: 5, modelAccess: false },
      runState: "ready",
    });
    expect(extensionRunFields(full, null)).toEqual({ runGrant: null, runState: "no_grant" });
  });
});
```

`packages/gateway/src/extensions/approve-run.test.ts` (installs through the REAL `installExtensionFromLocalDirectory` into a temp dir, so the row, hashes and tree digest are real):

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { listExtensions, setExtensionTreeDigest } from "../automation/extension-store.ts";
import { redactPayloadForConsentDisplay } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { approveExtensionRun, buildRunConsentPayload, revokeExtensionRun } from "./approve-run.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { installExtensionFromLocalDirectory, publisherKeyFingerprint } from "./install-from-local.ts";
import { getRunGrant, listRunGrants, upsertRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

type Asked = { type: string; payload: Record<string, unknown> };

/**
 * Installs a real extension into a fresh temp root. `<root>/outside` and `<root>/data` exist before
 * the manifest is written, so `manifest(root)` can declare grants naming them.
 */
async function setup(
  opts: { id?: string; manifest?: (root: string) => Record<string, unknown> } = {},
): Promise<{ db: Database; root: string; installPath: string; env: ExtensionRunGrantEnv }> {
  const id = opts.id ?? "com.example.run";
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-approve-run-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  mkdirSync(join(root, "outside"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  writeFileSync(
    join(src, "nimbus.extension.json"),
    JSON.stringify({
      id,
      version: "1.0.0",
      entry: "dist/index.js",
      ...(opts.manifest?.(root) ?? {}),
    }),
  );
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  const extensionsDir = join(root, "data", "extensions");
  await installExtensionFromLocalDirectory({
    db,
    extensionsDir,
    sourcePath: src,
    approve: async () => true,
  });
  const env: ExtensionRunGrantEnv = {
    platform: process.platform,
    protectedRoots: [join(root, "data"), join(root, "config")],
    runtimeReadPaths: [join(root, "bun-bin")],
    realpath: (p) => realpathSync.native(p),
  };
  return { db, root, installPath: join(extensionsDir, id), env };
}

const gateThat = (answer: boolean, seen: Asked[]) => async (a: Asked) => {
  seen.push(a);
  return answer;
};

describe("approveExtensionRun", () => {
  test("asks once as extension.run over the resolved grants, then stores exactly that", async () => {
    const s = await setup({
      id: "com.example.perm",
      manifest: (root) => ({
        permissions: {
          network: ["API.example.com"],
          filesystem: { read: [join(root, "outside")], write: [] },
        },
      }),
    });
    const outside = join(s.root, "outside");
    const seen: Asked[] = [];
    const out = await approveExtensionRun("com.example.perm", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      now: () => 42,
    });
    expect(seen.map((a) => a.type)).toEqual(["extension.run"]);
    const p = seen[0]?.payload ?? {};
    expect(p["serviceId"]).toBe("ext_com_example_perm");
    expect(p["publisher"]).toBe("unsigned");
    expect(p["network"]).toEqual(["api.example.com"]);
    expect(p["read"]).toEqual([outside]);
    expect(p["runtimeRead"]).toEqual([s.installPath, ...s.env.runtimeReadPaths]);
    expect(p["modelAccess"]).toBe(false);
    expect(out).toMatchObject({ serviceId: "ext_com_example_perm", changed: true });
    expect(getRunGrant(s.db, "com.example.perm")).toEqual({
      extension_id: "com.example.perm",
      service_id: "ext_com_example_perm",
      version: "1.0.0",
      tree_digest: computeExtensionTreeDigest(s.installPath),
      permissions_json: JSON.stringify({ network: ["api.example.com"], read: [outside], write: [] }),
      model_access: 0,
      approved_at: 42,
    });
  });

  test("a denial stores nothing", async () => {
    const { db, env } = await setup();
    await expect(
      approveExtensionRun("com.example.run", { db, env, gate: gateThat(false, []), now: () => 1 }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_APPROVED/);
    expect(listRunGrants(db)).toEqual([]);
  });

  test("an unchanged re-approval answers without prompting", async () => {
    const { db, env } = await setup();
    await approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, []), now: () => 1 });
    const seen: Asked[] = [];
    const out = await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, seen),
      now: () => 2,
    });
    expect(out.changed).toBe(false);
    expect(seen).toEqual([]);
    expect(getRunGrant(db, "com.example.run")?.approved_at).toBe(1);
  });

  test("Review Focus 4: files changing during the prompt refuse and store nothing", async () => {
    const { db, env, installPath } = await setup();
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: async () => {
          writeFileSync(join(installPath, "dist", "late.js"), "export const x = 1;\n");
          return true;
        },
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
    expect(listRunGrants(db)).toEqual([]);
  });

  test("Review Focus 5: after the code changes and is re-adopted, approving again prompts, replaces the grant and keeps the service id", async () => {
    const { db, env, installPath } = await setup();
    await approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, []), now: () => 1 });
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    setExtensionTreeDigest(db, "com.example.run", computeExtensionTreeDigest(installPath));
    const seen: Asked[] = [];
    const out = await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, seen),
      now: () => 2,
    });
    expect(seen).toHaveLength(1);
    expect(out.changed).toBe(true);
    expect(getRunGrant(db, "com.example.run")).toMatchObject({
      service_id: "ext_com_example_run",
      tree_digest: computeExtensionTreeDigest(installPath),
      approved_at: 2,
    });
  });

  test("files changed since install refuse BEFORE prompting", async () => {
    const { db, env, installPath } = await setup();
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, seen), now: () => 1 }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_TREE_CHANGED/);
    expect(seen).toEqual([]);
  });

  test("a protected grant refuses BEFORE prompting", async () => {
    const { db, env } = await setup({
      manifest: (root) => ({
        permissions: { network: [], filesystem: { read: [join(root, "data")], write: [] } },
      }),
    });
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, seen), now: () => 1 }),
    ).rejects.toThrow(/ERR_EXTENSION_GRANT_PROTECTED/);
    expect(seen).toEqual([]);
  });

  test("a disabled extension, an unknown one, and one with no digest refuse before prompting", async () => {
    const { db, env } = await setup();
    const seen: Asked[] = [];
    const run = (id: string) =>
      approveExtensionRun(id, { db, env, gate: gateThat(true, seen), now: () => 1 });
    await expect(run("nope")).rejects.toThrow(/ERR_EXTENSION_NOT_FOUND/);
    db.run("UPDATE extension SET tree_digest = NULL WHERE id = 'com.example.run'");
    await expect(run("com.example.run")).rejects.toThrow(/ERR_EXTENSION_RUN_NO_DIGEST/);
    db.run("UPDATE extension SET enabled = 0 WHERE id = 'com.example.run'");
    await expect(run("com.example.run")).rejects.toThrow(/ERR_EXTENSION_RUN_DISABLED/);
    expect(seen).toEqual([]);
  });

  test("a new grant whose service id collides with another extension's refuses before prompting", async () => {
    const { db, env } = await setup({ id: "a.b" });
    upsertRunGrant(db, {
      extension_id: "other",
      service_id: "ext_a_b",
      version: "1",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
    });
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("a.b", { db, env, gate: gateThat(true, seen), now: () => 1 }),
    ).rejects.toThrow(/ERR_EXTENSION_SERVICE_ID_COLLISION/);
    expect(seen).toEqual([]);
  });

  test("the publisher fingerprint survives consent-display AND audit redaction", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const payload = buildRunConsentPayload(
      {
        id: "p",
        version: "1.0.0",
        install_path: "/x",
        manifest_hash: "m",
        entry_hash: "e",
        enabled: 1,
        installed_at: 1,
        last_verified_at: 1,
        tree_digest: "d",
      },
      {
        id: "p",
        version: "1.0.0",
        updateChannel: "stable",
        permissions: { network: [], filesystem: { read: [], write: [] } },
        publisher: { id: "pub", key },
      },
      "ext_p",
      "d",
      { network: [], read: [], write: [] },
      { platform: "linux", protectedRoots: [], runtimeReadPaths: [], realpath: (p) => p },
    );
    const fp = publisherKeyFingerprint(key);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    // Both redactors drop any field whose NAME contains "key"; `keyFingerprint` would vanish here.
    expect(JSON.stringify(redactPayloadForConsentDisplay(payload))).toContain(fp);
    expect(redactAuditPayload(payload, 4096)).toContain(fp);
  });

  test("an extension the startup signature pass disabled is refused even after a re-enable", async () => {
    const { db, env } = await setup();
    signatureDisabledRegistry.mark("com.example.run", "signature_failed");
    try {
      const seen: Asked[] = [];
      await expect(
        approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, seen), now: () => 1 }),
      ).rejects.toThrow(/ERR_EXTENSION_RUN_UNVERIFIED.*signature_failed/);
      expect(seen).toEqual([]);
    } finally {
      signatureDisabledRegistry.reset();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a declared path retargeted into the data dir while the prompt is open refuses",
    async () => {
      const { db, env, root } = await setup({
        manifest: (r) => {
          symlinkSync(join(r, "outside"), join(r, "link"));
          return { permissions: { network: [], filesystem: { read: [join(r, "link")], write: [] } } };
        },
      });
      await expect(
        approveExtensionRun("com.example.run", {
          db,
          env,
          now: () => 1,
          gate: async () => {
            // The install tree is untouched, so the tree digest alone would not notice this.
            unlinkSync(join(root, "link"));
            symlinkSync(join(root, "data"), join(root, "link"));
            return true;
          },
        }),
      ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
      expect(listRunGrants(db)).toEqual([]);
    },
  );
});

describe("revokeExtensionRun", () => {
  test("deletes the grant and stops the client; a second revoke is a no-op", async () => {
    const { db, env } = await setup();
    await approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, []), now: () => 1 });
    const stopped: string[] = [];
    const stop = async (id: string): Promise<void> => {
      stopped.push(id);
    };
    expect(await revokeExtensionRun(db, "com.example.run", stop)).toEqual({
      id: "com.example.run",
      revoked: true,
    });
    expect(await revokeExtensionRun(db, "com.example.run", stop)).toEqual({
      id: "com.example.run",
      revoked: false,
    });
    expect(stopped).toEqual(["com.example.run"]);
    expect(listExtensions(db).map((r) => r.id)).toEqual(["com.example.run"]);
  });

  test("an unknown extension is refused", async () => {
    const { db } = await setup();
    await expect(revokeExtensionRun(db, "nope")).rejects.toThrow(/ERR_EXTENSION_NOT_FOUND/);
  });

  test("a stop failure does not fail the revoke", async () => {
    const { db, env } = await setup();
    await approveExtensionRun("com.example.run", { db, env, gate: gateThat(true, []), now: () => 1 });
    const out = await revokeExtensionRun(db, "com.example.run", async () => {
      throw new Error("boom");
    });
    expect(out.revoked).toBe(true);
  });
});
```

Every path a manifest declares must exist before install (`resolveExtensionRunGrants` realpaths it), which is why `setup` creates `outside/` and `data/` first. `data/` is in `env.protectedRoots`, standing in for the real data dir.

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/gateway && bun test src/extensions/run-state.test.ts src/extensions/approve-run.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/gateway/src/extensions/run-state.ts`:

```ts
import type { ExtensionRow } from "../automation/extension-store.ts";
import type { ExtensionRunGrantRow } from "./run-grant-store.ts";

/** PR 2's states. `"running"` joins with the runtime (extension-runtime PR 3). */
export type ExtensionRunState = "disabled" | "no_grant" | "grant_stale" | "ready";

export type ExtensionRunGrantSummary = {
  serviceId: string;
  approvedAt: number;
  modelAccess: boolean;
};

/**
 * Compares the row to the grant only — no re-hashing, so `extension list` stays cheap. A grant for
 * a different version or tree digest is stale: the owner approved other code. The runtime (PR 3)
 * additionally re-verifies the live bytes before every spawn.
 */
export function extensionRunState(
  row: Pick<ExtensionRow, "enabled" | "version" | "tree_digest">,
  grant: ExtensionRunGrantRow | null,
): ExtensionRunState {
  if (row.enabled !== 1) return "disabled";
  if (grant === null) return "no_grant";
  if (grant.version !== row.version || grant.tree_digest !== row.tree_digest) return "grant_stale";
  return "ready";
}

export function extensionRunFields(
  row: ExtensionRow,
  grant: ExtensionRunGrantRow | null,
): { runGrant: ExtensionRunGrantSummary | null; runState: ExtensionRunState } {
  return {
    runGrant:
      grant === null
        ? null
        : {
            serviceId: grant.service_id,
            approvedAt: grant.approved_at,
            modelAccess: grant.model_access === 1,
          },
    runState: extensionRunState(row, grant),
  };
}
```

`packages/gateway/src/extensions/approve-run.ts`:

```ts
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import {
  type ExtensionRunGrantEnv,
  type ResolvedRunGrants,
  resolveExtensionRunGrants,
  serializeRunGrants,
} from "./extension-run-grants.ts";
import { assertExtensionServiceIdFree, deriveExtensionServiceId } from "./extension-service-id.ts";
import { publisherKeyFingerprint } from "./install-from-local.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { deleteRunGrant, getRunGrant, listRunGrants, upsertRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { verifyOneExtensionStrict } from "./verify-extensions.ts";

/** The I2 action type a run approval is asked under. */
export const EXTENSION_RUN_ACTION_TYPE = "extension.run" as const;

/** The owner's HITL gate as the executor runs it: `true` only for "proceed". */
export type ExtensionRunGate = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

export interface ApproveExtensionRunDeps {
  readonly db: Database;
  readonly env: ExtensionRunGrantEnv;
  readonly gate: ExtensionRunGate;
  readonly now: () => number;
}

export interface ApproveExtensionRunResult {
  readonly id: string;
  readonly serviceId: string;
  readonly version: string;
  readonly treeDigest: string;
  readonly grants: ResolvedRunGrants;
  readonly changed: boolean;
}

function requireRow(db: Database, id: string): ExtensionRow {
  const row = listExtensions(db).find((r) => r.id === id);
  if (row === undefined) {
    throw new ExtensionRunGrantError("ERR_EXTENSION_NOT_FOUND", `extension "${id}" is not installed`);
  }
  return row;
}

function digestOrNull(installPath: string): string | null {
  try {
    return computeExtensionTreeDigest(installPath);
  } catch {
    return null;
  }
}

/** Every refusal that needs no prompt. Returns the live tree digest, which equals the row's. */
function assertRunnable(row: ExtensionRow): string {
  if (row.enabled !== 1) {
    throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_DISABLED", `${row.id} is disabled`);
  }
  // `extension.enable` flips `enabled` back without re-verifying the I16 signature, so a row the
  // startup pass hard-disabled can be enabled=1 again with its signature still failed. Refuse it.
  // The full I16 re-verification is the spawn path's (PR 3, `readVerifiedExtensionForSpawn`).
  const signatureReason = signatureDisabledRegistry.reasonFor(row.id);
  if (signatureReason !== undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id} failed publisher signature verification at startup (${signatureReason}); see \`nimbus extension info ${row.id}\``,
    );
  }
  if (!verifyOneExtensionStrict(row)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_UNVERIFIED",
      `${row.id}'s manifest or entry no longer matches what was installed; reinstall it`,
    );
  }
  if (row.tree_digest === null) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NO_DIGEST",
      `${row.id} has no recorded tree digest; review its files and run \`nimbus extension rehash ${row.id}\` first`,
    );
  }
  const live = digestOrNull(row.install_path);
  if (live !== row.tree_digest) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_TREE_CHANGED",
      `${row.id}'s files changed since they were approved; review them and run \`nimbus extension rehash ${row.id}\``,
    );
  }
  return live;
}

function readManifest(row: ExtensionRow): ExtensionManifest {
  const p = resolveExtensionManifestPath(row.install_path);
  if (p === undefined) {
    throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_UNVERIFIED", `${row.id} has no manifest`);
  }
  return parseExtensionManifestJson(readFileSync(p, "utf8"));
}

/**
 * What the owner sees under `extension.run`. Exported for its redaction test.
 *
 * The publisher field is `fingerprint`, NOT `keyFingerprint`: the consent display and the audit row
 * both redact any field whose NAME contains "key" (`executor.ts` `SENSITIVE_PAYLOAD_KEY`), which
 * would hide the one value that tells two publishers with the same id apart. Same name and shape as
 * the install prompt's (`install-from-local.ts`), which hit this first.
 */
export function buildRunConsentPayload(
  row: ExtensionRow,
  manifest: ExtensionManifest,
  serviceId: string,
  treeDigest: string,
  grants: ResolvedRunGrants,
  env: ExtensionRunGrantEnv,
): Record<string, unknown> {
  let installPath = row.install_path;
  try {
    // Canonical, like every resolved grant beside it, so the prompt shows one path form.
    installPath = env.realpath(row.install_path);
  } catch {
    // Keep the stored spelling; assertRunnable already proved the package is on disk.
  }
  return {
    id: row.id,
    version: row.version,
    serviceId,
    publisher:
      manifest.publisher === undefined
        ? "unsigned"
        : {
            id: manifest.publisher.id,
            fingerprint: publisherKeyFingerprint(manifest.publisher.key),
          },
    treeDigest,
    network: [...grants.network],
    read: [...grants.read],
    write: [...grants.write],
    // Added by the runtime at every spawn, read-only. Shown, never stored (spec § 11 item 7).
    runtimeRead: [installPath, ...env.runtimeReadPaths],
    modelAccess: false,
  };
}

/** Re-resolved grants, serialized; `null` when they no longer resolve at all. */
function reresolvedGrants(
  manifest: ExtensionManifest,
  installPath: string,
  env: ExtensionRunGrantEnv,
): string | null {
  try {
    return serializeRunGrants(resolveExtensionRunGrants(manifest.permissions, installPath, env));
  } catch {
    return null;
  }
}

/**
 * Approves an installed extension to run (spec § 4.4). Resolves everything first and refuses —
 * without prompting — anything the owner could not sensibly approve; then asks under
 * `extension.run` over the RESOLVED values; then re-checks the bytes, since the human is the
 * boundary and what they saw must be what is granted; and only then stores the grant.
 */
export async function approveExtensionRun(
  extensionId: string,
  deps: ApproveExtensionRunDeps,
): Promise<ApproveExtensionRunResult> {
  const row = requireRow(deps.db, extensionId);
  const treeDigest = assertRunnable(row);
  const manifest = readManifest(row);
  const grants = resolveExtensionRunGrants(manifest.permissions, row.install_path, deps.env);
  const existing = getRunGrant(deps.db, row.id);
  // Never recomputed once stored, so a slug-rule change cannot move an existing extension's tools.
  const serviceId = existing?.service_id ?? deriveExtensionServiceId(row.id);
  if (existing === null) {
    assertExtensionServiceIdFree(
      serviceId,
      listRunGrants(deps.db).map((g) => g.service_id),
    );
  }
  const permissionsJson = serializeRunGrants(grants);
  const base = { id: row.id, serviceId, version: row.version, treeDigest, grants };
  if (
    existing !== null &&
    existing.version === row.version &&
    existing.tree_digest === treeDigest &&
    existing.permissions_json === permissionsJson
  ) {
    return { ...base, changed: false };
  }

  const approved = await deps.gate({
    type: EXTENSION_RUN_ACTION_TYPE,
    payload: buildRunConsentPayload(row, manifest, serviceId, treeDigest, grants, deps.env),
  });
  if (!approved) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_NOT_APPROVED",
      `running ${row.id} was not approved`,
    );
  }

  const after = listExtensions(deps.db).find((r) => r.id === row.id);
  if (
    after === undefined ||
    after.enabled !== 1 ||
    after.version !== row.version ||
    after.tree_digest !== treeDigest ||
    digestOrNull(after.install_path) !== treeDigest ||
    // The digest covers only the install tree. A declared path OUTSIDE it (or a symlink along it)
    // can be retargeted — into the data dir, say — while the prompt is open, so the grants are
    // resolved again and must still be exactly what the owner saw.
    reresolvedGrants(manifest, after.install_path, deps.env) !== permissionsJson
  ) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_RUN_CHANGED",
      `${row.id} changed while approval was pending; nothing was granted`,
    );
  }
  upsertRunGrant(deps.db, {
    extension_id: row.id,
    service_id: serviceId,
    version: row.version,
    tree_digest: treeDigest,
    permissions_json: permissionsJson,
    model_access: 0,
    approved_at: deps.now(),
  });
  return { ...base, changed: true };
}

/**
 * Withdraws a run approval. Not gated: it only narrows. Stops the extension's client best-effort —
 * a stop failure never fails the revoke, since the grant is already gone.
 */
export async function revokeExtensionRun(
  db: Database,
  extensionId: string,
  stop?: (id: string) => Promise<void>,
): Promise<{ id: string; revoked: boolean }> {
  requireRow(db, extensionId);
  const revoked = deleteRunGrant(db, extensionId);
  if (revoked && stop !== undefined) {
    try {
      await stop(extensionId);
    } catch {
      // The grant is gone; the runtime (PR 3) re-checks it before every spawn.
    }
  }
  return { id: extensionId, revoked };
}
```

Check that `ExtensionManifest` is exported from `manifest.ts` (it is a `export type` there) and `publisherKeyFingerprint` from `install-from-local.ts` (it is). If importing `install-from-local.ts` pulls a cycle, move `publisherKeyFingerprint` into a small `extensions/publisher-fingerprint.ts` and re-import it from both — a wrapper, not a re-export, if any importer must keep the old path.

- [ ] **Step 3a: Anchor D33(b)**

In `scripts/structure-audit/check-nimbus-invariants.ts`, add to `RULE_ANCHORS`, so `verifyRuleAnchors()` fails if `iterateSourceFiles()` ever stops reaching `extensions/`. Anchor on a file the rule SCANS, never an allow-listed one (allow-listed files are skipped, so an anchor there proves nothing — the comment at the existing `graph-entity-flat-coowned` anchor makes the same point):

```ts
  "packages/gateway/src/extensions/approve-run.ts", // D33(b) — scanned; the run-grant store's main caller
```

- [ ] **Step 4: Run the tests and the static audit**

Run: `cd packages/gateway && bun test src/extensions/run-state.test.ts src/extensions/approve-run.test.ts && cd ../.. && bun scripts/structure-audit/check-nimbus-invariants.ts`
Expected: PASS, and the audit reports no missing anchor and no D33(b) violation.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/approve-run.ts packages/gateway/src/extensions/approve-run.test.ts packages/gateway/src/extensions/run-state.ts packages/gateway/src/extensions/run-state.test.ts scripts/structure-audit/check-nimbus-invariants.ts
git commit -F <msg-file>   # "feat(extensions): approve and revoke an extension run grant"
```

---

### Task 5: IPC wiring, the I2 action type, LAN, list/info

**Files:**
- Modify: `packages/gateway/src/ipc/automation-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (`OWNER_GATED_EXTENSION_METHODS`, `dispatchExtensionAutomationRpc`)
- Modify: `packages/gateway/src/engine/executor.ts` (`HITL_REQUIRED_BACKING`)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (`FORBIDDEN_OVER_LAN`)
- Modify: `packages/gateway/src/ipc/server/demo-gate.ts` (`DEMO_REFUSED_METHODS`) and `packages/gateway/src/ipc/server/demo-gate.test.ts` — spec § 4.8: a demo-rooted gateway (I41) refuses both
- Modify: `packages/gateway/src/ipc/gateway-events.ts` (`ExtensionStateChangedPayload.action` gains `"approveRun" | "revokeRun"`)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I2 block)
- Create: `packages/gateway/src/ipc/automation-rpc.run-grant.test.ts`

**Interfaces:**
- Consumes: Task 4's `approveExtensionRun`, `revokeExtensionRun`, `extensionRunFields`; Task 3's `getRunGrant`, `listRunGrants`; Task 2's `ExtensionRunGrantError`, `ExtensionRunGrantEnv`.
- Produces: IPC `extension.approveRun({ id }) → ApproveExtensionRunResult`; `extension.revokeRun({ id }) → { id, revoked }`; `extension.list` items and `extension.info`'s `extension` gain `runGrant` and `runState`; `dispatchAutomationRpc` accepts `runGrantEnv?: ExtensionRunGrantEnv`.

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/ipc/automation-rpc.run-grant.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setExtensionTreeDigest } from "../automation/extension-store.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { getRunGrant } from "../extensions/run-grant-store.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAutomationRpc } from "./automation-rpc.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function installed(): Promise<{
  db: Database;
  installPath: string;
  env: ExtensionRunGrantEnv;
}> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-rpc-run-grant-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  writeFileSync(
    join(src, "nimbus.extension.json"),
    JSON.stringify({ id: "rpc.run", version: "1.0.0", entry: "dist/index.js" }),
  );
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  const extensionsDir = join(root, "data", "extensions");
  await dispatchAutomationRpc({
    method: "extension.install",
    params: { sourcePath: src },
    db,
    extensionsDir,
    ownerGate: async () => true,
  });
  return {
    db,
    installPath: join(extensionsDir, "rpc.run"),
    env: {
      platform: process.platform,
      protectedRoots: [join(root, "data")],
      runtimeReadPaths: [],
      realpath: (p) => realpathSync.native(p),
    },
  };
}

type ListItem = { id: string; runState: string; runGrant: { serviceId: string } | null };

async function listed(db: Database): Promise<ListItem[]> {
  const out = (await dispatchAutomationRpc({ method: "extension.list", params: {}, db })) as {
    value: { extensions: ListItem[] };
  };
  return out.value.extensions;
}

describe("extension.approveRun / extension.revokeRun over the automation dispatcher", () => {
  test("refuses without the owner gate, and without the run-grant env", async () => {
    const { db, env } = await installed();
    await expect(
      dispatchAutomationRpc({ method: "extension.approveRun", params: { id: "rpc.run" }, db, runGrantEnv: env }),
    ).rejects.toThrow(/requires the owner's HITL gate/);
    await expect(
      dispatchAutomationRpc({
        method: "extension.approveRun",
        params: { id: "rpc.run" },
        db,
        ownerGate: async () => true,
      }),
    ).rejects.toThrow(/not configured to resolve extension run grants/);
  });

  test("an unknown id is -32602 'Extension not found' on both methods", async () => {
    const { db, env } = await installed();
    for (const method of ["extension.approveRun", "extension.revokeRun"]) {
      const err = await dispatchAutomationRpc({
        method,
        params: { id: "nope" },
        db,
        runGrantEnv: env,
        ownerGate: async () => true,
      }).catch((e: unknown) => e);
      expect((err as { rpcCode?: number }).rpcCode, method).toBe(-32602);
      expect((err as Error).message, method).toBe("Extension not found");
    }
  });

  test("a denial is -32603 and an unsatisfiable grant -32602", async () => {
    const { db, env } = await installed();
    const denied = await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      ownerGate: async () => false,
    }).catch((e: unknown) => e);
    expect((denied as { rpcCode?: number }).rpcCode).toBe(-32603);
    expect((denied as Error).message).toMatch(/ERR_EXTENSION_RUN_NOT_APPROVED/);
  });

  test("list and info move no_grant → ready → grant_stale → no_grant", async () => {
    const { db, env, installPath } = await installed();
    expect((await listed(db))[0]).toMatchObject({ runState: "no_grant", runGrant: null });

    await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      ownerGate: async () => true,
    });
    expect((await listed(db))[0]).toMatchObject({
      runState: "ready",
      runGrant: { serviceId: "ext_rpc_run" },
    });
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "rpc.run" },
      db,
    })) as { value: { extension: { runState: string } } };
    expect(info.value.extension.runState).toBe("ready");

    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    setExtensionTreeDigest(db, "rpc.run", computeExtensionTreeDigest(installPath));
    expect((await listed(db))[0]?.runState).toBe("grant_stale");

    const stopped: string[] = [];
    const revoked = (await dispatchAutomationRpc({
      method: "extension.revokeRun",
      params: { id: "rpc.run" },
      db,
      mesh: {
        stopExtensionClient: async (id: string) => {
          stopped.push(id);
        },
      },
    })) as { value: { revoked: boolean } };
    expect(revoked.value.revoked).toBe(true);
    expect(stopped).toEqual(["rpc.run"]);
    expect((await listed(db))[0]).toMatchObject({ runState: "no_grant", runGrant: null });
  });

  test("approve and revoke announce extension.stateChanged; an unchanged re-approval does not", async () => {
    const { db, env } = await installed();
    const seen: Array<{ extensionId: string; action: string; ok: boolean }> = [];
    setGatewayEventBroadcast((method, params) => {
      const p = params as { kind?: string; payload?: { extensionId: string; action: string; ok: boolean } };
      if (method === "gateway.event" && p.kind === "extension.stateChanged" && p.payload) {
        seen.push(p.payload);
      }
    });
    try {
      const approve = () =>
        dispatchAutomationRpc({
          method: "extension.approveRun",
          params: { id: "rpc.run" },
          db,
          runGrantEnv: env,
          ownerGate: async () => true,
        });
      await approve();
      await approve();
      await dispatchAutomationRpc({ method: "extension.revokeRun", params: { id: "rpc.run" }, db });
      expect(seen.map((s) => `${s.action}:${String(s.ok)}`)).toEqual([
        "approveRun:true",
        "revokeRun:true",
      ]);
    } finally {
      setGatewayEventBroadcast(undefined);
    }
  });

  test("extension.remove removes the grant", async () => {
    const { db, env } = await installed();
    await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      ownerGate: async () => true,
    });
    await dispatchAutomationRpc({ method: "extension.remove", params: { id: "rpc.run" }, db });
    expect(getRunGrant(db, "rpc.run")).toBeNull();
  });
});
```

In `packages/gateway/src/security-invariants.test.ts`, inside `describe("I2 — HITL frozen-set membership", …)`, after the `extension.install` test, add (import `realpathSync` from `node:fs` at the top if it is not already imported):

```ts
  test("extension.run is not merely listed: approveRun REFUSES without the executor gate and grants nothing on a denial", async () => {
    const { HITL_REQUIRED } = await import("./engine/executor.ts");
    expect(HITL_REQUIRED.has("extension.run")).toBe(true);
    const { dispatchAutomationRpc } = await import("./ipc/automation-rpc.ts");
    const { listRunGrants } = await import("./extensions/run-grant-store.ts");
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i2-ext-run-")));
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const src = join(tmp, "src");
      mkdirSync(join(src, "dist"), { recursive: true });
      writeFileSync(
        join(src, "nimbus.extension.json"),
        JSON.stringify({ id: "i2.run", version: "1.0.0", entry: "dist/index.js" }),
      );
      writeFileSync(join(src, "dist", "index.js"), "export {}\n");
      await dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db,
        extensionsDir: join(tmp, "extensions"),
        ownerGate: async () => true,
      });
      const runGrantEnv = {
        platform: process.platform,
        protectedRoots: [join(tmp, "data")],
        runtimeReadPaths: [],
        realpath: (p: string) => realpathSync.native(p),
      };
      const base = { method: "extension.approveRun", params: { id: "i2.run" }, db, runGrantEnv };
      await expect(dispatchAutomationRpc(base)).rejects.toThrow(/requires the owner's HITL gate/);
      const asked: string[] = [];
      await expect(
        dispatchAutomationRpc({
          ...base,
          ownerGate: async (a) => {
            asked.push(a.type);
            return false;
          },
        }),
      ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_APPROVED/);
      expect(asked).toEqual(["extension.run"]);
      expect(listRunGrants(db)).toEqual([]);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/gateway && bun test src/ipc/automation-rpc.run-grant.test.ts src/security-invariants.test.ts -t "extension.run|approveRun|revokeRun|list and info|extension.remove removes"`
Expected: FAIL — unknown fields/handlers (`extension.approveRun` returns `{ kind: "miss" }`), `extension.run` not in the set.

- [ ] **Step 3: Implement in `automation-rpc.ts`**

Add imports:

```ts
import { approveExtensionRun, revokeExtensionRun } from "../extensions/approve-run.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { ExtensionRunGrantError } from "../extensions/run-grant-error.ts";
import { getRunGrant, listRunGrants } from "../extensions/run-grant-store.ts";
import { extensionRunFields } from "../extensions/run-state.ts";
```

Add `runGrantEnv?: ExtensionRunGrantEnv;` to `AutomationCtx` and to `dispatchAutomationRpc`'s options, and copy it into `ctx` exactly like `ownerGate`:

```ts
    ...(options.runGrantEnv !== undefined && { runGrantEnv: options.runGrantEnv }),
```

Add to `AUTOMATION_HANDLERS`, after `"extension.rehash"`:

```ts
  "extension.approveRun": async (rec, ctx) => handleExtensionApproveRun(rec, ctx),

  "extension.revokeRun": async (rec, ctx) => handleExtensionRevokeRun(rec, ctx),
```

Add the handlers next to `handleExtensionRehash`:

```ts
/** A refusal that happened AFTER the owner was involved is an internal-class error, like rehash's. */
const RUN_GRANT_POST_CONSENT: ReadonlySet<string> = new Set([
  "ERR_EXTENSION_RUN_NOT_APPROVED",
  "ERR_EXTENSION_RUN_CHANGED",
]);

function runGrantRpcError(e: unknown): unknown {
  if (!(e instanceof ExtensionRunGrantError)) return e;
  if (e.code === "ERR_EXTENSION_NOT_FOUND") {
    return new AutomationRpcError(-32602, "Extension not found");
  }
  return new AutomationRpcError(RUN_GRANT_POST_CONSENT.has(e.code) ? -32603 : -32602, e.message);
}

/**
 * Approve an installed extension to RUN (extension-runtime § 4.4): a second, separate approval from
 * install, asked under `extension.run`. Nothing spawns it yet — the runtime is PR 3.
 */
async function handleExtensionApproveRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.approveRun requires the owner's HITL gate");
  }
  const env = ctx.runGrantEnv;
  if (env === undefined) {
    throw new AutomationRpcError(
      -32603,
      "Gateway is not configured to resolve extension run grants",
    );
  }
  try {
    const out = await approveExtensionRun(id, { db: ctx.db, env, gate: ownerGate, now: Date.now });
    // `list`/`info` now carry runState, so a connected client must hear that it moved — as it
    // already does for install/enable/disable/remove/update. An unchanged re-approval moved nothing.
    if (out.changed) {
      emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "approveRun", ok: true });
    }
    return { kind: "hit", value: out };
  } catch (e) {
    emitGatewayEvent("extension.stateChanged", {
      extensionId: id,
      action: "approveRun",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    throw runGrantRpcError(e);
  }
}

async function handleExtensionRevokeRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const mesh = ctx.mesh;
  try {
    const out = await revokeExtensionRun(
      ctx.db,
      id,
      mesh === undefined ? undefined : (x) => mesh.stopExtensionClient(x),
    );
    if (out.revoked) {
      emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "revokeRun", ok: true });
    }
    return { kind: "hit", value: out };
  } catch (e) {
    throw runGrantRpcError(e);
  }
}
```

Note the order in `handleExtensionApproveRun`: the gate and env checks come BEFORE the not-found check. The test "an unknown id is -32602" supplies both, so it still reaches not-found. Keep that order (it matches `handleExtensionRehash`).

Decorate list and info. Change `ExtensionListItem` and `decorateExtensionList`:

```ts
type ExtensionListItem = ExtensionRow &
  ReturnType<typeof extensionRunFields> & {
    disabled_reason?: typeof PRE_T2_DISABLE_REASON | SignatureDisableReason;
    needs_reinstall?: boolean;
    signature_disabled?: boolean;
  };

function decorateExtensionList(
  rows: readonly ExtensionRow[],
  grants: ReadonlyMap<string, ExtensionRunGrantRow>,
): ExtensionListItem[] {
  const preT2 = new Set(preT2DisabledIds());
  const signature = new Map(signatureDisabledRegistry.list().map((e) => [e.id, e.reason]));
  return rows.map((r) => {
    const run = extensionRunFields(r, grants.get(r.id) ?? null);
    if (preT2.has(r.id)) {
      return { ...r, ...run, disabled_reason: PRE_T2_DISABLE_REASON, needs_reinstall: true };
    }
    const reason = signature.get(r.id);
    if (reason !== undefined) {
      return { ...r, ...run, disabled_reason: reason, signature_disabled: true };
    }
    return { ...r, ...run };
  });
}
```

(import `type ExtensionRunGrantRow` from `../extensions/run-grant-store.ts`), and in `handleExtensionList`:

```ts
  const grants = new Map(listRunGrants(ctx.db).map((g) => [g.extension_id, g]));
  const all = decorateExtensionList(listExtensions(ctx.db), grants);
```

In `handleExtensionInfo`, after `const rev = reverseDeps(ctx.db, row.id);` add `const run = extensionRunFields(row, getRunGrant(ctx.db, row.id));` and spread `...run,` into the `extension` object of ALL THREE return branches (pre-T2, signature-disabled, normal), right after `...row,`.

- [ ] **Step 4: Wire the dispatcher, the I2 set and the LAN denylist**

In `packages/gateway/src/ipc/server/dispatchers.ts`:

```ts
import { resolveRuntimeById } from "../../exec/exec-runtimes.ts";
import type { ExtensionRunGrantEnv } from "../../extensions/extension-run-grants.ts";
import { defaultUserMcpRealpath } from "../connector-rpc-handlers/config.ts";
```

(adjust the relative paths to how this file already imports from `src/`). Extend the set:

```ts
const OWNER_GATED_EXTENSION_METHODS: ReadonlySet<string> = new Set([
  "extension.install",
  "extension.rehash",
  "extension.approveRun",
]);
```

Add:

```ts
/**
 * What `extension.approveRun` resolves grants against: the same protected roots user MCP refuses
 * (`[dataDir, configDir, sandboxDir]`) and the Bun runtime's read paths, shown in the prompt. No mesh
 * means no protected roots to check against, so the method refuses rather than skipping the check.
 */
function buildExtensionRunGrantEnv(ctx: ServerCtx, method: string): ExtensionRunGrantEnv | undefined {
  const mesh = ctx.options.connectorMesh;
  if (method !== "extension.approveRun" || mesh === undefined) return undefined;
  return {
    platform: process.platform,
    protectedRoots: mesh.userMcpProtectedRoots(),
    runtimeReadPaths: resolveRuntimeById("bun").requiredReadPaths(),
    realpath: defaultUserMcpRealpath,
  };
}
```

and in `dispatchExtensionAutomationRpc`, next to `ownerGate`:

```ts
    const runGrantEnv = buildExtensionRunGrantEnv(ctx, method);
    …
      ...(runGrantEnv === undefined ? {} : { runGrantEnv }),
```

No change is needed in `tryDispatchAutomationRpc`: its `method.startsWith("extension.")` arm already routes both new methods. Task 6 proves that over a real socket.

In `packages/gateway/src/engine/executor.ts`, after `"extension.install",` in `HITL_REQUIRED_BACKING`:

```ts
  // Extension runtime § 4.4: approving an installed extension to RUN, unattended, with resolved
  // grants. A separate consent from install. Gate site: extensions/approve-run.ts.
  "extension.run",
```

In `packages/gateway/src/ipc/lan-rpc.ts`, after `"extension.rehash", …` in `FORBIDDEN_OVER_LAN`:

```ts
  "extension.approveRun", // approves running third-party code unattended — CLI-only, like install
  "extension.revokeRun", // CLI-only alongside approveRun
```

In `packages/gateway/src/ipc/server/demo-gate.ts`, add both to `DEMO_REFUSED_METHODS` (spec § 4.8 — a demo-rooted gateway is inert and must not mutate run grants), after `"extension.install"`:

```ts
  "extension.approveRun",
  "extension.revokeRun",
```

and extend the existing `test.each(["vault.set", "vault.delete", "data.import", "extension.install"])` in `packages/gateway/src/ipc/server/demo-gate.test.ts` with `"extension.approveRun"` and `"extension.revokeRun"`.

In `packages/gateway/src/ipc/gateway-events.ts`, widen `ExtensionStateChangedPayload.action` to `"install" | "enable" | "disable" | "remove" | "update" | "approveRun" | "revokeRun"`. `nimbus tail` renders `action` as a plain string (`packages/cli/src/commands/tail.ts`), so it needs no change.

- [ ] **Step 5: Run the tests and every suite these files feed**

Run: `cd packages/gateway && bun test src/ipc src/engine src/extensions src/automation src/security-invariants.test.ts`
Expected: PASS. If `executor-flagship.test.ts` or a dispatcher-wiring test pins a COUNT or an enumeration that now includes the new entries, update that expectation by name (re-derive the list; do not just bump the number). If `src/ipc/ipc.test.ts` or another test asserts the exact key set of an `extension.list` item, add `runGrant` / `runState` there.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/automation-rpc.ts packages/gateway/src/ipc/automation-rpc.run-grant.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/engine/executor.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/server/demo-gate.ts packages/gateway/src/ipc/server/demo-gate.test.ts packages/gateway/src/ipc/gateway-events.ts packages/gateway/src/security-invariants.test.ts
# plus any count/enumeration test you updated in step 5
git commit -F <msg-file>   # "feat(extensions): extension.approveRun / revokeRun behind the extension.run HITL gate"
```

---

### Task 6: Prove the routing over a real socket

**Files:**
- Create: `packages/gateway/test/e2e/_fixtures/real-gateway-client.ts` (moved out of `explain-last.e2e.test.ts`)
- Modify: `packages/gateway/test/e2e/explain-last.e2e.test.ts` (import the fixture instead of defining it)
- Create: `packages/gateway/test/e2e/extension-run-grant.e2e.test.ts`

**Interfaces:**
- Produces: `class TinyIpcClient { connect(socketPath: string): Promise<void>; raw(method: string, params: unknown): Promise<RpcReply>; call<T>(method: string, params: unknown): Promise<T>; disconnect(): void }`, `type RpcReply`, `startRealGateway(tag: string): Promise<{ socketPath: string; stop: () => Promise<void> }>`, `BOOT_TIMEOUT_MS`, `TEST_TIMEOUT_MS`.

- [ ] **Step 1: Move the fixture**

Create `packages/gateway/test/e2e/_fixtures/real-gateway-client.ts` by MOVING, verbatim, from `explain-last.e2e.test.ts`: the `RUNNER`, `BOOT_TIMEOUT_MS`, `TEST_TIMEOUT_MS` constants, `pipeOrSocket`, `until`, `RpcReply`, `TinyIpcClient`, and `startTestGateway` (renamed `startRealGateway`). Export `TinyIpcClient`, `RpcReply`, `startRealGateway`, `BOOT_TIMEOUT_MS`, `TEST_TIMEOUT_MS`. Three edits while moving:
- `RUNNER` becomes `join(import.meta.dir, "gateway-runner.ts")` (the fixture now sits next to the runner).
- The temp-dir prefix and the Windows pipe name use `nimbus-e2e-${tag}` instead of `nimbus-explainlast-${tag}`.
- Keep the header comment explaining why a real socket matters, generalised to "a handler wired into an inner dispatcher without the outer router's match".

In `explain-last.e2e.test.ts`, delete the moved code and add:

```ts
import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";
```

replacing `startTestGateway(` with `startRealGateway(`. Remove imports the test no longer uses (Biome will flag them).

- [ ] **Step 2: Confirm the moved test still passes**

Run: `cd packages/gateway && bun test test/e2e/explain-last.e2e.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 3: Write the routing test**

`packages/gateway/test/e2e/extension-run-grant.e2e.test.ts`:

```ts
// E2E over a REAL gateway socket for the extension run-grant methods (extension-runtime PR 2).
// The handlers live in `ipc/automation-rpc.ts`; a real client reaches them only through
// `ipc/server/dispatchers.ts`'s `tryDispatchAutomationRpc` prefix match AND the owner gate +
// run-grant env that `dispatchExtensionAutomationRpc` builds. A unit test calling
// `dispatchAutomationRpc` directly bypasses all three. "Extension not found" (-32602) proves the
// request reached the handler with BOTH a gate and an env; "Method not found" (-32601) or the
// handler's "not configured" (-32603) would each mean a wiring gap.
import { describe, expect, test } from "bun:test";

import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("extension run grants over a real socket", () => {
  test(
    "approveRun and revokeRun reach their handler through both dispatcher layers",
    async () => {
      const gw = await startRealGateway("extrun");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        for (const method of ["extension.approveRun", "extension.revokeRun"]) {
          const reply = await client.raw(method, { id: "e2e.not.installed" });
          expect(reply.error?.code, method).toBe(-32602);
          expect(reply.error?.message, method).toBe("Extension not found");
        }
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
```

- [ ] **Step 4: Run it**

Run: `cd packages/gateway && bun test test/e2e/extension-run-grant.e2e.test.ts`
Expected: PASS. **Red-prove it:** temporarily remove `"extension.approveRun"` from `OWNER_GATED_EXTENSION_METHODS`, re-run, and see the test fail with -32603 ("requires the owner's HITL gate"); restore.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/test/e2e/_fixtures/real-gateway-client.ts packages/gateway/test/e2e/explain-last.e2e.test.ts packages/gateway/test/e2e/extension-run-grant.e2e.test.ts
git commit -F <msg-file>   # "test(extensions): prove run-grant routing over a real gateway socket"
```

---

### Task 7: CLI `approve` and `revoke`

**Files:**
- Modify: `packages/cli/src/commands/extension.ts`
- Modify: `packages/cli/src/commands/extension.test.ts`

**Interfaces:**
- Consumes: IPC `extension.approveRun` / `extension.revokeRun` (Task 5).
- Produces: `runExtensionApprove(client: IPCClient, args: string[], rest: string[]): Promise<void>`, `runExtensionRevoke(client: IPCClient, rest: string[]): Promise<void>`, `formatRunLine(e): string | null`; `formatExtensionListTable` gains an optional trailing `Run` column.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/commands/extension.test.ts`, import `runExtensionApprove` and `runExtensionRevoke` alongside `runExtensionRehash`, and add (it uses the file's existing `createMockIpcClient` and `out` helpers, exactly as the rehash tests do):

```ts
describe("runExtensionApprove", () => {
  const origOut = process.stdout.isTTY;
  const origIn = process.stdin.isTTY;
  const setTty = (v: boolean): void => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: v });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: v });
  };
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: origOut });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: origIn });
  });

  test("throws when the id is missing", async () => {
    setTty(true);
    const { client } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve"], [])).rejects.toThrow(
      /extension approve <id>/,
    );
  });

  test("refuses in non-TTY mode before any call — there is no --yes", async () => {
    setTty(false);
    const { client, calls } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve", "x"], ["x"])).rejects.toThrow(
      /must be answered at a terminal/,
    );
    expect(calls).toHaveLength(0);
  });

  test("refuses --yes outright", async () => {
    setTty(true);
    const { client, calls } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve", "x", "--yes"], ["x"])).rejects.toThrow(
      /no --yes/,
    );
    expect(calls).toHaveLength(0);
  });

  test("calls extension.approveRun, answers the prompt itself, and says nothing runs yet", async () => {
    setTty(true);
    const handlers = new Map<string, (params: unknown) => void>();
    const { client, calls } = createMockIpcClient(
      [{ id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true }],
      handlers,
    );
    await runExtensionApprove(client, ["approve", "x"], ["x"]);
    expect(calls[0]).toEqual({ method: "extension.approveRun", params: { id: "x" } });
    expect(handlers.has("consent.request")).toBe(true);
    expect(out.stdout).toContain("approved to run as ext_x");
    expect(out.stdout).toContain("Nothing runs it yet");
  });

  test("NIMBUS_SCRIPT_CONSENT_SOURCE cannot answer it", async () => {
    // `registerConsentFor({ kind: "prompt" })` would read this path at registration and throw
    // "script consent source not found". The prompt handler ignores it, so the call goes through.
    setTty(true);
    const prev = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
    process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = join(tmpdir(), "nimbus-no-such-consent.jsonl");
    try {
      const { client, calls } = createMockIpcClient([
        { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true },
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(calls[0]?.method).toBe("extension.approveRun");
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
      else process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = prev;
    }
  });

  test("an unchanged approval says so", async () => {
    setTty(true);
    const { client } = createMockIpcClient([
      { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: false },
    ]);
    await runExtensionApprove(client, ["approve", "x"], ["x"]);
    expect(out.stdout).toContain("already approved");
  });
});

describe("runExtensionRevoke", () => {
  beforeEach(() => {
    out.reset();
  });

  test("throws when the id is missing", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionRevoke(client, [])).rejects.toThrow(/extension revoke <id>/);
  });

  test("calls extension.revokeRun and reports both outcomes", async () => {
    const { client, calls } = createMockIpcClient([
      { id: "x", revoked: true },
      { id: "x", revoked: false },
    ]);
    await runExtensionRevoke(client, ["x"]);
    await runExtensionRevoke(client, ["x"]);
    expect(calls[0]).toEqual({ method: "extension.revokeRun", params: { id: "x" } });
    expect(out.stdout).toContain("run approval revoked");
    expect(out.stdout).toContain("had no run approval");
  });
});
```

If `createMockIpcClient` returns one response per call from its array in order, the two-response revoke test works as written; if it repeats the first, create two clients instead.

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/cli && bun test src/commands/extension.test.ts -t "Approve|Revoke"`
Expected: FAIL — `runExtensionApprove` is not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/commands/extension.ts`, after `runExtensionRehash`:

```ts
/**
 * `nimbus extension approve <id>` — approve an installed extension to RUN with the grants the
 * gateway resolves from its manifest. The gateway asks under `extension.run`. A terminal is
 * required and there is no `--yes`: this consents to running third-party code unattended, which is
 * not something to approve from a script. Nothing runs an approved extension until the extension
 * runtime ships.
 */
export async function runExtensionApprove(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension approve <id>");
  }
  if (hasFlag(args, "--yes") || hasFlag(args, "-y")) {
    throw new Error(
      "nimbus extension approve has no --yes: approving an extension to run must be answered by a person at a terminal.",
    );
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(
      "Refusing to approve running an extension in non-TTY mode: the approval must be answered at a terminal.",
    );
  }
  // The prompt handler DIRECTLY, not `registerConsentFor({ kind: "prompt" })`: that one answers
  // from `NIMBUS_SCRIPT_CONSENT_SOURCE` when it is set, which would let an environment variable
  // approve running third-party code at a terminal — exactly what having no --yes rules out.
  registerConsentPromptHandler(client);
  const out = await client.call<{
    id: string;
    serviceId: string;
    treeDigest: string;
    changed: boolean;
  }>("extension.approveRun", { id });
  console.log(
    out.changed
      ? `${out.id}: approved to run as ${out.serviceId} (tree digest ${out.treeDigest}). Nothing runs it yet: the extension runtime ships in a later release.`
      : `${out.id}: already approved for this code and these grants (${out.serviceId}).`,
  );
}

/** `nimbus extension revoke <id>` — withdraw a run approval. Not gated: it only narrows. */
export async function runExtensionRevoke(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension revoke <id>");
  }
  const out = await client.call<{ id: string; revoked: boolean }>("extension.revokeRun", { id });
  console.log(
    out.revoked ? `${out.id}: run approval revoked` : `${out.id}: had no run approval`,
  );
}
```

Extend the existing `../lib/interactive-ipc-handlers.ts` import with `registerConsentPromptHandler`.

**Human-readable `list` / `info`.** Without this, `runState` only appears under `--json`, and the docs in Task 8 would claim more than the terminal shows.

1. Add to the `ExtensionListEntry` type:
   ```ts
     runState?: string;
     runGrant?: { serviceId: string; approvedAt: number; modelAccess: boolean } | null;
   ```
2. Add `runState?: string;` to `ExtensionListTableRow`, and in `runExtensionList`'s row mapping:
   ```ts
       if (r.runState !== undefined) base.runState = r.runState;
   ```
3. In `formatExtensionListTable`, add a trailing `Run` column ONLY when some row carries a `runState` (an older gateway sends none, and every existing table test passes rows without one, so their exact column layout — including the "Status is the last column" assertion — is unchanged):
   ```ts
     const showRun = rows.some((r) => r.runState !== undefined);
     const headers = showRun
       ? ["ID", "Version", "Publisher", "Status", "Run"]
       : ["ID", "Version", "Publisher", "Status"];
   ```
   and in the row mapping return `showRun ? [...cells, r.runState ?? "-"] : cells`, where `cells` is today's four-element array. The colour rules key on columns 2 and 3, which do not move.
4. Add an exported pure formatter and print it in `runExtensionInfo` right after the `Enabled:` line:
   ```ts
   /** `nimbus extension info`'s run line. Nothing runs an approved extension until the runtime ships. */
   export function formatRunLine(e: Pick<ExtensionListEntry, "runState" | "runGrant">): string | null {
     if (e.runState === undefined) return null;
     if (e.runGrant === undefined || e.runGrant === null) return e.runState;
     const at = new Date(e.runGrant.approvedAt).toISOString();
     return `${e.runState} (${e.runGrant.serviceId}, approved ${at}; not executed until the extension runtime ships)`;
   }
   ```
   ```ts
     const runLine = formatRunLine(e);
     if (runLine !== null) console.log(`Run:       ${runLine}`);
   ```

Tests for these, in `extension.test.ts` (import `formatRunLine` alongside `formatExtensionListTable`):

```ts
describe("run state in human output", () => {
  test("the Run column appears only when rows carry a runState", () => {
    const withRun = formatExtensionListTable(
      [{ id: "ext-a", version: "1.0.0", enabled: 1, runState: "grant_stale" }],
      { isTty: false, noColor: true },
    );
    expect(withRun).toMatch(/ID\s+Version\s+Publisher\s+Status\s+Run/);
    expect(withRun).toContain("grant_stale");
    const without = formatExtensionListTable([{ id: "ext-a", version: "1.0.0", enabled: 1 }], {
      isTty: false,
      noColor: true,
    });
    expect(without).not.toMatch(/\bRun\b/);
  });

  test("formatRunLine", () => {
    expect(formatRunLine({})).toBeNull();
    expect(formatRunLine({ runState: "no_grant", runGrant: null })).toBe("no_grant");
    expect(
      formatRunLine({
        runState: "ready",
        runGrant: { serviceId: "ext_a", approvedAt: 0, modelAccess: false },
      }),
    ).toBe(
      "ready (ext_a, approved 1970-01-01T00:00:00.000Z; not executed until the extension runtime ships)",
    );
  });
});
```

In `dispatchExtensionVoid`, after the `"rehash"` case:

```ts
    case "approve":
      await runExtensionApprove(client, args, rest);
      return true;
    case "revoke":
      await runExtensionRevoke(client, rest);
      return true;
```

In `runExtension`, give `approve` the interactive budget too:

```ts
    sub === "install" || sub === "rehash" || sub === "approve" ? INTERACTIVE_RPC_TIMEOUT_MS : undefined,
```

(update the comment above it to name `approve`), and add ` | approve <id> | revoke <id>` after `rehash <id> [--yes]` in the usage string.

- [ ] **Step 4: Run the CLI tests and the readme gate**

Run: `cd packages/cli && bun test src/commands/extension.test.ts && cd ../.. && bun run audit:readme-cli`
Expected: PASS. If `audit:readme-cli` names a README that lists `nimbus extension` subcommands, add `approve` and `revoke` there.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/src/commands/extension.test.ts
git commit -F <msg-file>   # "feat(cli): nimbus extension approve / revoke"
```

---

### Task 8: Docs, then the full gate

**Files:**
- Modify: `docs/cli-reference.md`, `docs/schema-reference.md`, `docs/architecture.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/commands/nimbus-commands.md`, `.claude/commands/nimbus-file-map.md`, `package.json` (`test:coverage:extensions`)

- [ ] **Step 1: Write the docs**

1. `docs/cli-reference.md` — under `nimbus extension`, add `approve <id>` (TTY only, no `--yes`, asks under `extension.run`, shows id, version, publisher fingerprint or `unsigned`, tree digest, service id, resolved network/read/write, and the read-only paths the runtime adds; refusals `ERR_EXTENSION_GRANT_PROTECTED` / `_SELF_WRITE` / `_PATH_RELATIVE` / `_PATH_MISSING`, `ERR_EXTENSION_SERVICE_ID_*`, `ERR_EXTENSION_RUN_*` with one line each) and `revoke <id>`, and say that `extension list` / `info` now show `runState` and `runGrant`. Keep — do NOT remove — the sentence "Installed extensions are not executed": it is still true, and PR 3 removes it. Add right after it: "An approval (`nimbus extension approve`) records what may run once the runtime ships; it starts nothing today."
2. `docs/schema-reference.md` — add a **V70** entry beside V66's, describing `extension_run_grant` column by column and noting the cascade does not fire on the gateway's connection.
3. `docs/architecture.md` — in the extension section, add the run-grant model (spec § 4.4 as amended by § 11) in a short paragraph; name `extensions/approve-run.ts` and `extensions/run-grant-store.ts`; state D33(b).
4. `docs/CHANGELOG.md` — a new top entry dated the day you finish, "S3: extension runtime PR 2 of 4 — run grants". Cover: what an approval records; the two-approval model; the refusals before consent; what does NOT ship (nothing spawns, `--model`, `"running"`); schema V70; static D33(b); `extension.run` in I2; the two CLI-only, LAN-forbidden methods; Tauri allowlist unchanged at 107; the cascade correction from spec § 11 item 6; and a **Found, not fixed here** line: `extension.enable` re-enables an extension the startup signature pass hard-disabled without re-verifying its signature (`approveRun` refuses such a row, so it cannot gain a run grant, but `list` shows it enabled).
5. `docs/roadmap.md` — the S3 active-slot line and the S3 spine cell: "extension runtime (PR 1 of 4 shipped 2026-10-11)" becomes "(PRs 1–2 of 4 shipped: install gate + tree digest 2026-10-11, run grants <date>)".
6. `docs/SECURITY-INVARIANTS.md` — wherever the I2 frozen set's extension members are listed, add `extension.run`; in the static-rule catalogue add D33(b) with its stated bound.
7. `CLAUDE.md` and `GEMINI.md` (mirror each other) — `schema V68` in the status paragraph becomes `schema V70`; in the **Static complement** paragraph add D33(b) next to D32 ("D33(b), tied to the extension runtime: `extension_run_grant` is named only by its store and its DDL"); in the S3 status sentence, extension runtime PR 2 of 4.

8. **The static-rule ceiling moves D32 → D33.** `scripts/structure-audit/check-status-drift.ts` derives the ceiling as the highest `D<N>` in `check-nimbus-invariants.ts`, and every `D10–D<N>` range in its `CEILING_RANGE_SURFACES` must end at it, so Task 3 turns `bun run audit:status-drift` red until these are swept. Today's three hits: `docs/SECURITY-INVARIANTS.md` (the "Current ceiling" line), `.claude/commands/nimbus-commands.md` (the `audit:invariants` line, whose prose list also gains "extension run-grant table") and `.claude/commands/nimbus-file-map.md`. Re-derive with the grep below rather than trusting this list.
9. **`package.json` `test:coverage:extensions`** is an explicit file list, not a glob. Append the five new test files (`extension-service-id.test.ts`, `extension-run-grants.test.ts`, `run-grant-store.test.ts`, `approve-run.test.ts`, `run-state.test.ts`, each under `packages/gateway/src/extensions/`). This is a developer convenience, not a gate: the enforced per-area floor is `audit:coverage-scopes`, whose Extensions scope already matches `extensions/` by glob (`scripts/coverage-floor/check-scopes.ts`).

- [ ] **Step 2: Grep for every restatement**

Run: `git grep -n "V69\b\|schema V68\|PR 1 of 4\|Installed extensions are not executed\|D10–D32\|D10-D32\|D32\b" -- docs CLAUDE.md GEMINI.md .claude .github .coderabbit.yaml`
Expected: every hit is either updated or deliberately left (the "not executed" sentence stays; a `D32` that names the capture-sink RULE rather than a ceiling stays). Fix any "latest schema" claim that still says V69 and any `D10–D32` range.

- [ ] **Step 3: Run the gates**

Run: `bun run preflight:fast`
Expected: `preflight PASSED`. `audit:status-drift`, `audit:doc-refs` and the I2/LAN/Tauri counts are the likely reds; fix what they name.

Run: `cd packages/gateway && bun test src test/integration/extensions test/e2e/extension-run-grant.e2e.test.ts test/e2e/explain-last.e2e.test.ts && cd ../cli && bun test src/commands/extension.test.ts && cd ../.. && bun run typecheck:tests`
Expected: PASS; `typecheck:tests` reports no regression (advisory on Windows — if it regresses, fix it, it gates on Linux).

- [ ] **Step 4: Strip the spec and plan, commit**

Specs and plans never land on `main`:

```bash
git rm -r --cached docs/superpowers
rm -rf docs/superpowers
git add docs CLAUDE.md GEMINI.md .claude/commands package.json
git commit -F <msg-file>   # "docs: extension runtime PR 2 — run grants (V70, D33(b), extension.run)"
```

Then hand back for review; the PR is opened after the whole-branch review.
