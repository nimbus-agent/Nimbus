# LLM Model Routes — Slice 2b (Vendors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the first four cloud LLM vendors behind a per-vendor, default-off opt-in; bring the Mastra engine agent onto the same credential path and under the same ledger; and add the generate-time local fallback the roadmap row promises.

**Architecture:** Four `LlmProvider` adapters (three wire formats — xAI reuses OpenAI's) are registered through `LlmRegistry.addRoute`, which slice 2a already made the ledger chokepoint, so every remote generate appends an `egress_ledger` row without the adapters cooperating. Locality is hardcoded `false` on all four (the *inverse* of slice 1's derive-from-`base_url` rule, pinned by I34). The Mastra agent stops reading `getEffectiveAgentModel()` and is constructed only when a vendor is enabled, wrapped at the AI-SDK seam by a decorator over `ModelRouterLanguageModel`.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict (no `any`), `bun:sqlite`, `bun:test`, Biome, `@mastra/core@1.61.0`.

**Spec:** [`docs/superpowers/specs/2026-08-28-llm-model-routes-slice-2-design.md`](../specs/2026-08-28-llm-model-routes-slice-2-design.md) — §4 defines this PR as 2b. Read §6.2–6.4, §7, §10, §11 before starting. Slice 2a (the chokepoint this builds on) shipped as #1357.

---

## Pre-flight findings — read before Task 9

The spec's §6.3 named two things to "verify at implementation time, not assume". **Both were verified on 2026-08-28 against `@mastra/core@1.61.0`, with `globalThis.fetch` stubbed to block every request. Both came back favourable.** Do not re-litigate them; do re-run them on a `@mastra/core` major upgrade.

1. **`{ id, apiKey }` does NOT force an OpenAI-compatible wire.** All three config forms —
   `"anthropic/claude-sonnet-4-6"`, `{ id, apiKey }`, `{ providerId, modelId, apiKey }` — resolve to
   `provider=anthropic, gatewayId=models.dev`, and a real `doGenerate` attempts
   `POST https://api.anthropic.com/v1/messages`, Anthropic's **native** endpoint. An OpenAI-compatible
   fallback would have hit `/v1/chat/completions`. The type name `OpenAICompatibleConfig` is broader
   than its shape.
2. **No metadata egress.** Zero non-inference requests at construction, on awaiting `supportedUrls`
   (`_fetchSupportedUrls`), and during `doGenerate` — the only attempt was the inference call itself.
   This is structural, not a warm-cache artifact: `https://api.anthropic.com` is a **bundled constant**
   in the shipped `dist`, and there is no on-disk registry cache.

**Consequences, which this plan assumes:** the §6.3 escape hatch (hand-writing a `LanguageModelV4`
adapter per vendor) is **not needed**; and §12's conditional "the Mastra metadata exclusion if §6.3's
verification finds one" **does not apply** — do not add that I29 exclusion, because it would document a
gap that does not exist.

## Corrections to the spec, applied by this plan

- **§10 is stale on the LOCAL column.** It says `nimbus llm status` "gains a `LOCAL` column". It already
  has one: `packages/cli/src/commands/llm.ts` carries `local: 7` in `COL_WIDTHS` and `isLocal` in its
  private `RouteStatus`, added by slice 1. What §10 actually still needs is the `not_configured`
  reason and the shape-parity test. Task 10 does those two and does not add a column.
- **§7.2's `PLATFORM_VAULT_KEYS` and `VAULT_KEY_ALLOW_LIST` are in `scripts/structure-audit/check-nimbus-invariants.ts`**,
  not under `packages/gateway/src/`. Task 2 edits that file.

## Global Constraints

- **Per-vendor opt-in is default-off and is NEVER inferred from key presence.** `enabled = false` is
  the default for all four vendors. A credential existing in the Vault or the environment must not
  enable anything. This is the single property the whole slice exists to preserve.
- **No key is ever read from the environment for a route or the agent.** Keys resolve from the Vault
  through an injected `() => Promise<string | undefined>`, per call, so a key added after boot works
  without a restart and no env var can satisfy a vendor nobody opted into.
- **Cloud adapters hardcode `readonly isLocal = false`.** They do NOT derive it from `base_url`. This
  is the inverse of slice 1's rule for local runtimes and is the easiest thing in this slice to get
  backwards. Pinned by invariant I34.
- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Branch:** `git switch -c dev/asaf/llm-model-routes-slice-2b` from an up-to-date `main`. Never
  commit on `main`.
- **Per-task gate** (the whole-repo suite exceeds the 600s tool cap and cannot gate a task):
  `bun run typecheck` + scoped `bun test <paths>` + `bun test packages/gateway/test` (a `src` run never
  loads that tree). The wide suite runs once, in Task 12.
- **Cross-platform:** build paths with `path.join()` / `os.tmpdir()`. Never hardcode separators.
- **No real network call in any test.** Adapters are tested against a stubbed `globalThis.fetch`,
  restored in `afterEach`. A test that reaches a vendor is a defect, not a slow test.
- **Editor diagnostics in this checkout are frequently stale.** Verify with real commands only.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/gateway/src/config/nimbus-toml.ts` | Modify: parse `[llm.remote.<vendor>]` sub-tables | 1 |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Modify: 4 vault keys + 4 allow-list entries | 2 |
| `packages/gateway/src/llm/provider-error.ts` | **Create**: `LlmProviderError` + `classifyHttpStatus` — the transport/auth/request split Task 8 walks on | 3 |
| `packages/gateway/src/llm/openai-provider.ts` | **Create**: OpenAI `POST /v1/chat/completions`; xAI reuses its mapping | 3 |
| `packages/gateway/src/llm/xai-provider.ts` | **Create**: OpenAI wire, different base URL | 3 |
| `packages/gateway/src/llm/anthropic-provider.ts` | **Create**: `POST /v1/messages` | 4 |
| `packages/gateway/src/llm/gemini-provider.ts` | **Create**: `POST /v1beta/models/{model}:generateContent` | 5 |
| `packages/gateway/src/llm/route-availability.ts` | Modify: add `not_configured` reason | 6 |
| `packages/gateway/src/platform/assemble.ts` | Modify: async `buildLlmRegistryFromToml`, post-parse validation, vendor registration | 7 |
| `packages/gateway/src/llm/router.ts` | Modify: generate-time priority walk (§6.4) | 8 |
| `packages/gateway/src/engine/mastra-model-egress.ts` | **Create**: `wrapLedgeredMastraModel` — the AI-SDK-seam decorator | 9 |
| `packages/gateway/src/engine/agent.ts` | Modify: take a resolved vendor, drop `getEffectiveAgentModel()` | 9 |
| `packages/gateway/src/gateway-main.ts` | Modify: construct the agent only when a vendor is enabled | 9 |
| `packages/cli/src/commands/llm.ts` | Modify: render `not_configured` | 10 |
| `packages/cli/src/commands/llm-shape-parity.test.ts` | **Create**: CLI copy ≡ gateway `LlmRouteStatus` | 10 |
| `packages/gateway/src/security-invariants.test.ts` | Modify: I34 cloud-adapter rows | 6 |
| `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, `CLAUDE.md`, `GEMINI.md`, `docs/CHANGELOG.md`, `docs/roadmap.md` | Modify: I29 `model` class now exercised; I34 rows; vendor surface | 11 |

---

### Task 1: `[llm.remote.<vendor>]` config parsing

Spec §7.1. Parsing ONLY — no validation. Validation lives in `assemble.ts` (Task 7), because a throw
inside the `[llm]` parser is swallowed by `loadTomlSection`'s bare catch and silently reverts the
WHOLE section to defaults, `enforce_air_gap` included.

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces, relied on by Tasks 7 and 9:
  - `type NimbusLlmRemoteVendor = { enabled: boolean; model: string; baseUrl?: string }`
  - `NimbusLlmToml.remoteVendors: ReadonlyMap<string, NimbusLlmRemoteVendor>` — keyed by vendor id
    verbatim from the header, NOT validated against a known-vendor list here.
  - `DEFAULT_NIMBUS_LLM_TOML.remoteVendors` is an empty `Map`.

- [ ] **Step 1: Generalize the sub-table collector**

`collectLlmLocalKvSections` hardcodes `LLM_LOCAL_TABLE_PREFIX`. Remote needs the identical
header/reset/bucket logic, and a second copy would duplicate ~60 lines of edge-case handling — the
malformed-header reset in it fixed a real bug and a second copy could regress it independently.
Parameterize it:

