import { describe, expect, test } from "bun:test";
import { read, readDirConcat, readDirFiles } from "../../test/helpers/security-invariants.ts";

describe("I1 — extensionProcessEnv is the only env source for spawned MCP children", () => {
  test("lazy-mesh/ contains no `{ ...process.env` spread", async () => {
    // No closing brace in the pattern. `docs/SECURITY-INVARIANTS.md` writes the anti-pattern as
    // `spawn(..., { env: { ...process.env, EXTRA: ... } })` — and the previous regex,
    // /\{\s*\.\.\.process\.env\s*\}/, required `}` IMMEDIATELY after the spread, so it matched the
    // bare `{ ...process.env }` and missed the exact form the docs name. The leaking form is the
    // one with the comma: that is what a real regression looks like, because the site being
    // rewritten needs to add a variable or two alongside the inherited environment.
    const src = await readDirConcat("packages/gateway/src/connectors/lazy-mesh");
    expect(src).not.toMatch(/\{\s*\.\.\.process\.env\b/);
  });

  test("every env: in a lazy-mesh spawn spec comes from extensionProcessEnv", async () => {
    // Derived, not a hand-picked floor. This was `expect(callers.length).toBeGreaterThanOrEqual(20)`
    // against 80 actual call sites, so 60 of them could regress to a raw spread and the assertion
    // would still pass — and because the old readDirConcat swept in `*.test.ts`, fixtures counted
    // toward that floor too.
    //
    // The real property is not "enough calls exist", it is "no env: resolves to anything else", so
    // this enumerates every `env:` and classifies it. Written as what CANNOT pass: an unrecognised
    // shape fails and is named, rather than an expected shape being counted.
    // Per FILE, not one concatenated blob. `wrap-server-spec.ts` builds the sandbox hop's own env
    // as a multi-line object literal, and the only way to exempt that from a concatenated scan is
    // to exempt the SHAPE — a capture of exactly `{`. That exemption would then apply everywhere,
    // and since the capture stops at the first comma or newline, ANY multi-line env literal in ANY
    // file would match it, including `env: {\n  ...process.env,\n  EXTRA: x,\n}`. Exempting by file
    // keeps the wrapper out of the connector-spec classification without reopening the hole.
    const files = await readDirFiles("packages/gateway/src/connectors/lazy-mesh");
    const WRAPPER = "wrap-server-spec.ts";
    // The iac runner builds its per-run children itself (D2, static D43(d)): its env is checked
    // below, in its own assertion, instead of by this per-file classifier.
    const IAC_RUNNER = "iac-runner.ts";
    const unexplained: string[] = [];
    let wiredSites = 0;
    for (const f of files) {
      if (f.rel === WRAPPER) continue;
      if (f.rel === IAC_RUNNER) {
        // Exactly one child env, built by extensionProcessEnv INSIDE the wrapIacServerSpec call. The
        // connector is the iac one or (D3a) the kubernetes one, chosen by the profile, never by a caller.
        expect(f.contents).toMatch(
          /wrapIacServerSpec\(\s*\{\s*\.\.\.connectorSpawn\(opts\.service \?\? "iac"\),\s*env: extensionProcessEnv\(/,
        );
        expect(f.contents.match(/connectorSpawn\(/g) ?? []).toHaveLength(1);
        continue;
      }
      wiredSites += (f.contents.match(/env\s*:\s*extensionProcessEnv\(/g) ?? []).length;
      const locals = new Set(
        [...f.contents.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*extensionProcessEnv\s*\(/g)].map(
          (m) => m[1] as string,
        ),
      );
      for (const m of f.contents.matchAll(/\benv\s*:\s*([^\n,]{1,60})/g)) {
        const v = (m[1] as string).trim();
        if (v.startsWith("extensionProcessEnv(")) continue;
        // `env: Record<string, string>` is a type annotation or a local builder whose result is
        // handed to extensionProcessEnv; it is never itself a spec's env.
        if (v.startsWith("Record<")) continue;
        // `env: outlookEnv` / `env: gitlabServerEnv` — a local bound to an extensionProcessEnv call
        // a few lines above. Resolved, not exempted: the binding must be in this same file.
        if (locals.has(v.replace(/,$/, ""))) continue;
        unexplained.push(`${f.rel}: env: ${v}`);
      }
    }
    expect(unexplained).toEqual([]);

    // Non-vacuity: the classifier above is satisfied by a scan that found no `env:` at all.
    expect(files.length).toBeGreaterThanOrEqual(13);
    expect(wiredSites).toBeGreaterThanOrEqual(70);
  });

  test("extensionProcessEnv uses an allowlist (BASELINE_KEYS) — denylist would let new secrets leak by default", async () => {
    const src = await read("packages/gateway/src/extensions/spawn-env.ts");
    expect(src).toMatch(/BASELINE_KEYS/);
    expect(src).not.toMatch(/\.\.\.process\.env/);
    expect(src).toMatch(/process\.env\[k\]/);
  });
});
