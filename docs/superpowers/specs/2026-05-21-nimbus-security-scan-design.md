# `nimbus security scan` — design spec

**Date:** 2026-05-21
**Phase:** 5 (Extended Surface) — "Security audit follow-ups"
**Status:** Approved
**Acceptance criterion (Phase 5 roadmap):** `nimbus security scan` detects a deliberately introduced test credential in a filesystem root configured at `summary` depth and reports the file path, pattern match type, and connector — verified in `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`.

---

## 1. Purpose

A local, read-only credential-hygiene scan across already-indexed content. The user runs `nimbus security scan`; the Gateway iterates the local index, applies a curated set of high-precision regex patterns against `item.body_preview` (and a small set of high-signal `metadata` JSON values), and reports likely secrets along with where they came from. **No new content is fetched.** **No write operations.** No HITL gate fires.

This fits naturally into the existing `nimbus doctor` / `nimbus diag` diagnostic family — same posture: read-only, JSON output, gives the user actionable information about local state.

## 2. Non-Negotiables (mapped to this feature)

| # | Constraint | How this feature complies |
|---|---|---|
| 1 | **Local-first** | Scans only `item` rows already in the local SQLite index. Zero network. |
| 2 | **HITL is structural** | No write actions — HITL is not invoked. The CLI command is purely read. |
| 3 | **No plaintext credentials** | Findings show `match_redacted` (first-4 + last-4) and a `context_snippet` with the secret middle replaced by `[REDACTED]`. The full secret value never appears in stdout, JSON, logs, audit rows, or any IPC response. |
| 4 | **MCP as connector standard** | Not violated — the scan reads the local index; it does not invoke any connector. |
| 5 | **Platform equality** | Pure TypeScript over Bun SQLite; identical behaviour on Windows / macOS / Linux. |
| 6 | **AGPL-3.0 / MIT** | New gateway + CLI code is AGPL. Hand-curated regex patterns are original-authored under AGPL. Future PR may vendor Gitleaks (MIT) into the gateway — MIT-into-AGPL is fine; the combined work ships under AGPL while preserving the MIT notice. |
| 7 | **No `any`** | All input is parsed through typed schemas before reaching the scanner; the pure scanner operates on `unknown`-narrowed structured types. |

## 3. The Six Decisions

### D1. Pattern source — hand-curate ~25 high-precision patterns

**Decision:** Author a focused set of ~25 high-signal patterns in `packages/gateway/src/security/secret-patterns.ts`. **Do not** vendor the full Gitleaks set yet.

**Rationale:** Precision >> recall for a "first warning" tool. False positives erode trust faster than missed findings — users will mute the command if it cries wolf. The high-signal subset (provider-prefixed keys: `AKIA`, `ghp_`, `xoxb-`, `sk-ant-`, …; PEM private keys; npm/Docker tokens; Stripe `sk_live_`; Twilio `SK…`; GCP service-account JSONs) catches the realistic blast-radius credentials with very low false-positive rates.

**v2:** vendor more from Gitleaks. The structure of `secret-patterns.ts` is shaped so adding patterns is a one-line append.

### D2. Scope of search — stream `item` rows, regex in-process

**Decision:** Stream all eligible `item` rows via `db.prepare(...).iterate()` and apply regexes in TypeScript.

**Rationale:** Total rows ≤ 10⁶, `body_preview` capped at ~512 chars; max in-memory scan window is ~500 MB. FTS5 indexes tokens, not character substrings — it cannot pre-filter regex matches. Streaming keeps peak memory low; regex iteration over `body_preview` is fast enough at this scale (<2 s for 100k rows on a mid-range laptop in informal benchmarks).

### D3. Depth gating — query `sync_state.depth`, scan only `summary`/`full`

**Decision:** Build a per-connector depth map from `SELECT connector_id, depth FROM sync_state`. Include only services where depth is `summary` or `full`. Report skipped services in the response.

**Rationale:** The roadmap is explicit — scan only indexed content; do not invent a code path that fetches more. A connector at `metadata_only` depth has only titles/IDs in `body_preview` (no body bytes), and the user should know that connector wasn't searched. Default depth for unrecorded rows is `summary` (V21 default), so connectors without a `sync_state` row are included.

**Output reporting:** `skipped_connectors: [{ service, depth }]` — the user sees exactly which connectors were skipped.

### D4. Output shape — stable JSON; redacted secret only