```ts
const LLM_LOCAL_TABLE_PREFIX = "[llm.local.";
const LLM_REMOTE_TABLE_PREFIX = "[llm.remote.";

/**
 * Accumulates raw kv strings per `[llm.<kind>.<id>]` sub-table. `prefix`/`label` are the only
 * difference between the local-route and remote-vendor collectors, so they share this one
 * function rather than each carrying a copy of the header-reset behaviour below.
 */
function collectLlmKvSections(
  source: string,
  prefix: string,
  label: string,
): Map<string, Record<string, string>> {
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (hasUnterminatedString(line)) continue;
    if (trimmed === "") continue;
    // Header-LIKE, not header-VALID: a line opening with `[` is a header the writer meant,
    // whether or not it closes. Ending the current block on the OPENING bracket is what makes a
    // malformed header end the previous entry instead of leaking its keys into it.
    if (trimmed.startsWith("[")) {
      currentId = isTableHeader(trimmed) ? beginLlmTable(accum, trimmed, prefix, label) : undefined;
      continue;
    }
    if (currentId === undefined) continue;
    applyLlmLocalTableLine(accum.get(currentId), trimmed);
  }

  return accum;
}

/** `resolveServiceTableId` THROWS on an empty id; this parser must never throw. */
function beginLlmTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
  prefix: string,
  label: string,
): string | undefined {
  try {
    return resolveServiceTableId(trimmed, prefix, label, accum);
  } catch {
    return undefined;
  }
}
```

Replace `collectLlmLocalKvSections`'s body with a call, and delete the now-duplicate
`beginLlmLocalTable`:

```ts
function collectLlmLocalKvSections(source: string): Map<string, Record<string, string>> {
  return collectLlmKvSections(source, LLM_LOCAL_TABLE_PREFIX, "llm.local");
}
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/gateway/src/config/nimbus-toml.test.ts`. Match how the neighbouring
`[llm.local.*]` tests in this file feed TOML source — if they write a temp file and call a loader
rather than calling a parser directly, do the same rather than introducing a second style.

```ts
describe("[llm.remote.<vendor>] parsing", () => {
  test("parses a vendor table, defaulting enabled to false", () => {
    const llm = parseLlmSource(`
[llm.remote.anthropic]
model = "claude-sonnet-4-6"
`);
    // DEFAULT-OFF is the property the whole slice rests on: an entry that merely EXISTS,
    // with a model and (elsewhere) a key present, must still not be enabled.
    expect(llm.remoteVendors.get("anthropic")).toEqual({
      enabled: false,
      model: "claude-sonnet-4-6",
    });
  });

  test("enabled = true is honoured, and base_url is optional", () => {
    const llm = parseLlmSource(`
[llm.remote.openai]
enabled = true
model = "gpt-5"
base_url = "https://proxy.internal"
`);
    expect(llm.remoteVendors.get("openai")).toEqual({
      enabled: true,
      model: "gpt-5",
      baseUrl: "https://proxy.internal",
    });
  });

  test("several vendors coexist and do not bleed into each other", () => {
    const llm = parseLlmSource(`
[llm.remote.anthropic]
enabled = true
model = "claude-sonnet-4-6"

[llm.remote.gemini]
model = "gemini-2.5-pro"
`);
    expect(llm.remoteVendors.get("anthropic")?.enabled).toBe(true);
    expect(llm.remoteVendors.get("gemini")?.enabled).toBe(false);
    expect(llm.remoteVendors.get("gemini")?.model).toBe("gemini-2.5-pro");
  });

  test("a malformed header ends the previous vendor rather than leaking into it", () => {
    // The bug the shared collector's header-reset exists to prevent, asserted on the REMOTE side
    // too: without it `anthropic` would silently acquire xai's model.
    const llm = parseLlmSource(`
[llm.remote.anthropic]
model = "claude-sonnet-4-6"

[llm.remote.xai
model = "grok-4"
`);
    expect(llm.remoteVendors.get("anthropic")?.model).toBe("claude-sonnet-4-6");
    expect(llm.remoteVendors.has("xai")).toBe(false);
  });

  test("a vendor with no model is dropped, and the rest of [llm] survives", () => {
    // The parser NEVER throws: a structurally unusable entry is dropped here and warned about by
    // name in assemble.ts. If this threw, `loadTomlSection`'s bare catch would revert the whole
    // section and take `enforce_air_gap` back to its `false` default with it.
    const llm = parseLlmSource(`
enforce_air_gap = true

[llm.remote.anthropic]
enabled = true
`);
    expect(llm.remoteVendors.has("anthropic")).toBe(false);
    expect(llm.enforceAirGap).toBe(true);
  });

  test("no [llm.remote.*] tables yields an empty map, not undefined", () => {
    expect(parseLlmSource(`prefer_local = true`).remoteVendors.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts -t "llm.remote"`

Expected: FAIL — `remoteVendors` is `undefined` on the parsed result.

- [ ] **Step 4: Add the type, the default, and the parser**

```ts
/**
 * One `[llm.remote.<vendor>]` sub-table: a cloud vendor opt-in. Spec §7.1.
 *
 * `enabled` DEFAULTS TO FALSE and is never inferred from the presence of a key. Per-vendor rather
 * than one global remote toggle, so enabling Gemini cannot silently enable another vendor because
 * an unrelated credential happens to exist.
 *
 * `baseUrl` is a proxy override and does NOT affect locality — a cloud adapter hardcodes
 * `isLocal = false` even on a loopback base URL, because the proxy forwards to the vendor
 * (invariant I34).
 */
export type NimbusLlmRemoteVendor = {
  enabled: boolean;
  model: string;
  baseUrl?: string;
};
```

Add to `NimbusLlmToml`, directly under `localRoutes`:

```ts
  /**
   * Named `[llm.remote.<vendor>]` sub-tables, keyed by vendor id VERBATIM from the header.
   * Collected without validation, exactly like `localRoutes`: an unknown vendor id, an
   * `enabled = true` with no resolvable key, and an empty model are all `assemble.ts`'s to warn
   * about BY NAME and drop. A throw here would be swallowed by `loadTomlSection`'s bare catch and
   * revert the whole `[llm]` section to defaults, `enforce_air_gap` included.
   */
  remoteVendors: ReadonlyMap<string, NimbusLlmRemoteVendor>;
```

Add `remoteVendors: new Map(),` to `DEFAULT_NIMBUS_LLM_TOML`.

```ts
/**
 * Validates one `[llm.remote.<vendor>]` sub-table's raw kv strings into a vendor, or `undefined`
 * when structurally unusable (no `model`). An absent `enabled` and an explicit `enabled = false`
 * mean the same thing, so no absent-versus-explicit discrimination is needed here or downstream —
 * which is what lets Task 7 validate AFTER defaults are applied.
 */
function toLlmRemoteVendor(kv: Record<string, string>): NimbusLlmRemoteVendor | undefined {
  const modelRaw = kv["model"];
  if (modelRaw === undefined) return undefined;
  const model = parseString(modelRaw);
  if (model.length === 0) return undefined;
  const enabledRaw = kv["enabled"];
  const vendor: NimbusLlmRemoteVendor = {
    enabled: enabledRaw === undefined ? false : (parseBool(enabledRaw) ?? false),
    model,
  };
  const baseUrlRaw = kv["base_url"];
  if (baseUrlRaw !== undefined) {
    const baseUrl = parseString(baseUrlRaw);
    if (baseUrl.length > 0) vendor.baseUrl = baseUrl;
  }
  return vendor;
}

/** Parses every `[llm.remote.<vendor>]` sub-table into a vendor to config map. Never throws. */
function parseLlmRemoteVendors(source: string): Map<string, NimbusLlmRemoteVendor> {
  const out = new Map<string, NimbusLlmRemoteVendor>();
  for (const [id, kv] of collectLlmKvSections(source, LLM_REMOTE_TABLE_PREFIX, "llm.remote")) {
    const vendor = toLlmRemoteVendor(kv);
    if (vendor !== undefined) out.set(id, vendor);
  }
  return out;
}
```

Assign `parseLlmRemoteVendors(source)` onto the returned `NimbusLlmToml` at the same site
`parseLlmLocalRoutes(source)` is assigned.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts && bun run typecheck`

Expected: all six new tests PASS, every existing `[llm.local.*]` test still PASSES — the shared
collector must not have changed local behaviour — and typecheck is clean.

- [ ] **Step 6: Red-prove the default-off property**

Change `enabled: enabledRaw === undefined ? false : ...` to `? true :` and re-run.
Expected: "parses a vendor table, defaulting enabled to false" FAILS. Restore, confirm it passes.
This is the default the entire opt-in rests on; a default never observed failing is not known to be
load-bearing.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.test.ts
git commit -m "feat(config): parse [llm.remote.<vendor>] sub-tables, default-off"
```

---

### Task 2: Vault keys and the allow-list

Spec §7.2. Four keys join the platform keyspace; the files that read them join the allow-list.
Nothing consumes them yet, so `audit:invariants` is this task's gate.

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Test: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces, relied on by Tasks 3-5, 7 and 9: the vault key ids `anthropic.api_key`,
  `openai.api_key`, `gemini.api_key`, `xai.api_key`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/security-invariants.test.ts`. Place it beside the existing vault-key
assertions — find them by searching the file for `VAULT_KEY_ALLOW_LIST`.

```ts
  test("the four slice-2b vendor keys are registered in the platform keyspace", async () => {
    // Registration is what keeps the keyspace documented in ONE place. A key an adapter reads
    // but that is absent here is a key nobody can audit.
    const { PLATFORM_VAULT_KEYS } = await import(
      "../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    for (const k of ["anthropic.api_key", "openai.api_key", "gemini.api_key", "xai.api_key"]) {
      expect(PLATFORM_VAULT_KEYS).toContain(k);
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "slice-2b vendor keys"`

Expected: FAIL — none of the four are present.

- [ ] **Step 3: Register the keys**

In `scripts/structure-audit/check-nimbus-invariants.ts`:

```ts
export const PLATFORM_VAULT_KEYS = [
  "policy.signing.privkey",
  "policy.signing.pubkey",
  "http_api.deployment_token",
  "http_api.web_clipper_tokens",
  // Slice 2b cloud vendors. `openai.api_key` is DELIBERATELY REUSED from the embedding runtime
  // rather than minted as a second OpenAI key: same credential, same vendor, and a second key for
  // one vendor invites drift. It is also the sharpest available test of the opt-in — an existing
  // embeddings user already has this key present, and `enabled = false` must still produce zero
  // chat calls. Task 7 asserts exactly that case.
  "anthropic.api_key",
  "openai.api_key",
  "gemini.api_key",
  "xai.api_key",
] as const;
```

- [ ] **Step 4: Run the test and the audit**

Run: `bun test packages/gateway/src/security-invariants.test.ts && bun run audit:invariants`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts packages/gateway/src/security-invariants.test.ts
git commit -m "feat(vault): register the four slice-2b vendor api_key entries"
```

> **Note on `VAULT_KEY_ALLOW_LIST`.** The four adapter files must join it, but the entry lands in
> the commit that CREATES each file (Tasks 3-5), not here — an allow-list naming a file that does
> not exist yet is drift of the kind `audit:doc-refs` and the structure audits exist to prevent.
> Each adapter task's steps say so explicitly.

---

### Task 3: The error classifier and the OpenAI-shape adapters

Spec §7.3, §6.4. Two vendors, one wire format. This task also creates the error type Task 8's
priority walk branches on — the walk cannot be written until failures are classifiable, and only an
adapter can read a vendor's status codes.

**Files:**

- Create: `packages/gateway/src/llm/provider-error.ts`
- Create: `packages/gateway/src/llm/openai-provider.ts`
- Create: `packages/gateway/src/llm/xai-provider.ts`
- Create: `packages/gateway/src/llm/provider-error.test.ts`
- Create: `packages/gateway/src/llm/openai-provider.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`VAULT_KEY_ALLOW_LIST`)

**Interfaces:**

- Consumes: the vault key ids from Task 2.
- Produces, relied on by Tasks 4, 5, 7 and 8:
  - `class LlmProviderError extends Error` with `readonly kind: LlmFailureKind` and
    `readonly status?: number`
  - `type LlmFailureKind = "transport" | "auth" | "request"`
  - `function classifyHttpStatus(status: number): LlmFailureKind`
  - `type ApiKeyResolver = () => Promise<string | undefined>`
  - `class OpenAiProvider implements LlmProvider` — constructor
    `(opts: { apiKey: ApiKeyResolver; modelName: string; baseUrl?: string })`
  - `class XaiProvider implements LlmProvider` — same constructor shape

- [ ] **Step 1: Write the failing classifier test**

Create `packages/gateway/src/llm/provider-error.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";

describe("classifyHttpStatus", () => {
  // The split exists for ONE reason: Task 8's priority walk retries a transport failure on the
  // next vendor and does NOT retry auth/request. Retrying a 401 would send the same prompt to a
  // second destination for nothing -- an extra ledger row and an extra egress, no better answer.
  test("5xx and 429 are transport-class, so the walk continues", () => {
    for (const s of [500, 502, 503, 504, 429]) {
      expect(classifyHttpStatus(s)).toBe("transport");
    }
  });

  test("401 and 403 are auth-class, so the walk stops", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
  });

  test("400 and 404 are request-class, so the walk stops", () => {
    // A malformed request or an unknown model fails identically at the next vendor.
    expect(classifyHttpStatus(400)).toBe("request");
    expect(classifyHttpStatus(404)).toBe("request");
  });

  test("an unmapped 4xx is request-class, not transport", () => {
    // Fail-closed on the RETRY decision: an unknown 4xx must not cause a second vendor to
    // receive the prompt. Retrying is the action with a cost, so the default is not to.
    expect(classifyHttpStatus(418)).toBe("request");
  });
});

describe("LlmProviderError", () => {
  test("carries its kind and status", () => {
    const e = new LlmProviderError("boom", "transport", 503);
    expect(e.kind).toBe("transport");
    expect(e.status).toBe(503);
    expect(e.name).toBe("LlmProviderError");
    expect(e).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/llm/provider-error.test.ts`

Expected: FAIL — `Cannot find module './provider-error.ts'`.

- [ ] **Step 3: Write the classifier**

Create `packages/gateway/src/llm/provider-error.ts`:

```ts
// packages/gateway/src/llm/provider-error.ts

/**
 * Why a provider call failed, in the only distinction the router acts on.
 *
 * `transport` — connection refused, DNS, timeout, 5xx, 429. The vendor was not reached, or was
 * reached and could not answer right now. Trying the NEXT route in priority order may succeed.
 * `auth` — 401/403. The key is missing, wrong, or lacks access.
 * `request` — 400/404 and anything else 4xx. The request itself is unacceptable: a bad model
 * name, a malformed body.
 *
 * Only `transport` continues the priority walk (§6.4). The other two fail identically at the next
 * vendor, so retrying would send the same prompt to a second destination -- one more real outbound
 * request and one more ledger row -- for no better answer.
 */
export type LlmFailureKind = "transport" | "auth" | "request";

/**
 * Maps an HTTP status onto the retry decision.
 *
 * Note the DEFAULT: an unmapped 4xx is `request`, never `transport`. The fail-closed direction
 * here is "do not retry", because retrying is the action that costs a real outbound request to a
 * second vendor. An unmapped 5xx IS transport -- the 5xx range means the server failed, which is
 * exactly the retryable case.
 */
export function classifyHttpStatus(status: number): LlmFailureKind {
  if (status === 429) return "transport";
  if (status >= 500) return "transport";
  if (status === 401 || status === 403) return "auth";
  return "request";
}

/**
 * A provider failure carrying its retry classification. Thrown by every cloud adapter, so
 * `LlmRouter.generate`'s priority walk can branch without knowing any vendor's status codes --
 * classification lives with the adapter because that is the only layer that can read them.
 */
export class LlmProviderError extends Error {
  readonly kind: LlmFailureKind;
  readonly status?: number;

  constructor(message: string, kind: LlmFailureKind, status?: number) {
    super(message);
    this.name = "LlmProviderError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}
```

- [ ] **Step 4: Run the classifier tests**

Run: `bun test packages/gateway/src/llm/provider-error.test.ts`

Expected: all 5 PASS.

- [ ] **Step 5: Write the failing OpenAI adapter tests**

Create `packages/gateway/src/llm/openai-provider.test.ts`. **No test in this file may reach the
network** — `globalThis.fetch` is stubbed in `beforeEach` and restored in `afterEach`.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LlmProviderError } from "./provider-error.ts";
import { OpenAiProvider } from "./openai-provider.ts";

const realFetch = globalThis.fetch;
let seen: Array<{ url: string; headers: Record<string, string>; body: unknown }>;

function stubFetch(status: number, payload: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as unknown,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  seen = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_BODY = {
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

describe("OpenAiProvider", () => {
  test("is NOT local, even on a loopback base_url", async () => {
    // I34, and the inverse of slice 1's rule for local runtimes. A LiteLLM-style proxy on
    // 127.0.0.1 forwards to OpenAI, so the traffic is not local; deriving locality from the URL
    // here would hand back the exact air-gap bypass slice 1 closed, through the opposite door.
    const p = new OpenAiProvider({
      apiKey: async () => "sk-test",
      modelName: "gpt-5",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("openai");
  });

  test("isAvailable is answered OFFLINE and makes no request", async () => {
    // A vendor /models probe on every `nimbus llm status` would be real, un-ledgered egress to
    // four vendors BEFORE the user ever opted into sending a prompt, and would leak Nimbus usage
    // to each of them.
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    expect(await p.isAvailable()).toBe(true);
    expect(seen).toHaveLength(0);
  });

  test("isAvailable is false when no key resolves", async () => {
    const p = new OpenAiProvider({ apiKey: async () => undefined, modelName: "gpt-5" });
    expect(await p.isAvailable()).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("listModels returns the configured model statically, with no request", async () => {
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    expect(await p.listModels()).toEqual([{ provider: "openai", modelName: "gpt-5" }]);
    expect(seen).toHaveLength(0);
  });

  test("generate posts the chat-completions shape and maps the reply", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    const r = await p.generate({ task: "reasoning", prompt: "hi", systemPrompt: "be terse" });

    expect(r).toMatchObject({
      text: "hello",
      tokensIn: 11,
      tokensOut: 7,
      modelUsed: "gpt-5",
      isLocal: false,
      provider: "openai",
    });
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0]?.headers["Authorization"]).toBe("Bearer sk-test");
    expect(seen[0]?.body).toMatchObject({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
  });

  test("the key is resolved PER CALL, so a key added after boot works with no restart", async () => {
    stubFetch(200, OK_BODY);
    let key: string | undefined;
    const p = new OpenAiProvider({ apiKey: async () => key, modelName: "gpt-5" });

    await expect(p.generate({ task: "reasoning", prompt: "hi" })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
    key = "sk-added-later";
    const r = await p.generate({ task: "reasoning", prompt: "hi" });
    expect(r.text).toBe("hello");
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({ apiKey: async () => undefined, modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("a 503 is transport-class and a 401 is auth-class", async () => {
    for (const [status, kind] of [
      [503, "transport"],
      [401, "auth"],
      [400, "request"],
    ] as const) {
      stubFetch(status, { error: { message: "nope" } });
      const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
      const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
      expect((err as LlmProviderError).kind).toBe(kind);
      expect((err as LlmProviderError).status).toBe(status);
    }
  });

  test("a thrown fetch (DNS, refused, timeout) is transport-class", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("transport");
  });

  test("the error message never contains the api key", async () => {
    // The message reaches `SynthesisAttempt.detail`, which travels to the user on `briefReady`.
    stubFetch(401, { error: { message: "invalid api key sk-test-SECRET" } });
    const p = new OpenAiProvider({ apiKey: async () => "sk-test-SECRET", modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("sk-test-SECRET");
  });

  test("base_url overrides the endpoint host but keeps the path", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({
      apiKey: async () => "sk-test",
      modelName: "gpt-5",
      baseUrl: "https://proxy.internal",
    });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toBe("https://proxy.internal/v1/chat/completions");
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `bun test packages/gateway/src/llm/openai-provider.test.ts`

Expected: FAIL — `Cannot find module './openai-provider.ts'`.

- [ ] **Step 7: Write the OpenAI adapter**

Create `packages/gateway/src/llm/openai-provider.ts`:

```ts
// packages/gateway/src/llm/openai-provider.ts

import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";
import type {
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmModelInfo,
  LlmProvider,
} from "./types.ts";

/**
 * Resolves the vendor key, per call, from the Vault. NEVER from the environment: an env var must
 * not be able to satisfy a vendor nobody opted into, which is the hole the whole per-vendor
 * opt-in exists to close. Per call rather than at construction so a key added after boot works
 * without a Gateway restart.
 */
export type ApiKeyResolver = () => Promise<string | undefined>;

export type OpenAiProviderOptions = {
  apiKey: ApiKeyResolver;
  modelName: string;
  baseUrl?: string;
};

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

/** Shared by OpenAI and xAI: same request/response mapping, different host and provider id. */
export async function generateOpenAiCompatible(
  args: {
    providerId: string;
    baseUrl: string;
    modelName: string;
    apiKey: ApiKeyResolver;
  },
  opts: LlmGenerateOptions,
): Promise<LlmGenerateResult> {
  const key = await args.apiKey();
  if (key === undefined || key.trim() === "") {
    // Auth-class, and thrown BEFORE any request: a keyless call has nothing to send.
    throw new LlmProviderError(`${args.providerId}: no API key configured`, "auth");
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.systemPrompt !== undefined) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: opts.prompt });

  let resp: Response;
  try {
    resp = await fetch(`${args.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: args.modelName,
        messages,
        ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      }),
    });
  } catch (err) {
    // A THROWN fetch is DNS / connection-refused / timeout -- transport-class by definition, and
    // the case the priority walk exists to route around.
    throw new LlmProviderError(
      `${args.providerId}: request failed: ${err instanceof Error ? err.name : "unknown"}`,
      "transport",
    );
  }

  if (!resp.ok) {
    // The vendor's own error text is NOT echoed: it can quote the submitted key back
    // (observed with OpenAI 401s), and this message reaches the user via
    // `SynthesisAttempt.detail` on `briefReady`. Status plus vendor is enough to act on.
    throw new LlmProviderError(
      `${args.providerId}: HTTP ${String(resp.status)}`,
      classifyHttpStatus(resp.status),
      resp.status,
    );
  }

  const body = (await resp.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const raw = body.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : "";
  const tokensIn = typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : 0;
  const tokensOut =
    typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : 0;

  return {
    text,
    tokensIn,
    tokensOut,
    modelUsed: args.modelName,
    isLocal: false,
    provider: args.providerId,
  };
}

/**
 * OpenAI chat-completions adapter.
 *
 * `isLocal` is HARDCODED FALSE and is never derived from `baseUrl`. This is the inverse of the
 * rule `OllamaProvider` / `LlamaCppProvider` follow, and the easiest thing in this slice to get
 * backwards: those runtimes derive locality because their base URL can legitimately name a LAN
 * box, whereas pointing THIS adapter at `http://127.0.0.1:4000` only names a proxy that forwards
 * to OpenAI. Pinned by invariant I34.
 */
export class OpenAiProvider implements LlmProvider {
  readonly providerId = "openai";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Answered OFFLINE -- enabled-and-keyed, no network call. A `/models` probe on every
   * `nimbus llm status` would be real, un-ledgered egress to the vendor before the user ever
   * opted into sending a prompt, and would leak Nimbus usage to them. The accepted cost is
   * §7.4's named fail-open: a typo'd model name reports available and fails at `generate()`.
   */
  async isAvailable(): Promise<boolean> {
    const key = await this.apiKey();
    return key !== undefined && key.trim() !== "";
  }

  /** Static, for the same no-egress reason as `isAvailable`. */
  async listModels(): Promise<LlmModelInfo[]> {
    return [{ provider: this.providerId, modelName: this.modelName }];
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    return generateOpenAiCompatible(
      {
        providerId: this.providerId,
        baseUrl: this.baseUrl,
        modelName: this.modelName,
        apiKey: this.apiKey,
      },
      opts,
    );
  }
}
```

- [ ] **Step 8: Write the xAI adapter**

Create `packages/gateway/src/llm/xai-provider.ts`. It reuses the exported mapping rather than
copying it — xAI is OpenAI-compatible on the wire.

```ts
// packages/gateway/src/llm/xai-provider.ts

import { type ApiKeyResolver, generateOpenAiCompatible } from "./openai-provider.ts";
import type {
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmModelInfo,
  LlmProvider,
} from "./types.ts";

export type XaiProviderOptions = {
  apiKey: ApiKeyResolver;
  modelName: string;
  baseUrl?: string;
};

const XAI_DEFAULT_BASE_URL = "https://api.x.ai";

/**
 * xAI adapter. Same wire format as OpenAI, so it delegates to
 * `generateOpenAiCompatible` -- a second copy of the request/response mapping would be two places
 * to fix a mapping bug. Only the host, the provider id and the Vault key differ.
 *
 * `isLocal` is HARDCODED FALSE; see `OpenAiProvider`'s note. Invariant I34.
 */
export class XaiProvider implements LlmProvider {
  readonly providerId = "xai";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: XaiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? XAI_DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async isAvailable(): Promise<boolean> {
    const key = await this.apiKey();
    return key !== undefined && key.trim() !== "";
  }

  async listModels(): Promise<LlmModelInfo[]> {
    return [{ provider: this.providerId, modelName: this.modelName }];
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    return generateOpenAiCompatible(
      {
        providerId: this.providerId,
        baseUrl: this.baseUrl,
        modelName: this.modelName,
        apiKey: this.apiKey,
      },
      opts,
    );
  }
}
```

Add an xAI case to `openai-provider.test.ts` proving the delegation is real rather than assumed:

```ts
describe("XaiProvider", () => {
  test("posts to the xAI host using the OpenAI wire format", async () => {
    stubFetch(200, OK_BODY);
    const p = new XaiProvider({ apiKey: async () => "xai-test", modelName: "grok-4" });
    const r = await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(r.provider).toBe("xai");
    expect(p.isLocal).toBe(false);
  });
});
```

Import `XaiProvider` at the top of that test file.

- [ ] **Step 9: Add both files to the vault allow-list**

In `scripts/structure-audit/check-nimbus-invariants.ts`, add to `VAULT_KEY_ALLOW_LIST`:

```ts
  "packages/gateway/src/llm/openai-provider.ts",
  "packages/gateway/src/llm/xai-provider.ts",
```

- [ ] **Step 10: Run the tests, the typecheck and the audit**

Run: `bun test packages/gateway/src/llm && bun run typecheck && bun run audit:invariants`

Expected: all PASS.

- [ ] **Step 11: Red-prove the two properties that matter most**

1. Change `readonly isLocal = false` to `= true` in `openai-provider.ts`. Re-run: the "is NOT
   local, even on a loopback base_url" test FAILS. Restore.
2. Change the keyless throw's kind from `"auth"` to `"transport"`. Re-run: "a missing key is
   auth-class" FAILS. Restore. This matters because a transport-class keyless failure would make
   Task 8's walk forward the prompt to the next vendor on a configuration mistake.

- [ ] **Step 12: Commit**

```bash
git add packages/gateway/src/llm/provider-error.ts packages/gateway/src/llm/provider-error.test.ts \
        packages/gateway/src/llm/openai-provider.ts packages/gateway/src/llm/openai-provider.test.ts \
        packages/gateway/src/llm/xai-provider.ts scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(llm): add the OpenAI and xAI adapters with retry classification"
```

---

### Task 4: The Anthropic adapter

Spec §7.3. Native `POST /v1/messages` — a different wire format from Task 3, not a variant of it.

**Files:**

- Create: `packages/gateway/src/llm/anthropic-provider.ts`
- Create: `packages/gateway/src/llm/anthropic-provider.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`VAULT_KEY_ALLOW_LIST`)

**Interfaces:**

- Consumes: `ApiKeyResolver`, `LlmProviderError`, `classifyHttpStatus` from Task 3.
- Produces, relied on by Task 7: `class AnthropicProvider implements LlmProvider` — constructor
  `(opts: { apiKey: ApiKeyResolver; modelName: string; baseUrl?: string })`.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/llm/anthropic-provider.test.ts`. Reuse the stub-fetch harness shape
from Task 3 verbatim — same `beforeEach`/`afterEach` restore discipline, no network.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { LlmProviderError } from "./provider-error.ts";

const realFetch = globalThis.fetch;
let seen: Array<{ url: string; headers: Record<string, string>; body: unknown }>;

function stubFetch(status: number, payload: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as unknown,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  seen = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_BODY = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 11, output_tokens: 7 },
};

describe("AnthropicProvider", () => {
  test("is NOT local, even on a loopback base_url", () => {
    // I34. A LiteLLM-style proxy on 127.0.0.1 forwards to Anthropic.
    const p = new AnthropicProvider({
      apiKey: async () => "sk-ant",
      modelName: "claude-sonnet-4-6",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("anthropic");
  });

  test("generate posts the messages shape with the anthropic headers", async () => {
    stubFetch(200, OK_BODY);
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "claude-sonnet-4-6" });
    const r = await p.generate({ task: "reasoning", prompt: "hi", systemPrompt: "be terse" });

    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    // Anthropic authenticates with `x-api-key`, NOT `Authorization: Bearer`, and requires an
    // explicit API version header. Getting either wrong is a 401 that looks like a bad key.
    expect(seen[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    // `system` is a TOP-LEVEL field here, not a message with role "system" as in OpenAI's shape.
    expect(seen[0]?.body).toMatchObject({
      model: "claude-sonnet-4-6",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).toMatchObject({
      text: "hello",
      tokensIn: 11,
      tokensOut: 7,
      isLocal: false,
      provider: "anthropic",
    });
  });

  test("max_tokens is always sent, because the API requires it", async () => {
    // Anthropic REJECTS a request without `max_tokens`. A caller that omits `maxTokens` must
    // still produce a valid request, so the adapter supplies a default rather than passing
    // `undefined` through and getting a 400 that reads as a malformed prompt.
    stubFetch(200, OK_BODY);
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "claude-sonnet-4-6" });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect((seen[0]?.body as { max_tokens?: number }).max_tokens).toBeGreaterThan(0);
  });

  test("concatenates multiple text blocks in the reply", async () => {
    // The content array can hold several blocks; taking only [0] would silently truncate.
    stubFetch(200, {
      content: [
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "claude-sonnet-4-6" });
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("one two");
  });

  test("ignores non-text blocks rather than rendering them", async () => {
    stubFetch(200, {
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "claude-sonnet-4-6" });
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("visible");
  });

  test("classifies status codes and never echoes the key", async () => {
    for (const [status, kind] of [
      [503, "transport"],
      [429, "transport"],
      [401, "auth"],
      [400, "request"],
    ] as const) {
      stubFetch(status, { error: { message: "bad key sk-ant-SECRET" } });
      const p = new AnthropicProvider({ apiKey: async () => "sk-ant-SECRET", modelName: "m" });
      const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
      expect((err as LlmProviderError).kind).toBe(kind);
      expect((err as Error).message).not.toContain("sk-ant-SECRET");
    }
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new AnthropicProvider({ apiKey: async () => undefined, modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("isAvailable and listModels are offline", async () => {
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "claude-sonnet-4-6" });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.listModels()).toEqual([
      { provider: "anthropic", modelName: "claude-sonnet-4-6" },
    ]);
    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/gateway/src/llm/anthropic-provider.test.ts`

Expected: FAIL — `Cannot find module './anthropic-provider.ts'`.

- [ ] **Step 3: Write the adapter**

Create `packages/gateway/src/llm/anthropic-provider.ts`:

```ts
// packages/gateway/src/llm/anthropic-provider.ts

import type { ApiKeyResolver } from "./openai-provider.ts";
import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";
import type {
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmModelInfo,
  LlmProvider,
} from "./types.ts";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Pinned rather than floating: a version bump can change response shapes under us. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Required by the API -- a request without `max_tokens` is rejected with a 400. Supplying a
 * default here keeps a caller that omits `maxTokens` producing a VALID request, instead of a 400
 * that reads like a malformed prompt.
 */
const DEFAULT_MAX_TOKENS = 4096;

export type AnthropicProviderOptions = {
  apiKey: ApiKeyResolver;
  modelName: string;
  baseUrl?: string;
};

/**
 * Anthropic messages-API adapter.
 *
 * `isLocal` is HARDCODED FALSE and never derived from `baseUrl`; see `OpenAiProvider`'s note and
 * invariant I34. Authentication is `x-api-key`, NOT `Authorization: Bearer`.
 */
export class AnthropicProvider implements LlmProvider {
  readonly providerId = "anthropic";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /** Offline; see `OpenAiProvider.isAvailable` for why no probe is issued. */
  async isAvailable(): Promise<boolean> {
    const key = await this.apiKey();
    return key !== undefined && key.trim() !== "";
  }

  async listModels(): Promise<LlmModelInfo[]> {
    return [{ provider: this.providerId, modelName: this.modelName }];
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const key = await this.apiKey();
    if (key === undefined || key.trim() === "") {
      throw new LlmProviderError("anthropic: no API key configured", "auth");
    }

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.modelName,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          // `system` is a TOP-LEVEL field here, not a message with role "system".
          ...(opts.systemPrompt === undefined ? {} : { system: opts.systemPrompt }),
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          messages: [{ role: "user", content: opts.prompt }],
        }),
      });
    } catch (err) {
      throw new LlmProviderError(
        `anthropic: request failed: ${err instanceof Error ? err.name : "unknown"}`,
        "transport",
      );
    }

    if (!resp.ok) {
      // The vendor's error text is deliberately NOT echoed -- it can quote the submitted key
      // back, and this message reaches the user through `SynthesisAttempt.detail`.
      throw new LlmProviderError(
        `anthropic: HTTP ${String(resp.status)}`,
        classifyHttpStatus(resp.status),
        resp.status,
      );
    }

    const body = (await resp.json()) as {
      content?: Array<{ type?: unknown; text?: unknown }>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    // CONCATENATE every text block. The array can hold several, plus non-text blocks such as
    // `thinking`; taking only [0] would silently truncate a multi-block reply.
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const tokensIn = typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0;
    const tokensOut = typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : 0;

    return {
      text,
      tokensIn,
      tokensOut,
      modelUsed: this.modelName,
      isLocal: false,
      provider: this.providerId,
    };
  }
}
```

- [ ] **Step 4: Add the file to the vault allow-list**

Add `"packages/gateway/src/llm/anthropic-provider.ts",` to `VAULT_KEY_ALLOW_LIST`.

- [ ] **Step 5: Run the tests, typecheck and audit**

Run: `bun test packages/gateway/src/llm && bun run typecheck && bun run audit:invariants`

Expected: all PASS.

- [ ] **Step 6: Red-prove the multi-block concatenation**

Replace the `.filter(...).map(...).join("")` chain with `String(body.content?.[0]?.text ?? "")`.
Re-run: "concatenates multiple text blocks" FAILS. Restore. A single-block happy path passes either
way, so only the multi-block case proves the chain is doing work.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/llm/anthropic-provider.ts packages/gateway/src/llm/anthropic-provider.test.ts \
        scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(llm): add the Anthropic messages-API adapter"
```

---

### Task 5: The Gemini adapter

Spec §7.3. Third wire format: the model name is in the PATH, the key is a query parameter, and the
reply nests under `candidates[].content.parts[].text`.

**Files:**

- Create: `packages/gateway/src/llm/gemini-provider.ts`
- Create: `packages/gateway/src/llm/gemini-provider.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`VAULT_KEY_ALLOW_LIST`)

**Interfaces:**

- Consumes: `ApiKeyResolver`, `LlmProviderError`, `classifyHttpStatus` from Task 3.
- Produces, relied on by Task 7: `class GeminiProvider implements LlmProvider` — constructor
  `(opts: { apiKey: ApiKeyResolver; modelName: string; baseUrl?: string })`.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/llm/gemini-provider.test.ts` using the same stub-fetch harness as
Tasks 3 and 4 (copy the `realFetch` / `stubFetch` / `beforeEach` / `afterEach` block verbatim).

```ts
const OK_BODY = {
  candidates: [{ content: { parts: [{ text: "hello" }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
};

describe("GeminiProvider", () => {
  test("is NOT local, even on a loopback base_url", () => {
    const p = new GeminiProvider({
      apiKey: async () => "g-key",
      modelName: "gemini-2.5-pro",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("gemini");
  });

  test("puts the model in the PATH and the key in the QUERY, not a header", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "gemini-2.5-pro" });
    await p.generate({ task: "reasoning", prompt: "hi", systemPrompt: "be terse" });

    expect(seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=g-key",
    );
    // `systemInstruction` is its own top-level object -- not a message, and not a `system` string
    // as in Anthropic's shape.
    expect(seen[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: "be terse" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
  });

  test("the model name is URL-encoded into the path", async () => {
    // Model ids can carry characters that would otherwise change the path's meaning.
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "models/weird name" });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toContain("models%2Fweird%20name:generateContent");
  });

  test("concatenates multiple parts in the reply", async () => {
    stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "one " }, { text: "two" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    });
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "gemini-2.5-pro" });
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("one two");
  });

  test("classifies status codes and never echoes the key", async () => {
    for (const [status, kind] of [
      [503, "transport"],
      [429, "transport"],
      [401, "auth"],
      [403, "auth"],
      [400, "request"],
    ] as const) {
      stubFetch(status, { error: { message: "bad key g-SECRET" } });
      const p = new GeminiProvider({ apiKey: async () => "g-SECRET", modelName: "m" });
      const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
      expect((err as LlmProviderError).kind).toBe(kind);
      // Sharper here than for the other vendors: the key is in the URL, so a message that
      // included the request URL would leak it.
      expect((err as Error).message).not.toContain("g-SECRET");
    }
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => undefined, modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("isAvailable and listModels are offline", async () => {
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "gemini-2.5-pro" });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.listModels()).toEqual([{ provider: "gemini", modelName: "gemini-2.5-pro" }]);
    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/gateway/src/llm/gemini-provider.test.ts` — FAIL, module not found.

- [ ] **Step 3: Write the adapter**

Create `packages/gateway/src/llm/gemini-provider.ts`, following `AnthropicProvider`'s structure
exactly (same offline `isAvailable`/`listModels`, same keyless-auth throw, same non-echoing error
message) with these wire differences:

```ts
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const key = await this.apiKey();
    if (key === undefined || key.trim() === "") {
      throw new LlmProviderError("gemini: no API key configured", "auth");
    }

    // The model goes in the PATH and the key in the QUERY. `encodeURIComponent` on the model is
    // load-bearing: an id containing `/` or a space would otherwise change the path's meaning.
    // The key is NOT encoded into any error message below -- because it rides in the URL,
    // echoing a failed request's URL would leak the credential.
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent` +
      `?key=${encodeURIComponent(key)}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
          ...(opts.systemPrompt === undefined
            ? {}
            : { systemInstruction: { parts: [{ text: opts.systemPrompt }] } }),
          ...(opts.maxTokens === undefined && opts.temperature === undefined
            ? {}
            : {
                generationConfig: {
                  ...(opts.maxTokens === undefined ? {} : { maxOutputTokens: opts.maxTokens }),
                  ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
                },
              }),
        }),
      });
    } catch (err) {
      throw new LlmProviderError(
        `gemini: request failed: ${err instanceof Error ? err.name : "unknown"}`,
        "transport",
      );
    }

    if (!resp.ok) {
      throw new LlmProviderError(
        `gemini: HTTP ${String(resp.status)}`,
        classifyHttpStatus(resp.status),
        resp.status,
      );
    }

    const body = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
    };
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    const u = body.usageMetadata;
    return {
      text,
      tokensIn: typeof u?.promptTokenCount === "number" ? u.promptTokenCount : 0,
      tokensOut: typeof u?.candidatesTokenCount === "number" ? u.candidatesTokenCount : 0,
      modelUsed: this.modelName,
      isLocal: false,
      provider: this.providerId,
    };
  }
```

- [ ] **Step 4: Allow-list, run, red-prove, commit**

Add `"packages/gateway/src/llm/gemini-provider.ts",` to `VAULT_KEY_ALLOW_LIST`.

Run: `bun test packages/gateway/src/llm && bun run typecheck && bun run audit:invariants` — all PASS.

Red-prove: drop the `encodeURIComponent` around `this.modelName`; "the model name is URL-encoded"
FAILS. Restore.

```bash
git add packages/gateway/src/llm/gemini-provider.ts packages/gateway/src/llm/gemini-provider.test.ts \
        scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(llm): add the Gemini generateContent adapter"
```

---

### Task 6: `not_configured` availability and the I34 cloud rows

Spec §7.4, §8, §11. Adds the third availability reason so `nimbus llm status` sends the user to the
right remedy, and extends I34's enforcement block to cover the four new adapters.

**Files:**

- Modify: `packages/gateway/src/llm/route-availability.ts`
- Modify: `packages/gateway/src/llm/route-availability.test.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: the four adapter classes from Tasks 3-5.
- Produces, relied on by Task 10: `RouteAvailability["reason"]` gains `"not_configured"`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/llm/route-availability.test.ts`:

```ts
test("an enabled-but-keyless remote route reports not_configured, not provider_unreachable", async () => {
  // Three different fixes hide behind "unavailable": start the daemon, pull the model, add a
  // key. Collapsing the third into `provider_unreachable` would send the user to check their
  // network for a missing credential.
  const probe = new RouteAvailabilityProbe();
  const route = {
    routeId: "openai/gpt-5",
    modelName: "gpt-5",
    meta: {},
    provider: {
      providerId: "openai",
      isLocal: false,
      isAvailable: async () => false,
      listModels: async () => [{ provider: "openai", modelName: "gpt-5" }],
      generate: async () => {
        throw new Error("unused");
      },
    },
  } as unknown as ModelRoute;

  expect(await probe.check(route)).toEqual({ available: false, reason: "not_configured" });
});

test("an unavailable LOCAL route still reports provider_unreachable", async () => {
  // The new reason must be scoped to remote routes: a stopped Ollama daemon is still a
  // reachability problem, and its remedy is unchanged.
  const probe = new RouteAvailabilityProbe();
  const route = {
    routeId: "ollama/qwen3",
    modelName: "qwen3",
    meta: {},
    provider: {
      providerId: "ollama",
      isLocal: true,
      isAvailable: async () => false,
      listModels: async () => [],
      generate: async () => {
        throw new Error("unused");
      },
    },
  } as unknown as ModelRoute;

  expect((await probe.check(route)).reason).toBe("provider_unreachable");
});
```

Import `ModelRoute` from `./types.ts` if the file does not already.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/gateway/src/llm/route-availability.test.ts -t "not_configured"`

Expected: FAIL — the reason is `provider_unreachable`.

- [ ] **Step 3: Add the reason**

In `packages/gateway/src/llm/route-availability.ts`:

```ts
export type RouteAvailability = {
  available: boolean;
  /**
   * `not_configured` is REMOTE-ONLY: a cloud route that is enabled but has no resolvable key.
   * It exists because three different fixes otherwise collapse into one word -- start the
   * daemon (`provider_unreachable`), pull the model (`model_absent`), add a key. A cloud
   * adapter answers `isAvailable()` OFFLINE (§7.4), so a `false` from one means "no key",
   * never "unreachable"; that is what makes the distinction derivable here without a probe.
   */
  reason: "ok" | "provider_unreachable" | "model_absent" | "not_configured";
};
```

In the probe's unavailable branch, split on locality:

```ts
    if (!(await route.provider.isAvailable())) {
      // A remote adapter's `isAvailable()` is offline and answers exactly "enabled and keyed",
      // so `false` here means the credential is missing -- not that anything was unreachable.
      return {
        available: false,
        reason: route.provider.isLocal ? "provider_unreachable" : "not_configured",
      };
    }
```

- [ ] **Step 4: Run the availability tests**

Run: `bun test packages/gateway/src/llm && bun run typecheck`

Expected: PASS. Any existing test asserting `provider_unreachable` for a NON-local provider must be
re-read before being changed — if it was asserting the old collapsed behaviour, update it and note
why in the test; if it was asserting local behaviour, it should still pass untouched.

- [ ] **Step 5: Extend the I34 block**

Add to the `describe("I34 — locality is declared once…")` block in
`packages/gateway/src/security-invariants.test.ts` (created by slice 2a):

```ts
  test("every cloud adapter reports isLocal === false, even on a loopback base_url", () => {
    // The INVERSE of the local-runtime rule above, and the case slice 2a could not write
    // because no cloud adapter existed. A LiteLLM-style proxy on 127.0.0.1 forwards to the
    // vendor, so deriving locality from the URL here would reopen the air-gap bypass slice 1
    // closed -- through the opposite door.
    const key = async () => "k";
    const loopback = "http://127.0.0.1:4000";
    expect(new AnthropicProvider({ apiKey: key, modelName: "m", baseUrl: loopback }).isLocal).toBe(false);
    expect(new OpenAiProvider({ apiKey: key, modelName: "m", baseUrl: loopback }).isLocal).toBe(false);
    expect(new GeminiProvider({ apiKey: key, modelName: "m", baseUrl: loopback }).isLocal).toBe(false);
    expect(new XaiProvider({ apiKey: key, modelName: "m", baseUrl: loopback }).isLocal).toBe(false);
  });

  test("no cloud adapter imports the base-URL locality helper", async () => {
    // Structural complement to the four value assertions above: a future adapter that imported
    // `isLoopbackBaseUrl` would be deriving locality, which is exactly the mistake I34 names.
    const files = await readDirFiles("packages/gateway/src/llm");
    const offenders = files
      .filter((f) => /-provider\.ts$/.test(f.rel) && !/^(ollama|llamacpp)-/.test(f.rel))
      .filter((f) => /isLoopbackBaseUrl/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
```

Import the four adapters at the top of the file.

- [ ] **Step 6: Run and red-prove**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I34"` — PASS.

Red-prove: change `AnthropicProvider`'s `readonly isLocal = false` to
`= isLoopbackBaseUrl(this.baseUrl)` (importing the helper). BOTH new tests must fail — the value
test and the import scan. Restore. This is the single most important red-prove in the slice: it is
the exact mistake §7.4 says is easiest to make.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/llm/route-availability.ts packages/gateway/src/llm/route-availability.test.ts \
        packages/gateway/src/security-invariants.test.ts
git commit -m "feat(llm): add the not_configured availability reason and I34 cloud-adapter rows"
```

---

### Task 7: Registration, validation, and the opt-in

Spec §7.1 (validation), §7.2 (vault), §7.4. This is where the opt-in becomes real. `addRoute`
already wraps every non-local provider in the I29 ledger decorator (slice 2a), so registering a
vendor here is what turns the `model` egress class from wired-but-zero-row into a live one.

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts`
- Test: `packages/gateway/src/platform/assemble.test.ts`

**Interfaces:**

- Consumes: `NimbusLlmToml.remoteVendors` (Task 1); the four adapter classes (Tasks 3-5); the vault
  key ids (Task 2).
- Produces, relied on by Task 9:
  - `buildLlmRegistryFromToml(db, activeTomlPath, vault, logger?)` — now **async**, returns
    `Promise<LlmRegistry>`
  - `type ResolvedRemoteVendor = { vendorId: string; modelName: string; apiKey: ApiKeyResolver }`
  - `function resolveEnabledVendors(llmToml, vault, logger): ResolvedRemoteVendor[]`

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/platform/assemble.test.ts`:

```ts
describe("[llm.remote.*] registration", () => {
  test("enabled = false registers NOTHING, even with the key in BOTH the Vault and the env", async () => {
    // The sharpest available test of the opt-in, and the reason `openai.api_key` is reused
    // rather than freshly minted: an existing embeddings user ALREADY has this key, so a
    // capability that turned itself on because a credential exists would light up for them
    // without their asking. Env AND Vault are both populated here on purpose.
    process.env["OPENAI_API_KEY"] = "sk-env";
    const vault = makeFakeVault({ "openai.api_key": "sk-vault" });
    const registry = await buildLlmRegistryFromToml(db, tomlWith(`
[llm.remote.openai]
enabled = false
model = "gpt-5"
`), vault);
    expect(registry.llmRouter.routes().filter((r) => !r.provider.isLocal)).toEqual([]);
    delete process.env["OPENAI_API_KEY"];
  });

  test("enabled = true with a Vault key registers exactly one remote route", async () => {
    const vault = makeFakeVault({ "anthropic.api_key": "sk-ant" });
    const registry = await buildLlmRegistryFromToml(db, tomlWith(`
[llm.remote.anthropic]
enabled = true
model = "claude-sonnet-4-6"
`), vault);
    const remote = registry.llmRouter.routes().filter((r) => !r.provider.isLocal);
    expect(remote).toHaveLength(1);
    expect(remote[0]?.routeId).toBe("anthropic/claude-sonnet-4-6");
  });

  test("enabled = true with NO key anywhere is dropped, warned BY NAME, and boot continues", async () => {
    const warnings: string[] = [];
    const registry = await buildLlmRegistryFromToml(db, tomlWith(`
[llm.remote.gemini]
enabled = true
model = "gemini-2.5-pro"
`), makeFakeVault({}), { warn: (m: string) => warnings.push(m) });
    expect(registry.llmRouter.routes().filter((r) => !r.provider.isLocal)).toEqual([]);
    expect(warnings.join("\n")).toContain("gemini");
  });

  test("an UNKNOWN vendor id is warned by name and dropped, and enforce_air_gap SURVIVES", async () => {
    // The failure this guards is not the dropped vendor -- it is `loadTomlSection`'s bare catch
    // reverting the WHOLE [llm] section, which would take `enforce_air_gap` back to false and
    // silently un-air-gap the install.
    const warnings: string[] = [];
    const registry = await buildLlmRegistryFromToml(db, tomlWith(`
enforce_air_gap = true

[llm.remote.notavendor]
enabled = true
model = "x"
`), makeFakeVault({ "anthropic.api_key": "k" }), { warn: (m: string) => warnings.push(m) });
    expect(warnings.join("\n")).toContain("notavendor");
    expect(registry.llmRouter.enforcesAirGap()).toBe(true);
  });

  test("a key added to the Vault AFTER boot is picked up with no restart", async () => {
    // The resolver is called per generate, not at registration.
    const store = new Map<string, string>();
    const vault = makeFakeVault(store);
    const registry = await buildLlmRegistryFromToml(db, tomlWith(`
[llm.remote.anthropic]
enabled = true
model = "claude-sonnet-4-6"
`), vault);
    const route = registry.llmRouter.routes().find((r) => !r.provider.isLocal);
    expect(await route?.provider.isAvailable()).toBe(false);
    store.set("anthropic.api_key", "sk-added-later");
    expect(await route?.provider.isAvailable()).toBe(true);
  });
});
```

Reuse whatever fake-vault and temp-toml helpers `assemble.test.ts` already has; add
`makeFakeVault` / `tomlWith` only if no equivalent exists, and match the file's existing style.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/gateway/src/platform/assemble.test.ts -t "llm.remote"`

Expected: FAIL — `buildLlmRegistryFromToml` takes no vault and is not async.

- [ ] **Step 3: Add the resolver and validation**

In `packages/gateway/src/platform/assemble.ts`:

```ts
/** The four vendors this build knows how to CONSTRUCT an adapter for. */
const KNOWN_REMOTE_VENDORS = new Set(["anthropic", "openai", "gemini", "xai"]);

export type ResolvedRemoteVendor = {
  vendorId: string;
  modelName: string;
  apiKey: ApiKeyResolver;
  baseUrl?: string;
};

/**
 * Validates `[llm.remote.*]` AFTER defaults are applied, here rather than in the parser.
 *
 * DO NOT "fix" this by moving it earlier. The instinct is to validate the raw table before
 * defaults so a vendor problem can be isolated -- but that moves validation TOWARD the parser,
 * and a throw there is swallowed by `loadTomlSection`'s bare catch, whose outcome is not a
 * dropped vendor but a silently reverted `[llm]` section with `enforce_air_gap` back at `false`.
 * Post-default validation loses nothing, because an absent `enabled` and an explicit
 * `enabled = false` mean the same thing -- no field here needs absent-versus-explicit
 * discrimination.
 *
 * Every rejection is warn-logged BY NAME. An entry that vanishes without a word is the shape
 * slice 1's `dropUnresolvableRoutePriorityEntries` refuses to allow.
 */
export function resolveEnabledVendors(
  llmToml: NimbusLlmToml,
  vault: { get(key: string): Promise<string | undefined> },
  logger: RouteValidationLogger,
): ResolvedRemoteVendor[] {
  const out: ResolvedRemoteVendor[] = [];
  for (const [vendorId, cfg] of llmToml.remoteVendors) {
    if (!cfg.enabled) continue; // Default-off. Not an error, not warned: it is the norm.
    if (!KNOWN_REMOTE_VENDORS.has(vendorId)) {
      logger.warn(
        `[llm.remote.${vendorId}] unknown vendor — dropped. Known: ${[...KNOWN_REMOTE_VENDORS].join(", ")}`,
      );
      continue;
    }
    if (cfg.model.trim() === "") {
      logger.warn(`[llm.remote.${vendorId}] empty model — dropped`);
      continue;
    }
    out.push({
      vendorId,
      modelName: cfg.model,
      // Resolved PER CALL from the Vault, never from the environment: no env var may satisfy a
      // vendor nobody opted into, and a key added after boot works with no restart.
      apiKey: () => vault.get(`${vendorId}.api_key`),
      ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
    });
  }
  return out;
}

function makeRemoteProvider(v: ResolvedRemoteVendor): LlmProvider {
  const opts = {
    apiKey: v.apiKey,
    modelName: v.modelName,
    ...(v.baseUrl === undefined ? {} : { baseUrl: v.baseUrl }),
  };
  switch (v.vendorId) {
    case "anthropic":
      return new AnthropicProvider(opts);
    case "openai":
      return new OpenAiProvider(opts);
    case "gemini":
      return new GeminiProvider(opts);
    default:
      return new XaiProvider(opts);
  }
}
```

- [ ] **Step 4: Make the builder async and register the vendors**

Change the signature and register after the local routes:

```ts
export async function buildLlmRegistryFromToml(
  db: Database,
  activeTomlPath: string,
  vault: { get(key: string): Promise<string | undefined> },
  logger: RouteValidationLogger = defaultRouteValidationLogger,
): Promise<LlmRegistry> {
```

At the end, before `void llmRegistry.refreshProviderMeta();`:

```ts
  // Registering a vendor here is what turns I29's `model` egress class from wired-but-zero-row
  // into a live one: `addRoute` passes every non-local provider through `wrapLedgeredProvider`
  // (slice 2a), so each of these routes ledgers before every generate, without the adapter
  // cooperating. A key that is enabled but unresolvable is dropped with a warning rather than
  // registered, so a keyless route never enters the priority walk at all.
  for (const v of resolveEnabledVendors(llmToml, vault, logger)) {
    const key = await v.apiKey();
    if (key === undefined || key.trim() === "") {
      logger.warn(
        `[llm.remote.${v.vendorId}] enabled but no ${v.vendorId}.api_key in the Vault — dropped`,
      );
      continue;
    }
    llmRegistry.addRoute(makeRemoteProvider(v), v.modelName);
  }
```

Update the single caller at `assemble.ts` (`const llmRegistry = buildLlmRegistryFromToml(db, activeTomlPath, {...})`)
to `await buildLlmRegistryFromToml(db, activeTomlPath, platformVault, {...})`, using whatever the
surrounding assembly already calls the vault instance. If that call site is not already inside an
`async` function, make it one and await at its own caller — do not fire-and-forget it, because the
registry must be fully populated before the router answers anything.

- [ ] **Step 5: Run the tests, typecheck and the wide-ish suite**

Run: `bun test packages/gateway/src/platform packages/gateway/src/llm && bun run typecheck && bun test packages/gateway/test`

Expected: PASS. `buildLlmRegistryFromToml` becoming async is a signature change — grep for every
caller (`grep -rn 'buildLlmRegistryFromToml' --include=*.ts packages/`) and confirm each awaits.

- [ ] **Step 6: Red-prove the opt-in**

Change `if (!cfg.enabled) continue;` to `if (false) continue;`. Re-run: the
"enabled = false registers NOTHING" test FAILS. Restore. This is the property the entire slice
exists to preserve — it must be observed failing.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts packages/gateway/src/platform/assemble.test.ts
git commit -m "feat(llm): register enabled [llm.remote.*] vendors behind a Vault-only opt-in"
```

---

### Task 8: Generate-time route fallback

Spec §6.4. Task 7 created this gap deliberately: a remote route's availability is answered offline,
so it reports available whatever the network is doing, and `LlmRouter.generate()` has **no try/catch
and no retry** — verified. Without this task, `route_priority = ["anthropic/…", "ollama/qwen3"]` with
no internet is a hard failure, while the roadmap row promises "with local fallback".

**Files:**

- Modify: `packages/gateway/src/llm/router.ts`
- Test: `packages/gateway/src/llm/router.test.ts`

**Interfaces:**

- Consumes: `LlmProviderError`, `LlmFailureKind` (Task 3).
- Produces: no new exports. `LlmRouter.generate` behaviour changes only.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/llm/router.test.ts`:

```ts
describe("generate-time route fallback (§6.4)", () => {
  test("a TRANSPORT failure falls through to the next route and succeeds", async () => {
    const router = makeRouter({ routePriority: ["remote/m1", "ollama/m2"] });
    const remoteGen = mock(async () => {
      throw new LlmProviderError("remote: HTTP 503", "transport", 503);
    });
    router.registerRoute(fakeProvider("remote", false, remoteGen), "m1");
    router.registerRoute(fakeProvider("ollama", true, async () => okResult("local answer")), "m2");

    const r = await router.generate({ task: "reasoning", prompt: "hi" });
    expect(r.text).toBe("local answer");
    expect(remoteGen).toHaveBeenCalledTimes(1);
  });

  test("an AUTH failure does NOT fall through — it fails at the first route", async () => {
    // A bad key fails identically at the next vendor, so retrying only sends the same prompt to
    // a second destination for nothing: one more real outbound request, one more ledger row, no
    // better answer.
    const router = makeRouter({ routePriority: ["remote/m1", "ollama/m2"] });
    const localGen = mock(async () => okResult("local answer"));
    router.registerRoute(
      fakeProvider("remote", false, async () => {
        throw new LlmProviderError("remote: HTTP 401", "auth", 401);
      }),
      "m1",
    );
    router.registerRoute(fakeProvider("ollama", true, localGen), "m2");

    await expect(router.generate({ task: "reasoning", prompt: "hi" })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
    expect(localGen).toHaveBeenCalledTimes(0);
  });

  test("a REQUEST failure does NOT fall through either", async () => {
    const router = makeRouter({ routePriority: ["remote/m1", "ollama/m2"] });
    const localGen = mock(async () => okResult("local answer"));
    router.registerRoute(
      fakeProvider("remote", false, async () => {
        throw new LlmProviderError("remote: HTTP 400", "request", 400);
      }),
      "m1",
    );
    router.registerRoute(fakeProvider("ollama", true, localGen), "m2");

    await expect(router.generate({ task: "reasoning", prompt: "hi" })).rejects.toThrow();
    expect(localGen).toHaveBeenCalledTimes(0);
  });

  test("an UNCLASSIFIED error does not fall through", async () => {
    // A plain Error carries no `kind`. Fail-closed on the RETRY decision: only an explicitly
    // transport-classified failure earns a second destination.
    const router = makeRouter({ routePriority: ["remote/m1", "ollama/m2"] });
    const localGen = mock(async () => okResult("local answer"));
    router.registerRoute(
      fakeProvider("remote", false, async () => {
        throw new Error("something else");
      }),
      "m1",
    );
    router.registerRoute(fakeProvider("ollama", true, localGen), "m2");

    await expect(router.generate({ task: "reasoning", prompt: "hi" })).rejects.toThrow();
    expect(localGen).toHaveBeenCalledTimes(0);
  });

  test("when EVERY route fails on transport, the LAST error is thrown", async () => {
    const router = makeRouter({ routePriority: ["remote/m1", "ollama/m2"] });
    router.registerRoute(
      fakeProvider("remote", false, async () => {
        throw new LlmProviderError("first", "transport", 503);
      }),
      "m1",
    );
    router.registerRoute(
      fakeProvider("ollama", true, async () => {
        throw new LlmProviderError("second", "transport", 500);
      }),
      "m2",
    );
    await expect(router.generate({ task: "reasoning", prompt: "hi" })).rejects.toThrow("second");
  });

  test("under air-gap the walk never reaches a non-local route", async () => {
    const router = makeRouter({ routePriority: ["remote/m1", "ollama/m2"], enforceAirGap: true });
    const remoteGen = mock(async () => okResult("cloud"));
    router.registerRoute(fakeProvider("remote", false, remoteGen), "m1");
    router.registerRoute(fakeProvider("ollama", true, async () => okResult("local")), "m2");

    expect((await router.generate({ task: "reasoning", prompt: "hi" })).text).toBe("local");
    expect(remoteGen).toHaveBeenCalledTimes(0);
  });
});
```

Reuse the file's existing router/provider fixtures; add `fakeProvider(id, isLocal, generate)` and
`okResult(text)` helpers only if no equivalents exist. Import `LlmProviderError` and `mock`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/gateway/src/llm/router.test.ts -t "generate-time route fallback"`

Expected: the transport-fallback test FAILS (the error propagates; the local route is never tried).
The auth/request/unclassified tests may pass incidentally today, because nothing falls through
at all — that is expected, and they become meaningful once the walk exists.

- [ ] **Step 3: Implement the walk**

Replace `LlmRouter.generate`:

```ts
  /**
   * Walks the task's priority order, trying each eligible route until one answers.
   *
   * Before §7.4 this method resolved ONE route and called it, with no try/catch — tolerable while
   * every route was local, because the availability probe genuinely predicted reachability. Cloud
   * adapters answer availability OFFLINE, so a remote route reports available whatever the network
   * is doing, and a single-shot call would turn "no internet" into a hard failure even with a
   * healthy local model next in line. The S2 roadmap row this serves promises local FALLBACK.
   *
   * The retry rule is deliberately narrow: only a TRANSPORT-class failure continues the walk. An
   * auth- or request-class failure fails identically at the next vendor, so retrying would only
   * send the same prompt to a second destination — one more real outbound request and one more
   * ledger row — for no better answer. An error with no classification is treated as non-retryable
   * for the same reason: retrying is the action that costs egress, so it is what must be earned.
   *
   * ONE PROMPT CAN PRODUCE N LEDGER ROWS across N destinations, and that is CORRECT — each row
   * records a real outbound request. Do not "deduplicate" them; a ledger that collapsed them would
   * under-report egress. The rows appear naturally, one per attempt, because each attempt goes
   * through its own wrapped provider.
   */
  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const routes = await this.eligibleRoutesInPriorityOrder(opts.task);
    if (routes.length === 0) {
      throw new Error(`No LLM provider available for task: ${opts.task}`);
    }

    let lastError: unknown;
    for (const route of routes) {
      const adjusted = await this.fitPromptOrFallback(opts, route);
      const target = adjusted.kind === "route" ? adjusted.route : route;
      try {
        return await target.provider.generate(adjusted.opts);
      } catch (err) {
        lastError = err;
        if (err instanceof LlmProviderError && err.kind === "transport") {
          continue; // Try the next destination.
        }
        throw err; // Auth, request, or unclassified: the next vendor cannot do better.
      }
    }
    throw lastError;
  }
```

Add a private helper that returns every route passing the same gates `firstAvailableRoute` applies
(air-gap exclusion, capability floor, availability), in priority order, rather than only the first:

```ts
  /**
   * Every route that passes the same gates `firstAvailableRoute` applies, in priority order —
   * air-gap exclusion FIRST, so a non-local route is never a candidate under `enforce_air_gap`
   * however the walk below behaves.
   */
  private async eligibleRoutesInPriorityOrder(task: LlmTaskType): Promise<ModelRoute[]> {
    const out: ModelRoute[] = [];
    for (const route of this.orderedRoutes()) {
      if (this.config.enforceAirGap && !route.provider.isLocal) continue;
      if (!this.meetsCapabilityFloor(route, task)) continue;
      if (!(await this.probe.check(route)).available) continue;
      out.push(route);
    }
    return out;
  }
```

Match `firstAvailableRoute`'s existing gate order and availability source exactly — read it first
and mirror it, rather than reconstructing the checks from this snippet. If it takes an injected
`isAvailable`, thread the same one through.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/llm && bun run typecheck && bun test packages/gateway/test`

Expected: PASS, including every pre-existing `router.test.ts` case — `generate` is widely consumed
and this changes its failure semantics.

- [ ] **Step 5: Red-prove both directions**

1. Change `err.kind === "transport"` to `true`. Re-run: the auth, request and unclassified tests
   FAIL. Restore.
2. Change it to `false`. Re-run: the transport-fallback test FAILS. Restore.

Both directions matter: one guards against retrying what must not be retried, the other against
never retrying at all.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/llm/router.ts packages/gateway/src/llm/router.test.ts
git commit -m "feat(llm): continue the priority walk on a transport-class generate failure"
```

---

### Task 9: The Mastra unification and its ledger seam

Spec §6.2, §6.3. **Read the "Pre-flight findings" section at the top of this plan first** — both of
§6.3's open questions are already answered, and the escape hatch is not needed.

**Files:**

- Create: `packages/gateway/src/engine/mastra-model-egress.ts`
- Create: `packages/gateway/src/engine/mastra-model-egress.test.ts`
- Modify: `packages/gateway/src/engine/agent.ts`
- Modify: `packages/gateway/src/gateway-main.ts`

**Interfaces:**

- Consumes: `ResolvedRemoteVendor` (Task 7); `appendEgressEntry` is NOT importable here — see below.
- Produces:
  - `function wrapLedgeredMastraModel(db, inner, meta): MastraLanguageModelV2`
  - `NimbusEngineAgentDeps.vendor?: { providerId: string; modelId: string; apiKey: string }`

> **D22(b) constraint.** `appendEgressEntry` may only be NAMED inside
> `packages/gateway/src/egress/`. So `wrapLedgeredMastraModel` must live in `egress/` **or** take an
> injected appender. Put the file at `packages/gateway/src/egress/mastra-model-egress.ts` and import
> it from `engine/`, exactly as slice 2a put `wrapLedgeredProvider` in `egress/model-egress.ts`.
> Update the File Structure row above accordingly when you create it.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/egress/mastra-model-egress.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listEgress } from "./egress-verify.ts";
import { wrapLedgeredMastraModel } from "./mastra-model-egress.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

function fakeModel(onCall: () => void) {
  return {
    specificationVersion: "v2" as const,
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    supportedUrls: Promise.resolve({}),
    doGenerate: mock(async () => {
      onCall();
      return { content: [] };
    }),
    doStream: mock(async () => {
      onCall();
      return { stream: new ReadableStream() };
    }),
  };
}

describe("wrapLedgeredMastraModel", () => {
  test("doGenerate appends exactly one model row, destination = providerId", async () => {
    const inner = fakeModel(() => undefined);
    const wrapped = wrapLedgeredMastraModel(db, inner as never, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      now: () => 1234,
    });
    await wrapped.doGenerate({} as never);

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "model",
      sourceId: "claude-sonnet-4-6",
      destination: "anthropic",
      method: "engine.agent.generate",
      resultStatus: "authorized",
    });
    expect(rows[0]?.timestamp).toBe(1234);
  });

  test("doStream appends its own row, named distinctly", async () => {
    const inner = fakeModel(() => undefined);
    const wrapped = wrapLedgeredMastraModel(db, inner as never, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    await wrapped.doStream({} as never);
    expect(listEgress(db, {})[0]?.method).toBe("engine.agent.stream");
  });

  test("fail-closed: an append failure throws and the inner model never runs", async () => {
    let called = false;
    const inner = fakeModel(() => {
      called = true;
    });
    const wrapped = wrapLedgeredMastraModel(db, inner as never, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    db.exec("DROP TABLE egress_ledger");

    await expect(wrapped.doGenerate({} as never)).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("passes through the identity fields Mastra reads", () => {
    const inner = fakeModel(() => undefined);
    const wrapped = wrapLedgeredMastraModel(db, inner as never, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(wrapped.specificationVersion).toBe("v2");
    expect(wrapped.provider).toBe("anthropic");
    expect(wrapped.modelId).toBe("claude-sonnet-4-6");
  });
});
```

- [ ] **Step 2: Run them to verify they fail** — module not found.

- [ ] **Step 3: Write the decorator**

Create `packages/gateway/src/egress/mastra-model-egress.ts`:

```ts
// packages/gateway/src/egress/mastra-model-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

/**
 * The SECOND `model`-class appender, and the reason there are two.
 *
 * `wrapLedgeredProvider` (`model-egress.ts`) covers the ROUTE TABLE. The Mastra engine agent does
 * not use the route table: it resolves its model through `@mastra/core`, keeps its own HTTP client,
 * and that client is what makes tool-calling work. `LlmGenerateOptions` has no `tools` field, so an
 * adapter built over `LlmProvider` would silently kill the agent's tool-calling — including the
 * three negation tools, which live only on this path. The property wanted (one ledger, air-gap
 * honoured, one opt-in) is therefore achieved at the AI-SDK seam instead.
 *
 * ACCEPTED COST, stated rather than hidden: after slice 2b there are two HTTP clients for
 * Anthropic — `llm/anthropic-provider.ts` for the route table and Mastra's own for the agent. The
 * agent loop is Mastra's, so its wire is Mastra's; the route table is ours, so its wire is ours.
 * Both are ledgered, by their respective wrappers.
 *
 * Intercepts `doGenerate` / `doStream` ONLY. Everything else is passed through, so Mastra keeps its
 * client, its tool-calling and its streaming.
 */
export function wrapLedgeredMastraModel<T extends object>(
  db: Database,
  inner: T,
  meta: { providerId: string; modelId: string; now?: () => number },
): T {
  const now = meta.now ?? Date.now;

  const ledger = (method: string): void => {
    // Ledger THEN act, and abort on failure — the same fail-closed order as the route-table
    // wrapper. A window with no rows means no prompt left the machine, never that one left
    // unrecorded.
    try {
      appendEgressEntry(db, {
        timestamp: now(),
        sourceType: "model",
        sourceId: meta.modelId,
        destination: meta.providerId,
        method,
        payloadSummary: redactEgressSummary({ model: meta.modelId, via: "mastra" }),
        hitlStatus: "not_required",
        resultStatus: "authorized",
      });
    } catch (err) {
      throw new EgressAppendFailedError(err);
    }
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "doGenerate" || prop === "doStream") {
        const method = prop === "doGenerate" ? "engine.agent.generate" : "engine.agent.stream";
        return (...args: unknown[]) => {
          ledger(method);
          return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
        };
      }
      // A Proxy rather than a hand-built object literal: `ModelRouterLanguageModel` carries
      // private (`#`) fields and getters whose `this` must stay the real instance. Copying its
      // surface field-by-field would break on the next Mastra release that adds one.
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as T;
}
```

- [ ] **Step 4: Run the tests** — all four PASS. Then `bun run typecheck`.

- [ ] **Step 5: Wire the agent onto `[llm.remote.*]`**

In `packages/gateway/src/engine/agent.ts`:

- Add to `NimbusEngineAgentDeps`:

```ts
  /**
   * The resolved cloud vendor this agent talks to. REQUIRED for the agent to exist at all: when
   * no `[llm.remote.*]` vendor is enabled, `gateway-main.ts` does not construct the agent, and
   * `resolveEngineAgent` returns undefined.
   *
   * This replaces `getEffectiveAgentModel()`. That read `[llm] remote_model` and let
   * `@mastra/core` resolve `ANTHROPIC_API_KEY` from the ENVIRONMENT on its own — so the default
   * `nimbus ask` was a hole exactly the size of the per-vendor opt-in: a capability that turned
   * itself on because a credential happened to exist. That is the air-gap defect's shape, one
   * level up.
   */
  vendor: { providerId: string; modelId: string; apiKey: string };
  egressDb: Database;
```

- Replace `const model = toMastraModelId(deps.agentModel ?? getEffectiveAgentModel());` with:

```ts
  // `NIMBUS_AGENT_MODEL` / `[llm] remote_model` still override the MODEL NAME within the enabled
  // vendor, so no existing config breaks silently — but they can no longer select a vendor, and
  // they can no longer supply a credential.
  const modelId = deps.agentModel ?? deps.vendor.modelId;
  const model = wrapLedgeredMastraModel(
    deps.egressDb,
    new ModelRouterLanguageModel({
      id: `${deps.vendor.providerId}/${modelId}` as `${string}/${string}`,
      apiKey: deps.vendor.apiKey,
    }),
    { providerId: deps.vendor.providerId, modelId },
  );
```

Import `ModelRouterLanguageModel` from `@mastra/core/llm` and `wrapLedgeredMastraModel` from
`../egress/mastra-model-egress.ts`. Delete the now-unused `getEffectiveAgentModel` import; leave
`toMastraModelId` only if something else still calls it, otherwise delete it too.

- [ ] **Step 6: Make the agent conditional in `gateway-main.ts`**

```ts
  // No enabled vendor means NO remote inference anywhere, including the default `nimbus ask`.
  // `runTurn` and `runViaAgent` already handle `p.agent === undefined` on every branch, so this
  // introduces no new failure mode — it removes one.
  const vendor = await resolveAgentVendor(platform, activeTomlPath);
  const engine =
    vendor === undefined
      ? undefined
      : createNimbusEngineAgent({
          localIndex: platform.localIndex,
          auditDb: platform.localIndex.getDatabase(),
          egressDb: platform.localIndex.getDatabase(),
          vendor,
          ...(platform.sessionMemoryStore === undefined
            ? {}
            : { sessionMemoryStore: platform.sessionMemoryStore }),
        });

  function resolveEngineAgent(name: string | undefined): Agent | undefined {
    if (engine === undefined) return undefined;
    const key = name?.toLowerCase().trim();
    if (key === "devops") return engine.agentsByName.devops;
    if (key === "research") return engine.agentsByName.research;
    return engine.agentsByName.nimbus;
  }
```

`resolveAgentVendor` picks the FIRST enabled-and-keyed vendor from `resolveEnabledVendors`
(Task 7), resolving its key once via `await v.apiKey()`; it returns `undefined` when none is
enabled or none has a key. `resolveEngineAgent`'s return type widens to `Agent | undefined` —
follow the compiler to every call site and confirm each already tolerates `undefined` (they do:
`runTurn` and `runViaAgent` branch on `p.agent === undefined` today).

- [ ] **Step 7: Add the no-vendor test**

```ts
test("with no enabled vendor the engine agent is not constructed at all", async () => {
  // Not merely "the agent refuses" — it must not EXIST, because `@mastra/core` resolves
  // ANTHROPIC_API_KEY from the environment on its own the moment one is constructed.
  process.env["ANTHROPIC_API_KEY"] = "sk-env";
  const { resolveEngineAgent } = await bootGatewayForTest({ toml: `prefer_local = true` });
  expect(resolveEngineAgent(undefined)).toBeUndefined();
  delete process.env["ANTHROPIC_API_KEY"];
});
```

Place it wherever `gateway-main`'s existing boot tests live; if none exist, assert the same property
at the `resolveAgentVendor` level instead and say so in the test name.

- [ ] **Step 8: Run everything touched**

Run: `bun test packages/gateway/src/engine packages/gateway/src/egress packages/gateway/src/platform && bun run typecheck && bun test packages/gateway/test`

- [ ] **Step 9: Red-prove the ledger seam and the opt-in**

1. Remove the `wrapLedgeredMastraModel(...)` call, passing the bare `ModelRouterLanguageModel`.
   Re-run: the `mastra-model-egress` fail-closed and row-count tests still pass (they test the
   decorator directly), but add one agent-level assertion that a `nimbus ask` turn appends a
   `model` row, and confirm THAT fails. Restore.
2. Change the `vendor === undefined` guard to always construct. Re-run: the no-vendor test FAILS.
   Restore.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/egress/mastra-model-egress.ts packages/gateway/src/egress/mastra-model-egress.test.ts \
        packages/gateway/src/engine/agent.ts packages/gateway/src/gateway-main.ts
git commit -m "feat(engine): put the Mastra agent behind the vendor opt-in and the egress ledger"
```

---

### Task 10: Status surface and CLI shape parity

Spec §10. **The LOCAL column already exists** — slice 1 added `local: 7` to `COL_WIDTHS` and
`isLocal` to the CLI's `RouteStatus`. This task adds the `not_configured` rendering and the
shape-parity test.

**Files:**

- Modify: `packages/cli/src/commands/llm.ts`
- Create: `packages/cli/src/commands/llm-shape-parity.test.ts`
- Test: `packages/cli/src/commands/llm.test.ts`

**Interfaces:**

- Consumes: `RouteAvailability["reason"]` gaining `not_configured` (Task 6).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/src/commands/llm.test.ts`:

```ts
test("not_configured renders its own remedy, not a bare unavailable", () => {
  // Three different fixes: start the daemon, pull the model, add a key. Collapsing the third
  // would send the user to check their network for a missing credential.
  const out = renderRoutes([
    { routeId: "openai/gpt-5", providerId: "openai", modelName: "gpt-5", isLocal: false,
      available: false, reason: "not_configured" },
  ]);
  expect(out).toContain("no (no api key)");
  expect(out).not.toContain("provider unreachable");
});
```

Create `packages/cli/src/commands/llm-shape-parity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * `packages/cli` keeps a PRIVATE copy of the gateway's route-status type — a shared type is
 * forbidden by the IPC-only dependency rule — and nothing pinned the copy to the payload. That
 * has already broken `nimbus llm status` once with the whole suite green, because the CLI tests
 * mock the IPC client wholesale and never see a real payload.
 *
 * This closes the drift without introducing a shared type. It does NOT make the CLI tests
 * exercise a real payload; that bound survives and is stated here so nobody reads this test as
 * more than it is.
 */
describe("CLI RouteStatus ≡ gateway LlmRouteStatus", () => {
  function fieldsOf(src: string, typeName: string): string[] {
    const start = src.indexOf(`type ${typeName} = {`);
    const alt = src.indexOf(`export type ${typeName} = {`);
    const at = start >= 0 ? start : alt;
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("};", at));
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] as string).sort();
  }

  test("field names match one-for-one", async () => {
    const repo = resolve(import.meta.dir, "../../../..");
    const cli = await readFile(resolve(repo, "packages/cli/src/commands/llm.ts"), "utf8");
    const gw = await readFile(resolve(repo, "packages/gateway/src/ipc/llm-rpc.ts"), "utf8");
    expect(fieldsOf(cli, "RouteStatus")).toEqual(fieldsOf(gw, "LlmRouteStatus"));
  });
});
```

- [ ] **Step 2: Run them to verify they fail** — the parity test passes only if the shapes already
match (they should); the `not_configured` test FAILS, rendering `no (not_configured)`.

- [ ] **Step 3: Render the new reason**

In `packages/cli/src/commands/llm.ts`, extend `availabilityText`:

```ts
function availabilityText(route: RouteStatus): string {
  if (route.available) return "yes";
  if (route.reason === "provider_unreachable") return "no (provider unreachable)";
  if (route.reason === "model_absent") return "no (model not pulled)";
  // A cloud route that is enabled but keyless. Its remedy is a Vault key, not a daemon or a pull.
  if (route.reason === "not_configured") return "no (no api key)";
  return `no (${route.reason})`;
}
```

Extend the `RouteReason` union with `"not_configured"`, keeping the trailing `| string` so a future
reason still degrades to raw text rather than a type error.

- [ ] **Step 4: Run, red-prove, commit**

Run: `bun test packages/cli/src/commands && bun run typecheck`

Red-prove the parity test: add `zzTemp: string;` to the CLI's `RouteStatus`, confirm the parity test
FAILS, remove it, confirm it passes. A structural test that never failed is not known to compare
anything.

```bash
git add packages/cli/src/commands/llm.ts packages/cli/src/commands/llm.test.ts \
        packages/cli/src/commands/llm-shape-parity.test.ts
