# Dedup "Realistic Floor" Program — Wave C Design (shared REST tool registrar)

**Date:** 2026-06-20 · **Branch:** `worktree-dedup-wave-c` (off `origin/main`, post-#696 Wave A)
**Baseline strict `bunx jscpd packages`:** **3.95%** (5234 dup-lines / 520 clones); CI ratchet `.jscpd.json` threshold **4.0**.

## Program context

Wave A (#696) extracted **file-local** REST registrars for two connectors (`registerGitlabTool`, `registerDriveTool`). This wave **generalizes that pattern into a single shared helper** — `makeRestToolRegistrar` in `packages/mcp-connectors/shared/rest-tool-kit.ts` — and applies it across the **ten remaining hand-rolled REST/Graph connectors** that repeat the same tool body:

```ts
reg(name, description, schema, async (args) => {
  const token = requireProcessEnv(<ENV>);
  const res = await <fetch>(token, buildPath(args)[, buildInit(args)]);
  return mcpJsonResultIfOk(<label>, res[, snippetMax]);
});
```

Migrated (10): `circleci`, `discord`, `github`, `github-actions`, `gmail`, `google-meet`, `google-photos`, `onedrive`, `outlook`, `pagerduty`.

## Non-negotiable: pure dedup, zero behavior change

Every existing connector test (`*-sandbox.test.ts`, `*-search-filter.test.ts`, etc.) stays GREEN UNEDITED. No `.jscpd.json` ignore added. Tools with a non-standard tail (custom error text, 204 tolerance, raw-text body, write tools with bespoke shapes) stay hand-written on the connector's own `reg`.

## The helper

`makeRestToolRegistrar(cfg)` returns a per-connector `registerXxxTool(name, description, schema, buildPath, buildInit?)`. The connector supplies its registrar (`createZodToolRegistrar` output), token env, service label, and token-bearing fetcher **once**; each tool then provides only its `name`/`description`/`schema` + a pure `buildPath` (and optional `buildInit` for method/body). The `snippetMax` knob preserves each connector's exact `mcpJsonResultIfOk` body-snippet length (Graph connectors use `200`; default is `300`).

Fidelity is byte-faithful: the helper's body is exactly the old hand-rolled body (`requireProcessEnv → fetch → mcpJsonResultIfOk`). The fetchers are unchanged — Graph connectors keep `graphRequest` (which still applies #694's `resolveUrlWithBase` origin-pinning for `nextLink` SSRF protection); REST connectors keep their existing `connectorFetch`-based fetcher.

## Honest jscpd impact

This wave moves strict **3.95% → 3.93%** (−18 dup-lines, −3 clones). As the realistic-floor analysis predicted, collapsing the *boilerplate* body into a factory leaves the per-tool *specifics* (URL builders, Zod schemas) parallel — jscpd still counts those. The value here is **maintainability** (one tool body, ten connectors) and keeping headroom under the 4.0 gate, not a large number move. The big lever (connector-template codegen) remains a separate future project.

## Dependency / invariant guardrails

- The helper lives in `mcp-connectors/shared/` (the established 19-file precedent for connector-internal helpers — NOT the SDK; no new SDK export, no coverage-floor ratchet).
- I1 (`extensionProcessEnv` child-process env scoping) untouched — fetchers are unchanged.
- #694 connector-boundary hardening (`resolveUrlWithBase` SSRF, `headerLine` CR/LF) preserved — the migration changes only *where* the standard body lives, never the fetchers or schemas.
- ★ Strict tsc loop after the `shared/` change: `for c in gmail outlook teams google-meet google-photos; do bunx tsc -p .../$c/tsconfig.json` (these include `../shared/**`).

## Ship discipline

Full preflight + coverage-floor + markdownlint + lychee + whole-branch review before first push. `git checkout -- docs/structure-audit/` before commit (jscpd auto-regenerates it). **Do not lower the ratchet this wave** (leave 4.0; tighten at program end).