```typescript
interface SecurityScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: number;
  readonly findings_count: number;
  readonly findings: readonly SecurityFinding[];
  readonly skipped_connectors: readonly { readonly service: string; readonly depth: "metadata_only" }[];
}

interface SecurityFinding {
  readonly item_id: string;         // `<service>:<external_id>`
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly pattern_name: string;    // e.g. "aws_access_key"
  readonly pattern_category: "api_key" | "private_key" | "token";
  readonly match_redacted: string;  // first-4 + "****" + last-4; 0-char if length < 8
  readonly context_snippet: string; // ±40 chars around the match, secret middle = "[REDACTED]"
  readonly modified_at_ms: number;
  readonly url: string | null;      // item.url (or canonical_url) when present
}
```

The schema is **frozen** for v1 — `nimbus security scan --json` may be parsed by CI scripts. Future fields are additive only.

**Match redaction rule:**
- `length >= 8` → `match.slice(0, 4) + "****" + match.slice(-4)` (e.g. `AKIA****MPLE`)
- `length < 8` → `"****"` (8 stars; no character is shown)

**Context snippet rule:**
- Take ±40 chars around the match offset in `body_preview`.
- Replace the matched bytes with the literal string `"[REDACTED]"`.
- The snippet itself is never long enough to reconstruct the secret.

### D5. Audit log — one summary row, no findings

**Decision:** Write exactly one audit row at end of scan:

```typescript
appendAuditEntry(db, {
  actionType: "security.scan_completed",
  hitlStatus: "not_required",
  actionJson: JSON.stringify({
    scanned_at_ms,
    items_scanned,
    items_skipped_depth,
    findings_count,
    skipped_connectors_count,
  }),
  timestamp: nowMs,
});
```

**Why:** Forensic traceability that the scan ran. **The findings themselves are never recorded** — they are credentials. The audit chain (BLAKE3-tamper-evident) is the wrong place to durably store credential locations.

This mirrors the `deployment.annotated` pattern. `hitlStatus: "not_required"` since the scan is read-only.

### D6. False-positive allowlist — defer to v2

**Decision:** No `[security.allowlist]` knob in v1. Listed as a known future enhancement.

**Rationale:** The mute mechanism is its own design effort (vault-key allowlist? path-glob mute? per-pattern silence?). v1 is "tell me what's there" — v2 is "and silence these three specific known-OK matches". Shipping with no mute encourages users to confront real findings rather than build a long mute list before they understand the false-positive surface.

## 4. Architecture

### 4.1 New files

| File | Role |
|---|---|
| `packages/gateway/src/security/secret-patterns.ts` | `SECRET_PATTERNS: readonly SecretPattern[]` + `redactSecret(raw)` + `buildContextSnippet(body, offset, length)`. Pure module; no DB, no I/O. |
| `packages/gateway/src/security/scan.ts` | `scanItemsForSecrets(rows, patterns, nowMs)` over an iterator of `ScanItem`. Pure function returning `SecurityScanResult`. No DB. No audit. No I/O. |
| `packages/gateway/src/ipc/security-rpc.ts` | `dispatchSecurityRpc("security.scan", params, { db, nowMs })`. Builds the depth-filtered iterator, calls the pure scanner, writes the audit row via `appendAuditEntry`, returns the envelope. Exposes `tryDispatchSecurityRpc(ctx, method, params)` for the dispatcher chain. |
| `packages/cli/src/commands/security.ts` | `runSecurity(args)` — handles `scan` subcommand and `help`. Pretty table by default, `--json` for machine output. Respects `NO_COLOR`. |
| `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` | The Phase 5 acceptance test. Fixed path. |

### 4.2 Modified files

| File | Change |
|---|---|
| `packages/cli/src/commands/index.ts` | Re-export `runSecurity`. |
| `packages/cli/src/index.ts` | Register `security: runSecurity` in `COMMAND_HANDLERS`. |
| `packages/gateway/src/ipc/server/dispatchers.ts` | Add `tryDispatchSecurityRpc` and wire into `tryDispatchPhase4Rpc` chain. |
| `packages/gateway/src/ipc/lan-rpc.ts` | Add `"security"` to `FORBIDDEN_OVER_LAN` (exfiltration-class). |
| `packages/gateway/package.json` (root `package.json`) | Add `test:coverage:security` script. |
| `docs/cli-reference.md` | Document `nimbus security scan`. |
| `docs/roadmap.md` | Flip the row to `[x]`. |
| `CLAUDE.md` + `GEMINI.md` | Append Status-line segment. |
| `.claude/commands/nimbus-file-map.md` | Register new files. |
| `.claude/commands/nimbus-commands.md` | Add coverage-gate line. |

