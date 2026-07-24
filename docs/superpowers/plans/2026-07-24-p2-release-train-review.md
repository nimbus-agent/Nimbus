# P2 — Release Train Implementation Plan Review

This document provides a review of the [2026-07-24-p2-release-train.md](./2026-07-24-p2-release-train.md) implementation plan.

---

## 1. Robustness & Error Handling Improvements

### ⚠️ Semver Comparison Safety (`Bun.semver.order` crashes)
* **Context:** In Task 4 (lines 671-673), `Bun.semver.order(chVer, pubVer)` is called directly.
* **Risk:** `Bun.semver.order` throws a runtime error if either argument is not a valid semver. While `pubVer` is sanitized by `selectPublished`'s regex filter, `chVer` is parsed directly from external channel files (brew formulas, scoop manifests, apt index files) which could contain unparseable version strings or format variations (e.g., debian revision suffixes like `0.26.0-1` or epoch prefixes). An uncaught throw will crash the entire audit process.
* **Suggestion:** Wrap `Bun.semver.order` in a try/catch or validate the versions beforehand. If ordering fails, treat the verdict as `"indeterminate"` with a detail message pointing to the semver parse error.
  ```ts
  try {
    const isOk = Bun.semver.order(chVer, pubVer) >= 0;
    results.push(
      isOk
        ? { edge, verdict: "ok", detail: `${ch.kind} ${chVer} >= published ${pubVer}` }
        : { edge, verdict: "stale", detail: `${ch.kind} ${chVer} < published ${pubVer}` }
    );
  } catch (err) {
    results.push({ edge, verdict: "indeterminate", detail: `semver comparison failed for ${chVer} vs ${pubVer}` });
  }
  ```

### ⚠️ `tryLinuxGz` Exception Safety
* **Context:** In Task 5 (lines 923-930), the `tryLinuxGz` function performs decompression and string decoding.
* **Risk:** If the `.gz` payload is corrupted or is not valid gzip data, `Bun.gunzipSync(bytes)` or `new TextDecoder().decode(...)` will throw an error, causing the script to crash.
* **Suggestion:** Wrap the decompression and decoding logic in a `try/catch` block, returning `null` or an `"indeterminate"` reading on failure:
  ```ts
  async function tryLinuxGz(ch: ChannelSpec): Promise<ChannelReading | null> {
    const gz = runGh(["gh", "api", `repos/${ch.repo}/contents/${ch.path}.gz`, "--jq", ".content"]);
    if (!gz.ok) return null;
    try {
      const bytes = Buffer.from(gz.stdout.replace(/\s/g, ""), "base64");
      const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
      return { kind: ch.kind, status: "read", version: parseLinuxVersion(text), covered: null };
    } catch {
      return { kind: ch.kind, status: "indeterminate", version: null, covered: null };
    }
  }
  ```

### 🔍 `ageHours` NaN Handling
* **Context:** In Task 5 (line 819), `ageHours(isoZ)` parses `new Date(isoZ).getTime()`.
* **Risk:** If `isoZ` is an invalid date string, `getTime()` returns `NaN`, and `ageHours` returns `NaN`. In `evaluateTrain` (lines 618, 641), comparing `NaN > graceHours` evaluates to `false`, which might silently mask a phantom release or a stale channel state as `"ok"`.
* **Suggestion:** Handle `NaN` explicitly in `ageHours` to return `Number.POSITIVE_INFINITY` (fail-closed) so that aged checks are triggered rather than bypassed:
  ```ts
  export function ageHours(isoZ: string): number {
    const t = new Date(isoZ).getTime();
    if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
    return (Date.now() - t) / 3_600_000;
  }
  ```

---

## 2. Parsing Strategy Enhancements

### 📦 Linux Multi-Package Index Parsing
* **Context:** In Task 3 (line 393), `parseLinuxVersion` uses a global regex search: `packages.match(/^Version:\s*(.+)$/m)`.
* **Issue:** An apt `Packages` index file typically lists all packages distributed by the repository, separated by double-newlines. If another helper package or dependency is added to the repository in the future and happens to appear first in the `Packages` file, the regex will extract the version of the wrong package.
* **Suggestion:** Scan specifically for the relevant package name block (e.g. `nimbus` or `nimbus-headless`) before extracting the version.
  ```ts
  export function parseLinuxVersion(packages: string): string | null {
    const blocks = packages.split("\n\n");
    for (const block of blocks) {
      if (block.includes("Package: nimbus-headless") || block.includes("Package: nimbus")) {
        const match = block.match(/^Version:\s*(.+)$/m);
        if (match) return match[1].trim();
      }
    }
    return null;
  }
  ```

---

## 3. Open Questions

1. **Winget Package ID Assumptions:** The `wingetDirPath` helper splits the package ID by the first period (`.`) to separate the publisher from the package name. Are all current and future Winget package IDs guaranteed to follow this two-part format (e.g., `Publisher.Package`), or could there be multi-part names (e.g., `Publisher.Group.Package`)? If so, does the directory structure in `winget-pkgs` match the dot separator mapping?
2. **Debian Version String Formats:** Debian package managers sometimes append revision numbers or epoch prefixes to versions (e.g. `1:0.26.0` or `0.26.0-1`). We should verify if our release automation strips these, or if `Bun.semver.order` can handle them correctly. If not, sanitizing the parsed linux version to keep only the pure semver portion is recommended.
