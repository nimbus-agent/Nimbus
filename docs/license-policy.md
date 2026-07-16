# JS / Bun dependency license policy

This policy governs which licenses are acceptable for npm/Bun dependencies pulled into the Nimbus monorepo. It is enforced in CI by the `js-licenses` job in [`.github/workflows/security.yml`](../.github/workflows/security.yml), which runs [`scripts/structure-audit/check-js-licenses.ts`](../scripts/structure-audit/check-js-licenses.ts).

The Rust-side equivalent (`cargo-deny`) lives next to it in the same workflow and is governed separately by `packages/ui/src-tauri/deny.toml`.

## Why this exists

Nimbus ships under a deliberate dual-license model:

| Surface | License | Distribution shape |
|---|---|---|
| `packages/gateway`, `packages/cli`, `packages/mcp-connectors/*` | **AGPL-3.0** | Compiled binaries (`bun build --compile`) bundle runtime deps inline |
| `@nimbus-dev/sdk` (external repo), `packages/client` | **MIT** | Published to npm as source; consumers link transitively |

A transitive dep with an incompatible license can corrupt either half of the model:

- An **AGPL-incompatible** runtime dep (e.g. SSPL) gets inlined into the gateway binary — distribution becomes legally untenable.
- An **AGPL-only** dep imported into the SDK relicenses any consumer that links it — silently breaking the MIT promise to extension authors.

The check exists to catch both classes of failure before merge.

## The allowlist

The default allowlist in [`check-js-licenses.ts`](../scripts/structure-audit/check-js-licenses.ts) is the intersection of "safe under AGPL-3.0 redistribution" and "safe under MIT redistribution":

| License | Why allowed |
|---|---|
| MIT, MIT-0, ISC, 0BSD | Maximally permissive; both AGPL and MIT downstream are unaffected |
| Apache-2.0 | Permissive with patent grant; compatible with both AGPL-3.0 and MIT |
| BSD-2-Clause, BSD-3-Clause | Permissive |
| BlueOak-1.0.0 | Permissive |
| CC0-1.0, Unlicense, WTFPL | Public-domain-equivalent |
| CC-BY-3.0, CC-BY-4.0 | Used for asset/font deps; permissive with attribution |
| MPL-2.0 | File-level copyleft; compatible with bundling under both licenses |
| Python-2.0 | Permissive (legacy) |
| Zlib | Permissive |
| Artistic-2.0 | OSI-approved permissive; appears on Bevry-maintained transitives |

## Why specific licenses are NOT in the allowlist

| License | Why excluded |
|---|---|
| **GPL-2.0, GPL-3.0** (any variant) | Strong copyleft. Compatible with AGPL-3.0 distribution but **not** with MIT distribution — including in the SDK or client would force consumers to relicense. |
| **AGPL-3.0** (any variant) | Same reasoning as GPL: incompatible with the MIT halves. |
| **LGPL-2.1, LGPL-3.0** (any variant) | Weak copyleft. Compatible in dynamic-linking scenarios; problematic when statically inlined by `bun build --compile`. Allow only via `PACKAGE_OVERRIDES` when the linkage model is verified. |
| **EPL-1.0, EPL-2.0** | Eclipse Public License. Weak copyleft with file-level reciprocity. Allow only when the dep is a build-tool that is not redistributed (e.g. `ovsx`). |
| **SSPL** | MongoDB's Server-Side Public License. Not OSI-approved. Hard fail. |
| **BUSL** (Business Source License) | Source-available with use restrictions; not OSI-approved. Hard fail. |
| **Commons Clause**, **Elastic License v2**, **Custom**, "SEE LICENSE IN…" | Non-SPDX; require manual review. Allow only via `PACKAGE_OVERRIDES`. |

## PACKAGE_OVERRIDES

For deps whose `license` field is non-SPDX (`"SEE LICENSE IN LICENSE.txt"`, `"Custom"`, etc.) or whose declared license is not in the allowlist but whose **actual** redistribution terms are acceptable in context, add an entry to `PACKAGE_OVERRIDES` in `check-js-licenses.ts`.