### 4.3 Pure scanner contract

```typescript
// packages/gateway/src/security/scan.ts
export interface ScanItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly body_preview: string | null;
  readonly metadata: string | null;          // JSON string from DB
  readonly modified_at: number;
  readonly url: string | null;
}

export function scanItemsForSecrets(
  rows: Iterable<ScanItem>,
  patterns: readonly SecretPattern[],
  nowMs: number,
): Omit<SecurityScanResult, "skipped_connectors"> & { items_skipped_depth: 0 };
```

- Pure: takes inputs, returns the envelope minus the depth-skipped info (which the dispatcher knows from the depth query).
- No DB, no audit, no I/O. Trivially unit-testable with synthetic rows.
- Returns `items_skipped_depth: 0` from this function — the dispatcher fills the correct value before returning.

### 4.4 IPC handler contract

```typescript
// packages/gateway/src/ipc/security-rpc.ts
export class SecurityRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "SecurityRpcError";
    this.rpcCode = rpcCode;
  }
}

export type SecurityRpcContext = {
  db: Database;
  nowMs?: () => number;
};

export async function dispatchSecurityRpc(
  method: string,
  params: unknown,
  ctx: SecurityRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: SecurityScanResult }>;
```

- `method !== "security.scan"` → `{ kind: "miss" }`.
- `params` is permitted but ignored in v1 (reserved for future `{ services?: string[], categories?: string[] }`).
- Builds the depth map, streams `item` rows, calls `scanItemsForSecrets`, writes the audit row, returns the envelope.

### 4.5 Dispatcher integration

`tryDispatchSecurityRpc` is added to the chain in `tryDispatchPhase4Rpc` between `auditOutcome` and `metricsOutcome`:

```typescript
const securityOutcome = await tryDispatchSecurityRpc(ctx, method, params);
if (securityOutcome !== phase4RpcSkipped) return securityOutcome;
```

### 4.6 Security posture

| Surface | Status |
|---|---|
| CLI | ✅ `nimbus security scan` |
| Local IPC socket | ✅ `security.scan` |
| Tauri renderer (I7) | ❌ NOT in `ALLOWED_METHODS` |
| LAN (I5) | ❌ Added to `FORBIDDEN_OVER_LAN` as namespace `security` |
| HTTP API | ❌ No route registered |

Adding the `"security"` entry to `FORBIDDEN_OVER_LAN` is the I5 enforcement. The Tauri allowlist remains the I7 enforcement (we add nothing to it). Both decisions follow the `index.reembed` precedent: sensitive CLI-only diagnostics are not exposed to the renderer or LAN peers.

### 4.7 What the CLI prints (pretty mode)

```
Nimbus security scan
Scanned 12,345 items across 8 connectors in 1.2s.
Skipped 678 items from connectors at metadata_only depth: gmail.

Findings (3):
  filesystem:src/config.ts        aws_access_key      AKIA****MPLE   2026-05-15
  filesystem:.env                 stripe_secret_key   sk_l****wxyz   2026-05-10
  obsidian:Drafts/onboarding.md   anthropic_api_key   sk-a****1234   2026-05-12

3 findings. Review the locations above and rotate credentials if real.
```

Exit codes:
- `0` always when the scan completes (even with findings) — findings are informational, not a failure.
- `1` only on fatal abort (gateway unreachable, IPC error).

A future CI-friendly `--fail-on-finding` flag is a v2 candidate.

## 5. The Pattern Set (v1 starting list)

Patterns live in `secret-patterns.ts` as `{ name, category, regex, confidence }` records. v1 ships **only prefix-anchored, low-false-positive patterns**. Pure-entropy / sibling-gated patterns (AWS secret key, Twilio auth token, Azure storage key, Heroku UUID) are deferred to v2 — flagging them solo produces a false-positive flood.

The v1 set (21 patterns):