git commit -m "feat(cli): render not_configured and pin the CLI route-status shape"
```

---

### Task 11: Docs

Spec §12. These change **together with their wiring** — the triple rule, and "correct a claim at
every restatement". The slice-2a docs say the `model` class "appends zero rows in production"; that
becomes FALSE the moment Task 7 lands, and it is restated in several files.

**Files:** `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, `CLAUDE.md`, `GEMINI.md`,
`.claude/commands/nimbus-egress.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`

- [ ] **Step 1: Find every restatement before editing any of them**

```bash
grep -rn "appends zero rows in production\|wired but appends zero\|zero-row" --include=*.md . \
  | grep -v node_modules | grep -v '/.claude/worktrees/'
grep -rn "ships only .OllamaProvider. and .LlamaCppProvider" --include=*.md . \
  | grep -v node_modules | grep -v '/.claude/worktrees/'
```

Fix every hit in ONE commit. Sweep on the RANGE and the WORD form too, not just the phrase you
remember — a claim in several spellings needs a sweep per spelling.

- [ ] **Step 2: Update the I29 `model` class**

It is no longer latent. State: four vendors registrable behind a default-off per-vendor opt-in; the
route table ledgered by `wrapLedgeredProvider`; the Mastra agent ledgered by
`wrapLedgeredMastraModel` at the AI-SDK seam; and that **one exclusion remains** — embeddings.

