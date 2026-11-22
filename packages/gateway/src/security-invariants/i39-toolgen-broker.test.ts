import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { grepRepo, REPO_ROOT } from "../../test/helpers/security-invariants.ts";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { buildGeneratedManifest } from "../toolgen/toolgen-stub.ts";
import { ToolgenError } from "../toolgen/toolgen-types.ts";

describe("I39 — generated tools reach the network only through the broker", () => {
  test("a generated manifest always has an EMPTY network set", () => {
    // `permissions.network` is `[]` BY CONSTRUCTION on every platform, mirroring I33's
    // `buildExecPolicy` rule — there is no path that produces a non-empty grant.
    expect(buildGeneratedManifest("tg_a").permissions.network).toEqual([]);
  });

  test("a requested network grant is REJECTED, never dropped", () => {
    // A caller-requested grant must FAIL LOUDLY rather than be silently discarded — a dropped
    // grant looks identical to success from the caller's side, right up until the tool tries to
    // reach a host it was told it could.
    expect(() => buildGeneratedManifest("tg_a", { network: ["api.example.com"] })).toThrow(
      ToolgenError,
    );
  });

  // The confinement probe is I39's substrate: it is what proves, BEFORE the owner is prompted,
  // that this machine can actually confine the policy the tool will spawn under. It had no
  // enforcement test until now, and it needed one — the probe shipped MEASURING NOTHING on all
  // three platforms and no suite noticed, because BOTH test layers injected around
  // `defaultSpawnProbe`: the unit tests through the `spawnProbe` seam and the e2e through its own
  // inline copy. A seam that every layer bypasses leaves the production default unexecuted while
  // the suite stays green. This test is the guard against that specific shape recurring.
  test("no PRODUCTION file injects around defaultSpawnProbe", async () => {
    // BOTH property forms. `spawnProbe:` alone missed ES6 shorthand — a production object written
    // `{ spawnProbe }` would inject around the default and this guard would not see it, which is
    // the allow-list-shaped failure: written as "what I expect to find" instead of "what cannot
    // pass". The three shapes deliberately NOT matched are the only three that exist in production
    // today, and none of them injects: `readonly spawnProbe?:` DECLARES the seam, and
    // `deps.spawnProbe ?? defaultSpawnProbe` READS it (twice — code and its docstring). A `?`
    // follows `spawnProbe` in the first and a space-then-`?` in the others, so neither reaches the
    // `[:,}]` class.
    const injectors = await grepRepo(/spawnProbe\s*[:,}]/);
    expect(injectors).toEqual([]);
  });

  test("the inline probe is static — nothing is interpolated into the code it constructs", async () => {
    const src = await readFile(
      resolve(REPO_ROOT, "packages/gateway/src/toolgen/toolgen-confinement.ts"),
      "utf8",
    );
    const probe = /const INLINE_FS_DENIED_PROBE = \[([\s\S]*?)\]\.join/.exec(src);
    expect(probe).not.toBeNull();
    // A template substitution here would reintroduce the code-construction shape CodeQL flagged,
    // in the one file whose job is proving a security property.
    expect(probe?.[1] ?? "").not.toContain("${");
  });

  test("recordToolEgress is the ONLY tool-class appender in the tree", async () => {
    // A second `sourceType: "tool"` row anywhere else would mean a second, unreviewed path
    // recording brokered egress — exactly the completeness property I29's `tool` class claims.
    const hits = await grepRepo(/sourceType:\s*"tool"/);
    expect(hits).toEqual(["packages/gateway/src/egress/tool-egress.ts"]);
  });

  test("the tool coverage class is per-call", () => {
    // Raised from "none" in the same commit that gave `recordToolEgress` its production caller
    // (`toolgen/toolgen-broker.ts`) — this file's own rule, and the one `browser` followed.
    expect(THIS_BINARY_COVERAGE.tool).toBe("per-call");
  });
});