| Name | Category | Regex sketch (final form in code) |
|---|---|---|
| `aws_access_key` | api_key | `\b(?:AKIA\|ASIA)[A-Z0-9]{16}\b` |
| `github_pat_classic` | token | `\bghp_[A-Za-z0-9]{36,}\b` |
| `github_pat_fine_grained` | token | `\bgithub_pat_[A-Za-z0-9_]{82,}\b` |
| `github_oauth` | token | `\bgho_[A-Za-z0-9]{36,}\b` |
| `gitlab_pat` | token | `\bglpat-[A-Za-z0-9\-_]{20,}\b` |
| `slack_bot_token` | token | `\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}\b` |
| `slack_user_token` | token | `\bxoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{32}\b` |
| `openai_api_key` | api_key | `\bsk-[A-Za-z0-9]{20,}\b` (broad — refine to `sk-proj-…` if FPs emerge) |
| `anthropic_api_key` | api_key | `\bsk-ant-[a-z0-9\-]{32,}\b` |
| `stripe_live_secret` | api_key | `\bsk_live_[A-Za-z0-9]{20,}\b` |
| `stripe_test_secret` | api_key | `\bsk_test_[A-Za-z0-9]{20,}\b` |
| `twilio_sid` | api_key | `\bAC[a-f0-9]{32}\b` |
| `google_api_key` | api_key | `\bAIza[A-Za-z0-9\-_]{35}\b` |
| `gcp_service_account_json` | private_key | `"type"\s*:\s*"service_account"` (anchored to JSON shape) |
| `npm_token` | token | `\bnpm_[A-Za-z0-9]{36}\b` |
| `docker_token` | token | `\bdckr_pat_[A-Za-z0-9\-_]{27,}\b` |
| `pem_private_key` | private_key | `-----BEGIN (?:RSA \|EC \|OPENSSH \|DSA \|)PRIVATE KEY-----` |
| `pgp_private_key` | private_key | `-----BEGIN PGP PRIVATE KEY BLOCK-----` |
| `jwt` | token | `\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b` |
| `sendgrid_api_key` | api_key | `\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b` |
| `mailgun_api_key` | api_key | `\bkey-[a-f0-9]{32}\b` |

