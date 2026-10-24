# Review: Role Packs P3 — PR 1 (Role-Pack Manifest Format & Registry Packs Entry)

**Reviewed plan:** [2026-10-24-role-packs-p3-pr1-pack-format.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/plans/2026-10-24-role-packs-p3-pr1-pack-format.md)  
**Parent spec:** [2026-10-24-role-packs-p3-the-pack-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md) §§ 5.1–5.2  
**Date:** 2026-10-24  

---

## Executive Summary

PR 1 lays the foundational format layer for Role Packs Phase 3:
1. Pure manifest parsing and canonical SHA-256 digest computation in `@nimbus-dev/registry-format` (`role-pack.ts`).
2. Extension of the signed registry index parser (`index-format.ts`) with a non-throwing `readRegistryPacks` reader that isolates malformed pack metadata from breaking extension updates.
3. Cross-package test pinning `ROLE_PACK_ID_RE` against the gateway's `PACK_ID_RE`.

The plan is well-scoped, disciplined, and adheres strictly to the monorepo's architectural boundaries (`registry-format-is-pure`, zero runtime behavior changes in Gateway). Cross-checking the plan against the active codebase reveals **4 critical implementation traps / edge cases to guard against**, **4 open questions / design clarifications**, and **4 concrete plan refinements**.

---

## 1. Implementation Traps & Edge Cases to Guard Against (Must-Address)

### 1.1 `JSON.parse` Native `SyntaxError` Leakage (Task 1)

In Task 1 Step 1:
> *"Tests, each asserting `toThrow` with `ERR_REGISTRY_ROLE_PACK_INVALID` and the named field path in the message unless stated: ... `refuses a non-object document` — `[]`, `null`, `"x"`, and invalid JSON text."*

**The Trap:**
- Calling `JSON.parse(text)` natively throws a JavaScript `SyntaxError` (not a `RegistryError`).
- In `parseRolePackManifest(text: string)`, if `JSON.parse` is not explicitly wrapped in a `try...catch`, the function will leak `SyntaxError`, violating the Global Constraint: *"Errors are `RegistryError` (`src/errors.ts`) with a new code `ERR_REGISTRY_ROLE_PACK_INVALID`"*.

**Recommendation:**
In `parseRolePackManifest`, wrap `JSON.parse` explicitly:
```ts
let raw: unknown;
try {
  raw = JSON.parse(text);
} catch (e) {
  throw new RegistryError(
    "ERR_REGISTRY_ROLE_PACK_INVALID",
    `manifest is not valid JSON: ${(e as Error).message}`,
  );
}
```

---

### 1.2 `assertSafeExtensionId` Error Type Adaptation (Task 1)

In Task 1 Step 3:
> *"members elements go through `assertSafeExtensionId`, its message appended."*

**The Trap:**
- In `packages/registry-format/src/extension-id.ts`, `assertSafeExtensionId(id)` throws a plain `new Error("invalid extension id")` or `new Error("extension id too long...")`, **not** a `RegistryError`.
- If an invalid member (e.g. `["../evil"]`) is encountered and `assertSafeExtensionId` throws directly without interception, a standard `Error` leaks instead of `RegistryError("ERR_REGISTRY_ROLE_PACK_INVALID", ...)`.

**Recommendation:**
Wrap the call to `assertSafeExtensionId` in `parseRolePackManifestValue` and format the detail with the exact index path:
```ts
try {
  assertSafeExtensionId(member);
} catch (e) {
  throw new RegistryError(
    "ERR_REGISTRY_ROLE_PACK_INVALID",
    `members[${i}]: ${(e as Error).message}`,
  );
}
```

---

### 1.3 Prototype Injection Defense in `parseRolePackManifestValue` (Task 1)

In Review Focus 3 & Task 1 Step 1:
> *"a top-level `"__proto__"` key is refused as unknown (JSON.parse makes it an own property)."*

**The Trap:**
- For `parseRolePackManifest(text: string)`, `JSON.parse` creates `"__proto__"` as an own enumerable property, so `Object.keys(raw)` contains `"__proto__"` and will be caught by checking against the allowed keys set.
- However, `parseRolePackManifestValue(raw: unknown)` accepts pre-parsed objects (e.g. static JSON imports or in-memory fixtures). If an object literal was defined with `{ __proto__: ... }` or inherited properties from a modified prototype, `Object.keys(raw)` does not list `"__proto__"`.
- If the object is copied or property-accessed naively, prototype pollution or inherited values could bypass validation.

**Recommendation:**
In `parseRolePackManifestValue`:
1. Check that `typeof raw === "object" && raw !== null && !Array.isArray(raw)`.
2. Verify that `Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null`.
3. Check `Object.keys(raw)` against `ALLOWED_KEYS = new Set(["schema", "id", "name", "version", "description", "roles", "suggestedConnectors", "members", "defaults"])`.
4. Build the returned `RolePackManifest` purely from validated own properties (never spread `raw`).

---

### 1.4 `readRegistryPacks` Error Containment vs Re-throw Boundary (Task 2)