**Delete the Mastra-engine-agent exclusion**, which slice 2a documented as an open gap: this slice
closes it. Do NOT add a Mastra metadata exclusion — the pre-flight verification found none.

State the §6.4 consequence explicitly: **one prompt can now produce N ledger rows across N
destinations**, which is correct and must not be deduplicated.

- [ ] **Step 3: Update I34, the roadmap and the CHANGELOG**

I34 gains the cloud-adapter half: locality hardcoded `false`, never derived from `base_url`.

Roadmap: mark the "bring-your-own-frontier-model routing with local fallback" row **delivered**,
noting slice 3 still owns Bedrock/SigV4 and slice 4 the `[llm.tasks]` pinning.

CHANGELOG: a dated entry covering the four vendors, the opt-in, the fallback walk, the Mastra
unification, and the fact that the `model` egress class is now exercised in production for the
first time.

- [ ] **Step 4: Run the doc gates**

Run: `bun run lint:markdown && bun run audit:doc-refs && bun run audit:status-drift`

Then check for absolute links, which pass locally and fail lychee on CI:
`grep -rn "file:///" --include=*.md docs/ *.md` — expected: only prose describing the check itself.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md .claude/commands/
git commit -m "docs: the model egress class is now exercised; four vendors, one exclusion left"
```

---

### Task 12: Full verification

The per-task gate deliberately skipped the wide suite. `LlmRouter.generate`, `RouteAvailability` and
the agent constructor are all widely consumed.

- [ ] **Step 1: The gateway `test/` tree** — `bun test packages/gateway/test`. Not loaded by a `src`
  run, and `mock.module` is process-global, so a per-package run and a whole-repo run do not have
  the same mocks in play.

- [ ] **Step 2: The CI command, verbatim** — `bun test packages/gateway packages/cli scripts`.
  Do not substitute a narrower one.

- [ ] **Step 3: Typecheck both trees** — `bun run typecheck && bun run typecheck:tests`.
  `typecheck:tests` is **advisory on win32**: read its output, do not trust its exit code.

- [ ] **Step 4: Static gates** — `bun run preflight:fast` (does NOT include the coverage floor).

- [ ] **Step 5: Linux-authoritative coverage.** `llm/` and `egress/` sit under the Engine ≥85% gate,
  and this slice adds ~6 files there. `verify:docker --changed` runs only the changed TESTS — the
  coverage floor is in the `--full` tier, which OOMs on an 8 GB WSL cap. Use the documented
  substitute: run the docker block of `scripts/coverage-floor/reseed-docker.sh` **with the
  `--update-baseline` line removed**, then `bun run audit:coverage-floor` and
  `bun run audit:coverage-scopes` against the COMMITTED baseline. Reseeding would accept whatever
  the branch produces and report green regardless.

- [ ] **Step 6: Prove no test reaches a vendor**

```bash
grep -rn "api\.anthropic\.com\|api\.openai\.com\|generativelanguage\|api\.x\.ai" \
  --include=*.test.ts packages/ | grep -v node_modules