**Pattern engineering rules:**
- Anchor with `\b` or look-arounds wherever possible. Bare entropy patterns are too noisy.
- Pure-entropy / sibling-gated patterns are explicitly deferred to v2.
- Each pattern has a unit test covering one positive case (using a public test/example value where available — e.g. AWS's documented `AKIAIOSFODNN7EXAMPLE`) and one near-miss negative.
- The regex itself is compiled once at module load and reused across rows (no per-row recompilation).

## 6. Testing Strategy

### 6.1 Layer plan

| Layer | What's tested |
|---|---|
| **Unit** (`secret-patterns.test.ts`) | Each `SECRET_PATTERNS` entry: one positive, one negative. `redactSecret` (length < 8, length = 8, length > 8). `buildContextSnippet` (offset at start/middle/end of body, secret == full body). |
| **Unit** (`scan.test.ts`) | `scanItemsForSecrets`: empty input → empty findings; single row with one match → one finding; single row with two matches at different offsets → two findings (one per match); row with no `body_preview` → skipped silently; row with very long `body_preview` → scanner caps at the body length, doesn't overrun. |
| **Unit** (`security-rpc.test.ts`) | Depth filtering: `metadata_only` rows excluded, `summary` and `full` included; `skipped_connectors` populated correctly; the audit row is written exactly once, with `action_type='security.scan_completed'` and no findings content; method `!== 'security.scan'` returns `{ kind: 'miss' }`. |
| **E2E** (`security-scan.e2e.test.ts`) | **The acceptance test.** See §6.2. |

### 6.2 Acceptance test

`packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`:

```typescript
it("detects a deliberately introduced AWS test credential in a filesystem-summary connector", async () => {
  const gw = await spawnGatewayTestSubprocess();
  try {
    // Seed: filesystem connector at summary depth + one item containing the public AWS test key.
    gw.db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth)
       VALUES (?, ?, ?, ?)`,
      ["filesystem", Date.now(), null, "summary"],
    );
    gw.db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                         modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "filesystem:src/config.ts", "filesystem", "code_symbol", "src/config.ts",
        "config.ts",
        "// public test value documented at https://docs.aws.amazon.com/...\nconst KEY = 'AKIAIOSFODNN7EXAMPLE';",
        null, null, Date.now(), null, "{}", Date.now(), 0,
      ],
    );

    const r = await gw.ipc.call<SecurityScanResult>("security.scan", {});

    expect(r.findings_count).toBe(1);
    const f = r.findings[0]!;
    expect(f.service).toBe("filesystem");
    expect(f.item_id).toBe("filesystem:src/config.ts");
    expect(f.pattern_name).toBe("aws_access_key");
    expect(f.pattern_category).toBe("api_key");
    expect(f.match_redacted).toMatch(/^AKIA\*+MPLE$/);
    // Crucially: the full secret is NOT in the response.
    expect(JSON.stringify(r)).not.toContain("AKIAIOSFODNN7EXAMPLE");

    // And the audit chain has exactly one entry for this scan with no secret in it.
    const audits = gw.db.query(
      `SELECT action_type, action_json FROM audit_log WHERE action_type='security.scan_completed'`
    ).all() as { action_type: string; action_json: string }[];
    expect(audits.length).toBe(1);
    expect(audits[0]!.action_json).not.toContain("AKIAIOSFODNN7EXAMPLE");
  } finally {
    await gw.shutdown();
  }
});
```

### 6.3 Coverage gate

New script `test:coverage:security` in root `package.json`:

```
"test:coverage:security": "bun test --coverage packages/gateway/src/security/ packages/gateway/src/ipc/security-rpc.ts packages/gateway/src/ipc/security-rpc.test.ts packages/gateway/src/security/*.test.ts --coverage-reporter=text --coverage-threshold=80"
```

(Exact form mirrors `test:coverage:deployment` — final form follows whatever the existing scripts pattern dictates.)

Wired into `test:ci`. ≥80% line coverage on `packages/gateway/src/security/` + `packages/gateway/src/ipc/security-rpc.ts`.

## 7. Performance Envelope

Conservative estimate at 100k items × 512-char `body_preview` × 25 patterns:
- Regex evaluations per row: 25 (sequential).
- Per-row cost (estimated, mid-range laptop): <50 µs.
- Total: ~5 s for 100k rows.

The scan is bounded; the user types a command and waits ≤ a few seconds. No progress notifications in v1 — if a scan ever takes > 5s we add periodic progress notifications and the long-running pattern (a la `index.reembed`). Out of scope for v1.

## 8. Future Enhancements (explicitly v2+)

- `[security.allowlist]` mute knob (config file with regex patterns to skip; per-finding hash → mute mapping).
- `--fail-on-finding` flag for CI use.
- Vendoring the full Gitleaks pattern set + a "low confidence" tier.
- A `--service <name>` filter to scope the scan.
- Long-running progress notifications + cancellation if scans grow beyond 5 s.
- Git-blame integration ("when was this secret introduced? — via filesystem connector's commit data").

## 9. Risk Register

| Risk | Mitigation |
|---|---|
| False positives erode trust | Curated high-precision patterns; v1 omits high-entropy bare matches. |
| Findings themselves contain secret bytes | `match_redacted` + `[REDACTED]` snippet design; no full secret in any output path. Acceptance test asserts `JSON.stringify(response).indexOf("AKIAIOSFODNN7EXAMPLE") === -1`. |
| Audit chain holds credentials | Audit row records counts only — never findings. Acceptance test verifies. |
| LAN peer exfiltration | `"security"` namespace in `FORBIDDEN_OVER_LAN` (I5). |
| Renderer XSS reaches scan | Not in Tauri `ALLOWED_METHODS` (I7). |
| Regex DoS (catastrophic backtracking) | Pattern set authored with linear-time regexes only — no nested alternation or unbounded `.*` repetition. Unit tests include a 1 MB random-content row as a worst-case timing check. |
| Scan takes too long → looks hung | Performance envelope in §7; if exceeded in real use, add progress notifications in v2. |

## 10. Naming + Conventions

- **Subsystem:** `security` (new directory under `packages/gateway/src/`).
- **IPC namespace:** `security.*` (currently single method `security.scan`).
- **CLI command:** `nimbus security scan` (subcommand pattern, room to grow — e.g. `nimbus security list-patterns` in v2).
- **Audit action type:** `security.scan_completed`.
- **Coverage gate:** `test:coverage:security`.
- **Vault keys:** None. The scan does not touch the vault.

---

## See Also

- [Phase 5 roadmap row](../../roadmap.md) — "Security audit follow-ups" → `nimbus security scan`.
- [`docs/SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) §I3/I4 (Vault non-leak) — the redaction rule's lineage.
- [`.claude/commands/nimbus-ipc.md`](../../../.claude/commands/nimbus-ipc.md) — the new method follows the standard request/response shape.
- [`.claude/commands/nimbus-architecture.md`](../../../.claude/commands/nimbus-architecture.md) — where new code goes (the table mapping subsystem → directory).