In Task 2 Step 3:
> *"wraps the whole map's parse in one `try`, and on a `RegistryError` returns `{ packs: {}, invalid: err.detail }` (any other error is rethrown — that is a bug, not data)."*

**The Trap:**
- In `packages/registry-format/src/index-format.ts`, helper `invalid(detail)` creates `new RegistryError("ERR_REGISTRY_INDEX_INVALID", detail)`.
- If `parsePackEntry` or `parsePackVersionEntry` throws `invalid(...)`, the error code is `ERR_REGISTRY_INDEX_INVALID`.
- `readRegistryPacks` must catch `RegistryError` specifically via `err instanceof RegistryError`.
- If `index.packs` is `undefined`, it must return `{ packs: {} }` without `invalid`. But if `index.packs` is `null`, `[]`, or a primitive, `asObject(index.packs, "packs")` throws `invalid("packs must be an object")`, which must be caught and returned as `{ packs: {}, invalid: "packs must be an object" }`.

**Recommendation:**
Ensure `readRegistryPacks` follows this pattern:
```ts
export function readRegistryPacks(index: RegistryIndex): RegistryPacksRead {
  if (index.packs === undefined) {
    return { packs: {} };
  }
  try {
    const rawPacks = asObject(index.packs, "packs");
    const packs: Record<string, RegistryPackEntry> = {};
    for (const [id, entry] of Object.entries(rawPacks)) {
      if (!ROLE_PACK_ID_RE.test(id)) {
        throw invalid(`packs.${id} pack id is malformed`);
      }
      packs[id] = parsePackEntry(entry, id);
    }
    return { packs };
  } catch (err) {
    if (err instanceof RegistryError) {
      return { packs: {}, invalid: err.detail };
    }
    throw err;
  }
}
```

---

## 2. Design Clarifications & Open Questions

### 2.1 Exporting `ROLE_TAG_RE` Alongside `ROLE_PACK_ID_RE` and `CONNECTOR_ID_SHAPE_RE`

- The plan exports:
  ```ts
  export const ROLE_PACK_ID_RE: RegExp;
  export const CONNECTOR_ID_SHAPE_RE: RegExp;
  ```
- Each role tag in `roles` is held to `^[a-z][a-z0-9-]{0,31}$`.
- Spec § 5.1 states: *"Project 5 matches on these"*.
- **Question:** Should `ROLE_TAG_RE` (or `ROLE_TAG_SHAPE_RE`) be exported from `role-pack.ts` and `index.ts` alongside `ROLE_PACK_ID_RE` and `CONNECTOR_ID_SHAPE_RE`?
- **Suggestion:** Yes. Exporting `export const ROLE_TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;` avoids regex duplication when Project 5 or future validators consume role tags.

---

### 2.2 Whitespace Normalization in `name` and `description`

- Task 1 Step 1 specifies:
  - `name rules — refuses "", "   ", "x".repeat(81); accepts "x".repeat(80)`.
  - `description rules — refuses "", "x".repeat(501); accepts "x".repeat(500)`.
- **Question:** Does `parseRolePackManifestValue` trim `name` and `description`, or does it preserve surrounding whitespace, or does it refuse untrimmed strings?
- **Impact on Digest:** Because `rolePackDigest` digests the canonical JSON of the parsed object:
  - If `"name": " DevOps "` is kept untrimmed, it yields a different SHA-256 digest than `"name": "DevOps"`, while CLI rendering displays them almost indistinguishably.
  - If `name` is trimmed (`name.trim()`), then `" DevOps "` normalizes to `"DevOps"`.
  - Alternatively, if surrounding whitespace is strictly prohibited (`if (name !== name.trim()) throw ...`), authors are prevented from accidental whitespace typos.
- **Suggestion:** Clarify whether `name` and `description` are trimmed upon parsing or required to be already trimmed (`str === str.trim()`). Recommended: reject surrounding whitespace in `name` (`if (name !== name.trim()) throw ...`), matching `assertCanonicalExtensionId`.

---

### 2.3 Explicit Array Bound on `members`

- In Spec § 5.1:
  - `roles`: ≤ 8
  - `suggestedConnectors`: ≤ 32
  - `members`: no explicit array length cap is specified (only bounded by `MAX_ROLE_PACK_MANIFEST_BYTES = 128 KiB`).
- While Gateway currently rejects non-empty `members`, the format itself allows valid extension IDs (`["com.nimbus.readwise"]`).
- **Question:** Should `members` have an explicit upper limit (e.g. ≤ 32 or ≤ 64) to prevent an unbounded array within the 128 KiB manifest?
- **Suggestion:** Define `MAX_ROLE_PACK_MEMBERS = 32` (or 64) in `caps.ts` for defense-in-depth and symmetry with `suggestedConnectors`.

---

### 2.4 Reusing `isValidSemver` vs. `semver` Package