```

Expected: only URL-ASSERTION lines inside adapter tests that stub `fetch`. Any test that could
issue a real request is a defect. Confirm every adapter test file restores `globalThis.fetch` in
`afterEach`.

- [ ] **Step 7: Open the PR**

Title carries the conventional-commit type for release-please; the PR title and body BECOME the
squash commit. Balance every parenthesis in the body — an unbalanced `(` has silently dropped a
commit from release-please three times.

```text
feat(llm): register four cloud vendors behind a default-off per-vendor opt-in
```

Watch `PR quality — required gates` to green before merging, or use
`gh pr merge --squash --auto`. Org-admin bypass is silent.

---

## Self-Review

**Spec coverage.** §6.2 → Task 9 Steps 5-6. §6.3 → Task 9 Steps 1-4, with both open questions
resolved in Pre-flight. §6.4 → Task 8. §7.1 → Tasks 1 (parse) + 7 (validate). §7.2 → Tasks 2 + 7.
§7.3 → Tasks 3-5. §7.4 → Tasks 3-6 (hardcoded `isLocal`, offline availability, `not_configured`).
§8 → Task 6 Step 5 (I34's cloud half; the local half shipped in 2a). §10 → Task 10. §11 → the
per-task tests plus Task 12. §12 → Task 11.

**Deliberately NOT in this plan**, all per §3: Bedrock/SigV4 (slice 3); `[llm.tasks]` pinning and
`nimbus llm use` (slice 4); an embeddings appender; per-call HITL on inference; a local
OpenAI-compatible runtime (`runtime = "openai-compatible"`), deferred because its derived-locality
rule is the INVERSE of the four hardcoded ones landing here and deserves its own attention.

**Two spec claims this plan corrects**, both verified against the code: §10's "gains a LOCAL column"
(it already has one) and §7.2's implied location for `PLATFORM_VAULT_KEYS` (it is in
`scripts/structure-audit/`). Both are called out at the top.

**One constraint the spec does not mention but D22 imposes:** `appendEgressEntry` may only be named
inside `packages/gateway/src/egress/`, so the Mastra decorator lives there and is imported by
`engine/`, not the other way round. Task 9 says so explicitly.

**Type consistency.** `ApiKeyResolver` is defined in Task 3 and consumed in Tasks 4, 5, 7.
`LlmProviderError` / `LlmFailureKind` / `classifyHttpStatus` are defined in Task 3 and consumed in
Tasks 4, 5, 8. `ResolvedRemoteVendor` is defined in Task 7 and consumed in Task 9.
`RouteAvailability["reason"]` gains `not_configured` in Task 6 and is rendered in Task 10. The four
adapter constructors all take `{ apiKey, modelName, baseUrl? }`.
