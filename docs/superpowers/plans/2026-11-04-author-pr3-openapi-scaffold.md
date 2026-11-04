# Author onboarding PR 3 — `nimbus scaffold extension --from-openapi` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nimbus scaffold extension <name> --from-openapi <path|url>` writes a working, installable extension with one MCP tool per OpenAPI operation, its network hosts and credentials declared, and offline tests.

**Architecture:** Three pure stages under `packages/cli/src/commands/scaffold-openapi/`: load (path or https URL → parsed document), model (document → a validated operation table, hosts, credentials, skipped list), generate (model → `ScaffoldFile[]`). The operation table is written as DATA (`src/operations.json`), never interpolated into TypeScript; the generated code is a fixed template (`src/request.ts`, dependency-free, plus `src/tools.ts`) that reads the table. `runScaffold` gains the flag and becomes async for the URL fetch.

**Tech Stack:** Bun, TypeScript strict, `yaml` (already a CLI dependency), `@nimbus-dev/registry-format` (manifest parse, `deriveExtensionServiceId`, `isFundingUrl`-style URL checks), Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-author-onboarding-design.md` § 4, branch `dev/asaf/author-onboarding-spec`. Owner ruling R3 (an extension, not a connector).

## Global Constraints

- Input: OpenAPI `3.0.x` / `3.1.x`, JSON or YAML. Swagger `2.0` refused (`Swagger 2.0 is not supported; convert it to OpenAPI 3 first (for example with swagger2openapi)`); a document with no `openapi` string refused.
- URL fetch (CLI-side, not ledgered, no air-gap check — stated in docs): `https:` only; at most 5 redirects, each `https:`; at most 10 MiB (10,485,760 bytes) read; 30 s total timeout.
- Only local `$ref` (`#/…`, JSON-pointer with `~0`/`~1` unescaping) resolved, walking own properties only (`Object.hasOwn`), refusing the segments `__proto__`, `constructor` and `prototype`; every object built from the document is created with `Object.create(null)` or checked the same way; an external `$ref` refused naming the pointer; cycles cut at depth 8 with `{}` and one warning per cut.
- Hosts: IP literals (v4 or v6, `net.isIP`) are skipped with a warning, as are `localhost` and `*.local`. From `servers[].url` (document and operation level) after server-variable defaults; `https:` only; host must pass the manifest's hostname rule (validate the generated manifest with `parseExtensionManifestForRegistry`); `host` when the port is 443 or absent, else `host:port`; deduplicated, sorted. No usable server → refuse (`the document names no https server the extension could call`).
- Operations: more than 200 refused unless `--max-operations <n>` (positive integer) raises the cap.
- Tool name: `operationId` normalised to `[a-z0-9_]` (lower-case; other runs → `_`; trimmed `_`), else `<method>_<path segments>`; collisions `_2`, `_3`; length cap `64 - len(serviceId) - 2` where `serviceId = deriveExtensionServiceId(id)`; a cut name is listed in the output.
- Input schema per tool: object with path, query, header parameters (a name clashing across locations gets `<location>_` prefix) plus `body` for an `application/json` (or `+json`) request body. Form/multipart bodies: tool generated, README notes it, request refuses at call time.
- Description: `summary`, else `description`, cut at 512 chars.
- Credentials: `apiKey` (header/query) and `http` bearer → one entry; `http` basic → `<scheme>_user` and `<scheme>_password`; name = scheme name normalised to `[a-z0-9_]`, prefixed `c_` when it does not start with a letter, cut so the FINAL name (with any `_user`/`_password` and `_N` suffix) is at most 32 chars, `_2` on collision; env = name upper-cased, prefixed `API_` when that would be reserved (registry-format's own `isReservedEnv` — export it from `manifest.ts` and the package index in Task 2; do not copy the list); the generated manifest must parse. Each operation uses the first supported alternative of its own `security`, else the document's; none → no credential. Unsupported schemes (oauth2, openIdConnect, cookie apiKey) listed in the README.
- Generated code safety: NO value from the document is ever written into a `.ts` file. All of it goes into `src/operations.json` (written with `JSON.stringify`). `src/request.ts` and `src/tools.ts` are fixed strings (only the extension name substitution the existing scaffold already does).
- Request behaviour (in the fixed `src/request.ts`): builds the URL as `<server without trailing />` + `/` + `<path without leading />` (so a server base path such as `/v1` is kept, and `//` never makes a protocol-relative URL), from the operation's server and path template (each path parameter `encodeURIComponent`ed; a missing required parameter refused before any request); refuses a URL whose host is not in the operation table's host set; sends the credential from `process.env[<env>]`; `redirect: "manual"` (a 3xx returns status and `Location` as text, so a credential never follows a redirect); 30 s timeout; response body as text cut at 65,536 characters with a marker `\n[truncated]`.
- No eval stub (I49: evals run with no network); the README points at `nimbus eval --record`.
- No new IPC method; no gateway change; no invariant change.
- Run `bun run preflight:fast` and `bun run typecheck:tests` before every push. Sonar cognitive complexity ≤ 15 per function; new files ≥ 85% lines / 80% branches on CI-Linux.

## Rulings made in this plan (against the spec)

- **The operation table is data (`operations.json`), not generated TypeScript.** The spec said `src/operations.ts`. Writing untrusted document text into source invites code injection (CodeQL `js/code-injection`); JSON cannot execute. Cost if wrong: one rename for authors who expected a `.ts` table.
- **`redirect: "manual"`.** The spec said the request "sends only to the table's server"; following redirects could carry a credential header to another host. Cost if wrong: an API that redirects needs a one-line change by the author.

## Plan review record

Antigravity (2026-11-04) raised 11 findings, all applied: `isReservedEnv` is private (now exported); `parseExtensionArgs` is private and `ScaffoldArgs` lacked the fields; `buildExtensionScaffoldFiles` takes four parameters; `index.ts` already awaits handlers; basic-auth names could exceed 32 chars or start with a digit; prototype pollution through `$ref` segments and the tool lookup; URL joining dropped a server base path; the low-level `Server` needs the tools capability; `createServer` needed injectable fetch and env; BOM and flow-style YAML; IP literals pass the hostname rule.

## Review Focus

1. A document whose strings contain backticks, `${`, `*/`, quotes or newlines produces generated code byte-identical to the template — the strings appear only in `operations.json` (Task 3).
2. A `$ref` cycle, an external `$ref`, and a `$ref` to a missing pointer each give their message, never a stack overflow (Task 2).
3. Two operations that normalise to the same name, and a name longer than the cap, both end distinct and within the cap (Task 2).
4. A server URL with variables but no defaults, `http:`, or an IP literal is skipped with a warning; the generated manifest parses (Task 2, Task 3).
5. A URL fetch that redirects to `http:` or exceeds 10 MiB is refused with nothing written (Task 1).

---

### Task 1: Load the document

**Files:** Create `packages/cli/src/commands/scaffold-openapi/load.ts` (+ `.test.ts`).

**Interfaces:**
- Produces:
  ```ts
  export interface LoadDeps { fetch: typeof fetch; readFile: (p: string) => Promise<Uint8Array>; now: () => number }
  export const MAX_OPENAPI_BYTES = 10 * 1024 * 1024;
  export async function loadOpenApiDocument(source: string, deps: LoadDeps): Promise<Record<string, unknown>>;
  export class OpenApiLoadError extends Error {}
  ```
- A leading UTF-8 BOM is stripped. `source` starting `https://` → fetch (manual redirects, following at most 5, each must be `https:`; streaming read refusing past the cap; 30 s via `AbortSignal.timeout`); starting `http://` or any other scheme → refused; else a file path. Parse: JSON if the first non-space char is `{` and `JSON.parse` succeeds, else YAML (flow-style YAML may start with `{`) (`yaml` `parse`, with `maxAliasCount: 100`). Not an object, no `openapi` string, `swagger: "2.0"`, or an `openapi` not starting `3.0.`/`3.1.` → `OpenApiLoadError` with the exact messages in Global Constraints (version: `OpenAPI <v> is not supported; use 3.0 or 3.1`).

- [ ] **Step 1: Failing tests** with injected `fetch`/`readFile`: JSON and YAML files parse; Swagger 2.0, `openapi: "4.0.0"`, a non-object and a missing `openapi` each give their message; `http://` refused without calling fetch; a redirect chain of 6 refused; a redirect to `http:` refused; a body of `MAX_OPENAPI_BYTES + 1` refused; a YAML alias bomb refused.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(cli): load an OpenAPI document for the extension scaffold`.

### Task 2: The operation model

**Files:** Create `packages/cli/src/commands/scaffold-openapi/model.ts`, `refs.ts`, `names.ts` (+ `.test.ts` each).

**Interfaces:**
- Also: export `isReservedEnv` from `packages/registry-format/src/manifest.ts` and re-export it from the package index (rebuild the registry action dist and run `bun run audit:action-dist`).
- Produces:
  ```ts
  export interface ParamDef { readonly name: string; readonly in: "path" | "query" | "header"; readonly arg: string; readonly required: boolean }
  export interface CredentialUse { readonly kind: "header" | "query" | "bearer" | "basic"; readonly name?: string; readonly env: string; readonly passwordEnv?: string }
  export interface OperationDef {
    readonly tool: string; readonly method: string; readonly path: string; readonly server: string;
    readonly params: readonly ParamDef[]; readonly body: "json" | "unsupported" | null;
    readonly inputSchema: Record<string, unknown>; readonly description: string;
    readonly credential: CredentialUse | null;
  }
  export interface OperationModel {
    readonly hosts: readonly string[]; readonly operations: readonly OperationDef[];
    readonly credentials: Readonly<Record<string, { readonly env: string }>>;
    readonly skipped: readonly { readonly operation: string; readonly reason: string }[];
    readonly unsupportedSchemes: readonly string[]; readonly warnings: readonly string[];
    readonly cutNames: readonly { readonly from: string; readonly to: string }[];
  }
  export function buildOperationModel(doc: Record<string, unknown>, opts: { serviceId: string; maxOperations: number }): OperationModel;
  export class OpenApiModelError extends Error {}
  ```
- `refs.ts`: `resolveRefs(node: unknown, root: Record<string, unknown>, depth?: number): unknown` per Global Constraints. `names.ts`: `toolName(op, method, path)`, `uniqueNames(names, cap)`, `credentialName(scheme)`.
- An operation whose own `servers` all fail is skipped with a reason; one whose path template names a parameter it does not declare is skipped.

- [ ] **Step 1: Failing tests:** every Global Constraints rule for hosts, names, input schema, description, credentials and the cap, one test each, with exact values; plus Review Focus 2–4. A Petstore-like fixture (`__fixtures__/petstore.json`, written by hand, 4 operations, apiKey + bearer + basic schemes, a `$ref`'d schema, a cycle) gives an exact expected model (`toEqual`).
- [ ] **Step 2–4:** run, implement, run.
- [ ] **Step 5:** complexity lint on the three files (split by phase if any function exceeds 15).
- [ ] **Step 6: Commit** `feat(cli): turn an OpenAPI document into an extension operation table`.

### Task 3: Generate the extension

**Files:** Create `packages/cli/src/commands/scaffold-openapi/generate.ts`, `templates.ts` (+ `.test.ts`); Modify `packages/cli/src/commands/scaffold.ts` (`ScaffoldArgs`' extension arm gains `fromOpenApi?: string; maxOperations?: number`; `parseExtensionArgs` (tested through the exported `parseScaffoldArgs`) accepts `--from-openapi <src>` and `--max-operations <n>` in any order with `--publisher`, and `--max-operations` only with `--from-openapi`; `runScaffold` becomes `async` (`index.ts` already awaits every handler, so it needs no change); the existing scaffold output is byte-identical when the flag is absent).

**Interfaces:**
- Consumes: Tasks 1–2; `buildExtensionScaffoldFiles`, `resolveExtensionId`, `deriveExtensionServiceId`, `parseExtensionManifestForRegistry`.
- Produces: `buildOpenApiScaffoldFiles(name: string, publisher: string | undefined, platform: NodeJS.Platform, absDir: string, model: OperationModel): readonly ScaffoldFile[]` (passes `platform`/`absDir` to `buildExtensionScaffoldFiles`) — the plain scaffold's files with these replaced/added: `nimbus.extension.json` (`permissions.network` = `model.hosts`, `credentials` = `model.credentials` when non-empty), `src/operations.json` (`{ hosts, operations }` via `JSON.stringify(…, undefined, 2)`), `src/request.ts` (fixed template; exports `buildRequest(op, args, env): { url: string; init: RequestInit }` and `callOperation(op, args, deps: { fetch; env }): Promise<string>`), `src/tools.ts` (fixed template using the SDK's LOW-LEVEL `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema` handlers, so each tool's raw JSON `inputSchema` from the table is served as is — the high-level `McpServer.registerTool` takes zod shapes; the server is constructed with `{ capabilities: { tools: {} } }`; `createServer(deps?: { fetch?: typeof fetch; env?: Record<string, string | undefined> })` so tests inject both; the call handler finds the tool with `Object.hasOwn` on a null-prototype map built from the table and calls `callOperation`, returning an MCP error for an unknown tool, including `toString` and `__proto__`), `src/tools.test.ts` (fixed template: offline tests over the table with an injected fetch), `README.md` (generated operations, skipped ones and reasons, cut names, credentials to set with `nimbus extension credential set`, unsupported schemes, non-JSON bodies, next steps incl. `nimbus eval --record`). The generated manifest is parsed with `parseExtensionManifestForRegistry` before anything is written; a failure is a bug and throws.
- Output after writing: `Scaffolded extension at ./<name>/ from <n> operation(s) — next: cd <name> && bun install && bun test && bun run build`, then one line per warning, skipped operation and cut name.

- [ ] **Step 1: Failing tests:**
  - generating from the fixture: the manifest parses and has the expected network and credentials; `operations.json` equals the model; `request.ts`, `tools.ts`, `tools.test.ts` equal their templates (Review Focus 1, with a fixture whose strings carry backticks, `${`, `*/`, quotes and newlines);
  - the generated `src/request.ts` imported from the temp dir and driven with an injected fetch: path params encoded, query and header placement, bearer/basic/apiKey credential placement from an injected env, a missing required parameter refused before fetch, a URL to an undeclared host refused, `redirect: "manual"` in the init, a 3xx returns status and Location, a 70,000-character body truncated with the marker;
  - `parseExtensionArgs` accepts the flags in any order, refuses a repeated flag, a missing value and a non-positive `--max-operations`;
  - the plain scaffold's files are byte-identical with and without this change (snapshot against `buildExtensionScaffoldFiles` output for a fixed name).
- [ ] **Step 2–4:** run, implement, run; then `bun test packages/cli/src/commands/scaffold.test.ts`.
- [ ] **Step 5:** complexity lint; `bunx tsc -p packages/cli --noEmit`; `typecheck:tests`.
- [ ] **Step 6: Commit** `feat(cli): nimbus scaffold extension --from-openapi`.

### Task 4: Docs, roadmap and gates

**Files:** `docs/cli-reference.md` (the `nimbus scaffold` section: `--from-openapi`, `--max-operations`, every rule above that an author meets, the CLI-side unledgered fetch and no air-gap check, the data-not-code table, `redirect: "manual"`); `docs/contributors/extension-author-walkthrough.md` (a short "Start from an OpenAPI document" subsection); `docs/roadmap.md` (the `--from-openapi` row ticked and rewritten as `nimbus scaffold extension --from-openapi`, no sync handler, AsyncAPI dropped with the reason; project 7 status lines PR 3 of 4); `docs/CHANGELOG.md`; `CLAUDE.md`/`GEMINI.md` status sentence identically; `.claude/commands/nimbus-sandbox-and-extensions.md` one line.

- [ ] **Step 1:** Write the docs; every flag and message must match Tasks 1–3.
- [ ] **Step 2: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast`, `bun run typecheck:tests` — PASS.
- [ ] **Step 3: Commit** `docs: scaffold an extension from an OpenAPI document`.