Each override must:

1. Be **version-pinned** as `"name@version"` (so an upgrade re-triggers review).
2. Have an inline comment explaining the manual review outcome — what the actual license terms are, and why they're acceptable.
3. Be reviewed by someone who has read the upstream `LICENSE` / `LICENSE.txt` file.

**The source is authoritative** — `PACKAGE_OVERRIDES` in [`check-js-licenses.ts`](../scripts/structure-audit/check-js-licenses.ts) is the canonical list; the inline comment on each entry records the manual-review outcome. Reproduced here as a navigation aid (point-in-time, expected to drift):

- `@vscode/vsce-sign@2.0.9`, `@vscode/vsce-sign-{linux,win32}-x64@2.0.6` — Microsoft VSCE signing tooling; redistribution permitted by the LICENSE.txt for vsce-driven extension publishing; not bundled into the gateway binary. Bun installs only the platform-matching variant per runner.
- `@img/sharp-libvips-{linux-x64,linuxmusl-x64}@1.2.4` — libvips C library shipped as native binary; LGPL-3.0-or-later. Accepted alongside `sharp` itself (dual-licensed Apache-2.0 OR LGPL, passes via Apache). The exception is intentionally narrow — LGPL-3.0-or-later is **not** in the global allowlist, so a stray pure-LGPL dep elsewhere still trips the gate. LGPL §4d compliance is satisfied by sharp's runtime FFI loading of libvips (dynamic-linking model).
- `flatbuffers@1.12.0` — Apache-2.0 per LICENSE.txt; non-SPDX `license` field is the only reason for the override.
- `ovsx@1.0.1` — EPL-2.0; build-tool only (`publish-vscode.yml`), not redistributed.

When `PACKAGE_OVERRIDES` and this list disagree, the source wins. PRs that add an override should still update the navigation aid above.

## How to add a license to the allowlist

1. Confirm the license is OSI-approved (or you have explicit legal sign-off if not).
2. Check the FSF compatibility matrix for AGPL-3.0 and MIT redistribution.
3. Edit `ALLOWED_LICENSES` in [`check-js-licenses.ts`](../scripts/structure-audit/check-js-licenses.ts) — keep entries roughly grouped by category and add a comment if the addition is non-obvious.
4. Update the table above in this document in the same PR.
5. Re-run `bun run audit:js-licenses` locally to confirm the gate passes.

Drift between the table here and `ALLOWED_LICENSES` is treated as a bug — they must match.

## Running the check locally

```bash
# Full check (CI-equivalent; exits non-zero on any violation)
bun run audit:js-licenses

# Report mode — lists every violation with the file path
bun scripts/structure-audit/check-js-licenses.ts --report
```

The check requires `node_modules/` to exist. Run `bun install` first if it doesn't.

## Limitations

- **Bun-store layout assumed.** The check walks `node_modules/.bun/<name>@<version>+<hash>/node_modules/<name>/package.json`. If Bun's install layout changes substantively, the iterator falls back to a simple hoisted walk; the script's `iterateHoisted` covers the npm-compat case.
- **OR semantics.** When a dep declares `"MIT OR GPL-3.0"`, the check passes on `MIT` being allowed even though `GPL-3.0` would fail standalone. This matches npm convention (the user picks). A hypothetical `"Allowed AND Disallowed"` combination would also pass — virtually unseen in practice; reviewers should catch it via `PACKAGE_OVERRIDES`.
- **No license-text inspection.** The check reads only the `license` / `licenses` field in `package.json`. It does not verify that the actual `LICENSE` file matches. For high-stakes deps, supplement with manual inspection of the upstream LICENSE file.
- **Rust deps not covered.** `cargo-deny` handles the Tauri Rust tree separately. See `packages/ui/src-tauri/deny.toml` for that policy.