- Task 1 Interfaces lists: `Consumes: isValidSemver (index-format.ts)`.
- In `index-format.ts`, `isValidSemver` is implemented with a strict `SEMVER_RE` (SemVer 2.0.0 without ranges or leading 'v').
- `packages/registry-format` has `semver` in `dependencies`, but `index-format.ts` deliberately does not use `semver.valid` to prevent loose semver parsing.
- **Confirmation:** Using `isValidSemver` from `./index-format.ts` ensures perfect consistency between extension versions and role pack versions.

---

## 3. Concrete Implementation Refinements

### 3.1 Uniqueness Check and Error Path Formatting for Arrays

In Task 1 Step 3:
> *"array fields check count first, then each element and uniqueness, reporting `field[i]`."*

To ensure exact alignment with the test assertions:
1. Verify length first: `if (arr.length > MAX_COUNT) throw new RegistryError("ERR_REGISTRY_ROLE_PACK_INVALID", `${field}: exceeds maximum of ${MAX_COUNT} entries`);`
2. Track seen items in a `Set<string>()`.
3. For each element `arr[i]`:
   - Validate type and regex shape. If invalid, throw with path `${field}[${i}]`.
   - Validate uniqueness: `if (seen.has(item)) throw new RegistryError("ERR_REGISTRY_ROLE_PACK_INVALID", `${field}[${i}]: duplicate entry "${item}"`);`
   - Add to `seen`.
This ensures duplicate entries always report the index of the offending duplicate (`roles[1]`, `suggestedConnectors[1]`, `members[1]`).

---

### 3.2 Canonical Manifest Path Verification in `parsePackVersionEntry`

In Task 2:
> `manifest: string; // must equal packs/<id>/<version>/manifest.json`

Ensure the canonical path check matches the exact pattern used in `index-format.ts:125-127`:
```ts
const expectedManifest = `packs/${id}/${version}/manifest.json`;
const manifest = str(o, "manifest", what);
if (manifest !== expectedManifest) {
  throw invalid(`${what}.manifest is not canonical`);
}
```

---

### 3.3 `manifestSizeBytes` Bounds and Type Checking

In Task 2 Step 1 & Step 3:
> `manifestSizeBytes 0, 1.5, and MAX_ROLE_PACK_MANIFEST_BYTES + 1;`

In `parsePackVersionEntry`:
```ts
const size = o["manifestSizeBytes"];
if (
  typeof size !== "number" ||
  !Number.isSafeInteger(size) ||
  size <= 0 ||
  size > MAX_ROLE_PACK_MANIFEST_BYTES
) {
  throw invalid(
    `${what}.manifestSizeBytes must be a positive integer <= ${MAX_ROLE_PACK_MANIFEST_BYTES}`,
  );
}
```

---

### 3.4 Gateway Cross-Package Test Path & Import

In Task 1 Step 1:
- File to create: `packages/gateway/src/packs/pack-id-format.test.ts`.
- The test asserts:
  ```ts
  import { ROLE_PACK_ID_RE } from "@nimbus-dev/registry-format";
  import { describe, expect, test } from "bun:test";
  import { PACK_ID_RE } from "../config/pack-settable.ts";

  describe("pack id format parity", () => {
    test("registry-format ROLE_PACK_ID_RE equals the gateway PACK_ID_RE", () => {
      expect(ROLE_PACK_ID_RE.source).toBe(PACK_ID_RE.source);
      expect(ROLE_PACK_ID_RE.flags).toBe(PACK_ID_RE.flags);
    });
  });
  ```
- Note for Step 2 (Red Phase): When running `bun test packages/gateway/src/packs/pack-id-format.test.ts` before Task 1 Step 3 is implemented, the test will fail on import resolution because `ROLE_PACK_ID_RE` is not yet exported from `@nimbus-dev/registry-format`. This is expected behavior for TDD.

---

## 4. Test Matrix & Verification Checklist

| Target File | Verification Command | Focus Area |
|---|---|---|
| `packages/registry-format/src/role-pack.ts` | `bun test packages/registry-format/src/role-pack.test.ts` | UTF-8 byte caps (`defaults`, manifest), BOM stripping, duplicate entries, prototype pollution, semver validity, digest stability across key order |
| `packages/gateway/src/packs/pack-id-format.test.ts` | `bun test packages/gateway/src/packs/pack-id-format.test.ts` | Regex parity between Gateway `PACK_ID_RE` and Registry `ROLE_PACK_ID_RE` |
| `packages/registry-format/src/index-format.ts` | `bun test packages/registry-format/src/index-format.test.ts` | `readRegistryPacks` parsing valid packs, dropping malformed packs without failing index or signature verification, strict canonical path |
| Whole package | `bun test packages/registry-format` | Zero regressions in existing index/manifest tests |
| Preflight | `bun run preflight:fast` | Typecheck, Biome linting, `registry-format-is-pure` boundary check |
| Coverage | `bun test packages/registry-format/src --coverage` | ≥ 85% lines & ≥ 80% branches for `role-pack.ts` and `index-format.ts` |

---

## Conclusion

The implementation plan is solid, robustly designed, and ready for execution with the edge-case protections (JSON parse error trapping, `assertSafeExtensionId` rethrowing, prototype validation, and `ROLE_TAG_RE` export) detailed above incorporated.
