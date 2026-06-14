# True Coverage D2 — Heavy/Borderline Exclusion Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tasks are SERIAL** — Tasks 1, 3, 4, 5 all edit the single shared file `scripts/coverage-floor/exclusions.ts`; never run two implementers concurrently.

**Goal:** Honest-shrink the heavy/borderline coverage exclusions — un-exclude `imap-client.ts` (tests already exist) and `team.ts` (via two extractions + tests), document `start.ts`, and reclassify `ipc/server/options.ts` as type-only — while keeping `coverage-baseline.json` `files` at `{}`.

**Architecture:** Two un-excludes rejoin the ≥80% line+branch floor. `imap-client.ts` already has a DI seam + a full test; we just drop the exclusion. `team.ts` gets two pure extractions behind the unchanged public `runTeam(argv)` — `runTeamFederationRpc(client, cmd)` (the federation switch) and `handleConsentNotification(client, params, prompt)` (the consent-listener body) — tested against an injected fake `TeamRpcClient`, mirroring the existing `team-vault.test.ts` exemplar. `start.ts` and `options.ts` stay excluded with corrected rationale.

**Tech Stack:** Bun v1.2+ test runner, TypeScript 6.x strict (no `any`), Biome, the istanbul-under-`bun test` coverage gate (`scripts/coverage-floor/*`), Docker (`oven/bun:latest`) for the Linux-authoritative dry-run.

**Spec:** [`docs/superpowers/specs/2026-06-14-true-coverage-D2-shrink-exclusions-design.md`](../specs/2026-06-14-true-coverage-D2-shrink-exclusions-design.md)

---

## Pre-flight context (read once before Task 1)

- **Worktree:** `.claude/worktrees/tc-D2`, branch `dev/asafgolombek/true-coverage-D2` (off `origin/main` `1ca2e77e`, includes D1 #607). Already `bun install`'d + `packages/client` dist built.
- **Validate biome in-worktree** with `bunx biome check <files>` (the bare `bun run lint` false-fails under `!**/.claude`).
- **No `mock.module`** anywhere — DI only (cli combined run is process-global).
- **No `any`** (use `unknown`), **no `biome-ignore`**, **no `istanbul-ignore`**.
- The flagship `targets` overlay (`executor.ts`, `tool-output-envelope.ts` @100/100) is untouched.

---

## Task 1: Un-exclude `imap-client.ts` (verify-only — tests already exist)

The file already carries the `ImapClientLike` interface + injectable `ImapClientFactory` seam, and
`imap-client.test.ts` already covers every pure helper + `fetchImapMessages` (success / empty /
unselectable / connect-fail / fetch-throw+logout) + the real `defaultImapClientFactory`. We only
remove the stale exclusion. It is **not** in `sonar.coverage.exclusions` (verified) → no Sonar edit.

**Files:**

- Modify: `scripts/coverage-floor/exclusions.ts` (remove the imap-client comment + entry)
- Reference (no change): `packages/gateway/src/connectors/_lib/imap-client.ts`, `…/imap-client.test.ts`

- [ ] **Step 1: Confirm the existing test passes and the file is well-covered**

Run: `cd packages/gateway && bun test src/connectors/_lib/imap-client.test.ts`
Expected: PASS (all `describe` blocks green — capPreview / addresses / findTextPlainPart /
extractAttachments / previewFromParts / toInput / fetchImapMessages).

- [ ] **Step 2: Remove the exclusion entry**

In `scripts/coverage-floor/exclusions.ts`, delete these six lines (the comment block + the entry):

```ts
  // The gateway-side IMAP fetcher is a thin imapflow socket adapter (constructs
  // `new ImapFlow(...)` and opens a real TLS connection) with no injection seam —
  // the same untestable I/O shell as a connector `server.ts`. The testable logic
  // (mapping, cursor, transient-failure handling) lives in `imap-sync.ts` +
  // `imap-email-mapping.ts`, which ARE covered.
  { kind: "exact", path: "packages/gateway/src/connectors/_lib/imap-client.ts" },
```

- [ ] **Step 3: Verify the exclusion-parity audit still passes**

The directional parity check asserts every Sonar exclusion has a local-registry counterpart.
Removing an entry that is **only** in the local registry (not Sonar) must keep parity green.

Run: `bun run audit:exclusion-parity`
Expected: PASS (no "missing counterpart" error; imap-client was local-only).

- [ ] **Step 4: Verify exclusions.ts still compiles + lints**

Run: `bunx tsc --noEmit -p scripts/tsconfig.json 2>&1 | head -5 || cd . && bunx biome check scripts/coverage-floor/exclusions.ts`
Expected: no errors on `exclusions.ts`.

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts
git commit -m "test(true-coverage): D2 un-exclude imap-client.ts (tests already cover it)"
```

---

## Task 2: Extract `runTeamFederationRpc` + `handleConsentNotification` from `team.ts` (TDD)

Two pure extractions behind the unchanged `runTeam(argv)`. The federation `switch` and the
consent-listener callback body move to exported, injectable helpers; `runTeam` + `runConsentListener`
become thin shells. `respondToConsent` widens from `IPCClient` to `TeamRpcClient` (it only uses
`.call`). `renderAuditTable` is exported for direct pure testing. **Zero behavior change.**

**Files:**

- Modify: `packages/cli/src/commands/team.ts`
- Create: `packages/cli/src/commands/team-federation.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/cli/src/commands/team-federation.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";

import {
  type ConfirmPrompt,
  handleConsentNotification,
  renderAuditTable,
  runTeamFederationRpc,
  type TeamRpcClient,
} from "./team.ts";

function fakeClient(result: unknown = { ok: true }): {
  client: TeamRpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: TeamRpcClient = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return result as never;
    },
  };
  return { client, calls };
}

function throwingClient(): TeamRpcClient {
  return {
    call: async () => {
      throw new Error("rpc down");
    },
  };
}

// respondToConsent (consent case) + the consent-error arm set process.exitCode; reset per the
// bun-test-exit-code-leak lesson (explicitly = 0, never restore undefined).
afterEach(() => {
  process.exitCode = 0;
});

describe("runTeamFederationRpc", () => {
  it("discover calls federation.discover", async () => {
    const { client, calls } = fakeClient({ peers: [] });
    await runTeamFederationRpc(client, { kind: "discover" });
    expect(calls[0]).toEqual({ method: "federation.discover", params: {} });
  });

  it("namespacePublish calls federation.namespace.publish with name+filters", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "namespacePublish",
      name: "project:zurich",
      filters: [{ kind: "type", value: "issue" }],
    });
    expect(calls[0]).toEqual({
      method: "federation.namespace.publish",
      params: { name: "project:zurich", filters: [{ kind: "type", value: "issue" }] },
    });
  });

  it("namespaceGrant maps standing → standingConsent", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "namespaceGrant",
      namespace: "ns",
      peerId: "peer:abc",
      role: "viewer",
      standing: true,
    });
    expect(calls[0]).toEqual({
      method: "federation.namespace.grant",
      params: { namespace: "ns", peerId: "peer:abc", role: "viewer", standingConsent: true },
    });
  });

  it("namespaceRevoke calls federation.namespace.revoke", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, { kind: "namespaceRevoke", namespace: "ns", peerId: "peer:abc" });
    expect(calls[0]).toEqual({
      method: "federation.namespace.revoke",
      params: { namespace: "ns", peerId: "peer:abc" },
    });
  });

  it("query calls federation.ask", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "query",
      namespace: "ns",
      peerId: "peer:abc",
      purpose: "find auth bugs",
    });
    expect(calls[0]).toEqual({
      method: "federation.ask",
      params: { peerId: "peer:abc", namespace: "ns", purpose: "find auth bugs" },
    });
  });

  it("whoKnows calls federation.askExpertise with who-knows purpose", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, { kind: "whoKnows", peerId: "peer:abc", query: "kafka tuning" });
    expect(calls[0]).toEqual({
      method: "federation.askExpertise",
      params: { peerId: "peer:abc", query: "kafka tuning", purpose: "who-knows" },
    });
  });

  it("pair calls federation.pair", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, { kind: "pair", host: "h.test", code: "CODE" });
    expect(calls[0]).toEqual({ method: "federation.pair", params: { host: "h.test", code: "CODE" } });
  });

  it("consent (matched) submits federation.consentRespond and leaves exitCode 0", async () => {
    const { client, calls } = fakeClient({ matched: true });
    await runTeamFederationRpc(client, { kind: "consent", requestId: "r1", approved: true });
    expect(calls[0]).toEqual({
      method: "federation.consentRespond",
      params: { requestId: "r1", approved: true },
    });
    expect(process.exitCode).not.toBe(1);
  });

  it("consent (unmatched) sets exitCode 1", async () => {
    const { client } = fakeClient({ matched: false });
    await runTeamFederationRpc(client, { kind: "consent", requestId: "r1", approved: false });
    expect(process.exitCode).toBe(1);
  });

  it("consent (rpc error) sets exitCode 1", async () => {
    await runTeamFederationRpc(throwingClient(), { kind: "consent", requestId: "r1", approved: true });
    expect(process.exitCode).toBe(1);
  });

  it("audit (rows) calls team.auditMerged", async () => {
    const { client, calls } = fakeClient({ entries: [{ peerId: "p", timestamp: 1735790645000 }] });
    await runTeamFederationRpc(client, { kind: "audit", namespace: "ns", purpose: "why", sinceMs: 0 });
    expect(calls[0]).toEqual({
      method: "team.auditMerged",
      params: { namespace: "ns", purpose: "why", sinceMs: 0 },
    });
  });

  it("audit (no entries array) takes the empty branch without throwing", async () => {
    const { client } = fakeClient({}); // r.entries undefined → Array.isArray false → []
    await runTeamFederationRpc(client, { kind: "audit", namespace: "ns", purpose: "why", sinceMs: 5 });
    // no throw == pass
  });
});

describe("renderAuditTable / cellText", () => {
  it("renders only a header for an empty timeline", () => {
    const out = renderAuditTable([]);
    expect(out).toContain("TIMESTAMP");
    expect(out).toContain("HASH");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("formats numeric timestamps as ISO, coerces primitives, blanks objects, truncates hash", () => {
    const out = renderAuditTable([
      {
        timestamp: 1735790645000,
        peerId: "peer:abc",
        actionType: "github.issue.create",
        hitlStatus: "approved",
        hash: "abcdef1234567890",
      },
      // Untyped JSON: exercise cellText's number/boolean arms and the object→"" else-arm.
      { timestamp: "n/a", peerId: 7, actionType: true, hitlStatus: { x: 1 }, hash: undefined },
    ]);
    expect(out).toContain(new Date(1735790645000).toISOString());
    expect(out).toContain("peer:abc");
    expect(out).toContain("github.issue.create");
    expect(out).toContain("abcdef123456"); // 12-char hash slice
    expect(out).toContain("n/a");
    expect(out).toContain("true"); // boolean coerced
  });
});

describe("handleConsentNotification", () => {
  const approve: ConfirmPrompt = async () => true;
  const deny: ConfirmPrompt = async () => false;
  const notCancelled = (_v: unknown): boolean => false;
  // clack's real isCancel only matches its module-private CANCEL_SYMBOL (verified: it returns false
  // for Symbol.for/Symbol), so the cancel branch is reachable ONLY by injecting the predicate.
  const CANCEL = Symbol("test-cancel");
  const cancelPrompt: ConfirmPrompt = async () => CANCEL;
  const isCancelled = (v: unknown): boolean => v === CANCEL;

  it("approve → consentRespond(approved:true)", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(
      client,
      { requestId: "r1", peerId: "p", namespace: "ns", purpose: "why" },
      approve,
      notCancelled,
    );
    expect(calls[0]).toEqual({
      method: "federation.consentRespond",
      params: { requestId: "r1", approved: true },
    });
  });

  it("deny → consentRespond(approved:false)", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(client, { requestId: "r1" }, deny, notCancelled);
    expect(calls[0]).toEqual({
      method: "federation.consentRespond",
      params: { requestId: "r1", approved: false },
    });
  });

  it("cancel → no consentRespond call (left to time out)", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(client, { requestId: "r1" }, cancelPrompt, isCancelled);
    expect(calls).toHaveLength(0);
  });

  it("non-string requestId → no call", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(client, { requestId: 123 }, approve, notCancelled);
    expect(calls).toHaveLength(0);
  });

  it("swallows an rpc error and writes it to stderr (no throw)", async () => {
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        handleConsentNotification(throwingClient(), { requestId: "r1" }, approve, notCancelled),
      ).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }
    expect(captured).toContain("Error sending consent decision");
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS (symbols not yet exported)**

Run: `cd packages/cli && bun test src/commands/team-federation.test.ts`
Expected: FAIL — import/resolve error (`runTeamFederationRpc` / `handleConsentNotification` /
`ConfirmPrompt` not exported from `./team.ts`).

- [ ] **Step 3: Add the `ConfirmPrompt` type**

In `packages/cli/src/commands/team.ts`, add directly under the `TeamRpcClient` interface (after its
closing `}` near line 45):

```ts
/** The `confirm`-shaped prompt the consent listener uses, injected so the decision logic is unit-testable. */
export type ConfirmPrompt = (opts: { message: string }) => Promise<boolean | symbol>;
```

- [ ] **Step 4: Widen `respondToConsent` to `TeamRpcClient`**

Change its signature only (body unchanged) — it uses `client.call` exclusively:

```ts
async function respondToConsent(
  client: TeamRpcClient,
  requestId: string,
  approved: boolean,
): Promise<void> {
```

- [ ] **Step 5: Export `renderAuditTable`**

Change `function renderAuditTable(` to `export function renderAuditTable(` (signature otherwise
unchanged). Leave `cellText` module-private (covered transitively through `renderAuditTable`).

- [ ] **Step 6: Extract `handleConsentNotification` and shrink `runConsentListener`**

Replace the entire existing `runConsentListener` function with these two functions (the handler is
the former inner `void (async () => {…})()` body, now taking an injected `prompt` + `isCancelled`
predicate so every branch — incl. cancel — is unit-coverable without `mock.module`):

```ts
/**
 * Handles a single `federation.consentRequest` notification: prompt the operator and submit the
 * decision. Extracted from {@link runConsentListener} (which keeps only the notification
 * registration + the run-until-interrupted wait) so the decision logic is unit-testable with an
 * injected `prompt`. The real listener passes clack's `confirm`.
 */
export async function handleConsentNotification(
  client: TeamRpcClient,
  params: unknown,
  prompt: ConfirmPrompt,
  isCancelled: (value: unknown) => boolean,
): Promise<void> {
  const p = params as {
    requestId?: string;
    peerId?: string;
    namespace?: string;
    purpose?: string;
  };
  if (typeof p.requestId !== "string") return;
  const ok = await prompt({
    message: `Peer ${p.peerId ?? "?"} requests namespace "${p.namespace ?? "?"}" (purpose: ${p.purpose ?? "?"}). Approve?`,
  });
  if (isCancelled(ok)) {
    // Esc/cancel: do NOT submit a deny — leave the query to time out on the answerer.
    process.stdout.write(`consent prompt cancelled for ${p.requestId}; leaving it to time out.\n`);
    return;
  }
  try {
    await client.call("federation.consentRespond", {
      requestId: p.requestId,
      approved: ok === true,
    });
  } catch (e) {
    process.stderr.write(
      `Error sending consent decision: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

async function runConsentListener(client: IPCClient): Promise<void> {
  process.stdout.write("Listening for federation consent requests. Press Ctrl-C to stop.\n");
  client.onNotification("federation.consentRequest", (params: unknown) => {
    // Bind the real clack `confirm` + `isCancel` here (the single, untestable shell call site); the
    // extracted handler stays DI-only so all its branches — incl. cancel — are unit-coverable.
    void handleConsentNotification(client, params, confirm, isCancel);
  });
  await new Promise<void>(() => {}); // run until interrupted (Ctrl-C)
}
```

- [ ] **Step 7: Extract `runTeamFederationRpc`**

Add this function immediately **before** `runTeam` (it contains the former `runTeam` `switch` cases,
minus `listen`):

```ts
/**
 * Executes the federation subcommands — everything except the team-vault subset handled by
 * {@link runTeamVaultRpc} and the long-lived `listen` loop — over an injected IPC client. Exported
 * so tests can drive each branch with a fake client without a live gateway.
 */
export async function runTeamFederationRpc(client: TeamRpcClient, cmd: TeamCommand): Promise<void> {
  switch (cmd.kind) {
    case "discover": {
      const r = await client.call<{ peers: unknown[] }>("federation.discover", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "namespacePublish": {
      const r = await client.call<unknown>("federation.namespace.publish", {
        name: cmd.name,
        filters: cmd.filters,
      });
      process.stdout.write(`Published ${cmd.name}\n${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "namespaceGrant": {
      await client.call<unknown>("federation.namespace.grant", {
        namespace: cmd.namespace,
        peerId: cmd.peerId,
        role: cmd.role,
        standingConsent: cmd.standing,
      });
      process.stdout.write(`Granted ${cmd.role} on ${cmd.namespace} to ${cmd.peerId}\n`);
      break;
    }
    case "namespaceRevoke": {
      await client.call<unknown>("federation.namespace.revoke", {
        namespace: cmd.namespace,
        peerId: cmd.peerId,
      });
      process.stdout.write(`Revoked ${cmd.peerId} from ${cmd.namespace}\n`);
      break;
    }
    case "query": {
      const r = await client.call<unknown>("federation.ask", {
        peerId: cmd.peerId,
        namespace: cmd.namespace,
        purpose: cmd.purpose,
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "whoKnows": {
      const r = await client.call<unknown>("federation.askExpertise", {
        peerId: cmd.peerId,
        query: cmd.query,
        purpose: "who-knows",
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "pair": {
      const r = await client.call<unknown>("federation.pair", {
        host: cmd.host,
        code: cmd.code,
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "consent":
      await respondToConsent(client, cmd.requestId, cmd.approved);
      break;
    case "audit": {
      const r = await client.call<{ entries: MergedAuditRow[] }>("team.auditMerged", {
        namespace: cmd.namespace,
        purpose: cmd.purpose,
        sinceMs: cmd.sinceMs,
      });
      const entries = Array.isArray(r.entries) ? r.entries : [];
      if (entries.length === 0) {
        process.stdout.write("No federation-audit entries across the team.\n");
      } else {
        process.stdout.write(`${renderAuditTable(entries)}\n`);
      }
      break;
    }
  }
}
```

- [ ] **Step 8: Rewire `runTeam` to delegate**

In `runTeam`, replace the whole `try { … } finally { … }` block (from `try {` through the
`} finally {` disconnect) with this thin dispatcher:

```ts
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    // Slice-2 team-vault / invoke / delegation subcommands first; fall through to federation below.
    if (await runTeamVaultRpc(client, cmd)) {
      return;
    }
    if (cmd.kind === "listen") {
      await runConsentListener(client);
      return;
    }
    await runTeamFederationRpc(client, cmd);
  } finally {
    await client.disconnect().catch(() => {});
  }
```

- [ ] **Step 9: Run the test to verify it PASSES**

Run: `cd packages/cli && bun test src/commands/team-federation.test.ts`
Expected: PASS (all `runTeamFederationRpc` / `renderAuditTable` / `handleConsentNotification`
blocks green — incl. the cancel branch, reached via the injected `isCancelled` predicate, so the
extracted function hits 100% branch).

- [ ] **Step 10: Run the full team test surface (no regressions)**

Run: `cd packages/cli && bun test src/commands/team.test.ts src/commands/team-vault.test.ts src/commands/team-federation.test.ts`
Expected: PASS (parse + vault + federation all green — the extraction is behavior-preserving).

- [ ] **Step 11: Typecheck + lint the changed file**

Run: `cd packages/cli && bunx tsc --noEmit 2>&1 | grep -E "team\.ts|team-federation" | head -5 ; cd ../.. && bunx biome check packages/cli/src/commands/team.ts packages/cli/src/commands/team-federation.test.ts`
Expected: no errors. (`confirm` must be assignable to `ConfirmPrompt`; `IPCClient` to `TeamRpcClient`
— both already proven by the existing `runTeamVaultRpc(client, cmd)` call site.)

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team-federation.test.ts
git commit -m "refactor(true-coverage): extract runTeamFederationRpc + handleConsentNotification from team.ts"
```

---

## Task 3: Un-exclude `team.ts` (gate + Sonar)

Now that `team.ts` clears the floor, drop it from **both** registries. The Sonar comment block covers
team.ts **and** assemble.ts together — edit it to drop only the team.ts clause.

**Files:**

- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `sonar-project.properties`

- [ ] **Step 1: Remove the `team.ts` entry from `exclusions.ts`**

Delete these three lines:

```ts
  // `team.ts` runTeam is a CLI IPC command shell (no injection seam); the testable
  // parseTeamArgs is covered by team.test.ts. Same exemption class as start/repl/doctor.
  { kind: "exact", path: "packages/cli/src/commands/team.ts" },
```

- [ ] **Step 2: Remove `team.ts` from the Sonar exclusions list**

In `sonar-project.properties`, in the long `sonar.coverage.exclusions=` line, delete the substring
`,packages/cli/src/commands/team.ts` (the comma-prefixed token; leave the surrounding tokens —
`…/doctor.ts` immediately before and `…/platform/assemble.ts` immediately after — intact).

- [ ] **Step 3: Edit the Sonar comment block to drop the team.ts clause**

Replace this comment paragraph:

```properties
# `cli/src/commands/team.ts` (CLI IPC command shell — no injection seam; the
# testable `parseTeamArgs` is covered by `team.test.ts`) and
# `gateway/src/platform/assemble.ts` (boot-assembly I/O orchestrator; the
# federation glue block is inert unless `[federation].enabled` and needs a full
# subprocess boot to exercise) were already exempt in the local registry above;
# listing them here keeps Sonar new-code coverage aligned with that decision.
```

with (team.ts removed; assemble.ts kept, grammar de-pluralized):

```properties
# `gateway/src/platform/assemble.ts` (boot-assembly I/O orchestrator; the
# federation glue block is inert unless `[federation].enabled` and needs a full
# subprocess boot to exercise) was already exempt in the local registry above;
# listing it here keeps Sonar new-code coverage aligned with that decision.
```

- [ ] **Step 4: Verify exclusion-parity (both registries now agree)**

Run: `bun run audit:exclusion-parity`
Expected: PASS — `team.ts` is gone from both the Sonar list and the local registry, so parity holds.

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts sonar-project.properties
git commit -m "test(true-coverage): D2 un-exclude team.ts from gate + sonar"
```

---

## Task 4: Document `start.ts` (add rationale comment)

`start.ts` stays excluded (irreducible subprocess/socket/timer glue). It is currently a bare entry
with no comment — give it a rationale matching `team`/`policy`/`admin`/`chatops`.

**Files:**

- Modify: `scripts/coverage-floor/exclusions.ts`

- [ ] **Step 1: Add the rationale comment above the `start.ts` entry**

Replace the bare line:

```ts
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
```

with:

```ts
  // `start.ts`: the testable pure helpers (`decideStartAction`, `wantsNoWizard`) are exported +
  // unit-tested by `start.test.ts`; the residual is irreducible subprocess/socket/timer boot glue
  // (`spawnGateway`, the IPC ready-poll race, the TTY onboarding loop) with no injection seam —
  // same untestable I/O-shell class as a connector `server.ts`. (`decideStartAction` is also
  // currently dead — inlined by `handleExistingGatewayState`; a surgical fast-follow can remove it.)
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
```

- [ ] **Step 2: Verify exclusions.ts compiles**

Run: `bunx biome check scripts/coverage-floor/exclusions.ts`
Expected: no errors (comment-only change).

- [ ] **Step 3: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts
git commit -m "docs(true-coverage): D2 document start.ts exclusion rationale"
```

---

## Task 5: Reclassify `ipc/server/options.ts` as type-only

`options.ts` is pure `export type` (zero executable lines, no `SF:` record) — bucket (b) type-only,
not a boot shell. Move its `exclusions.ts` entry next to the type-only cluster with the correct
rationale. It stays in `sonar.coverage.exclusions` (Sonar also reads it as uncoverable) — no Sonar
edit.

**Files:**

- Modify: `scripts/coverage-floor/exclusions.ts`

- [ ] **Step 1: Remove the entry from its current (boot-shell-adjacent) location**

Delete this line (it currently sits next to `lazy-mesh/slot.ts` / `assemble.ts`):

```ts
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
```

- [ ] **Step 2: Re-add it under the type-only cluster with rationale**

Immediately **after** the existing `transport.ts` type-only block (the entry
`{ kind: "exact", path: "packages/gateway/src/chatops/transport/transport.ts" },`), insert:

```ts
  // `ipc/server/options.ts` is a types-only module (`CreateIpcServerOptions` + `BunSessionData`
  // over `import type` lines, zero executable statements) — lcov emits no SF: record, so the gate
  // reads it as 0%. Same type-only class as the `types.ts` basenameRegex and `transport.ts`.
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
```

- [ ] **Step 3: Verify exclusion-parity + lint (entry moved, not removed → still present in both)**

Run: `bun run audit:exclusion-parity && bunx biome check scripts/coverage-floor/exclusions.ts`
Expected: PASS (the path still exists in the local registry and in Sonar — only its location +
comment changed).

- [ ] **Step 4: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts
git commit -m "docs(true-coverage): D2 reclassify ipc/server/options.ts as type-only"
```

---

## Task 6: Local Docker dry-run — confirm both un-excludes clear 80 and `files` stays `{}`

The Linux-authoritative pre-push check. `reseed-docker.sh` runs the full instrumented suite in
`oven/bun:latest` and regenerates the baseline; we inspect (do **not** commit) the result.

**Files:**

- Reference only: `scripts/coverage-floor/reseed-docker.sh`, `coverage-baseline.json`

- [ ] **Step 1: Capture the current baseline for comparison**

Run: `git show HEAD:coverage-baseline.json > /tmp/d2-baseline-before.json && grep -c '"' coverage-baseline.json`
Expected: `files` is `{}` on the branch (D1 left it empty); note the `targets` overlay lines.

- [ ] **Step 2: Run the Docker dry-run reseed**

Run: `bash scripts/coverage-floor/reseed-docker.sh`
Expected: the instrumented suite runs in-container end-to-end (CI=true; dbus/keyring shim);
finishes with a `coverage-floor: ok (… baselined; … scanned)` line. Takes several minutes.

- [ ] **Step 3: Confirm the two un-excluded files are NOT in the regenerated baseline `files`**

Run: `grep -E "imap-client|commands/team\.ts" coverage-baseline.json || echo "ABSENT — both cleared the floor"`
Expected: `ABSENT — both cleared the floor`. If **either** appears in `files`, it landed <80 — that
is a failed honest-shrink call: STOP, restore that file's exclusion, and reclassify it as documented
(do **not** baseline it). (Re-run the relevant gateway/cli test to see the actual %.)

- [ ] **Step 4: Confirm the flagship targets + empty files survived**

Run: `grep -E "executor\.ts|tool-output-envelope" coverage-baseline.json && node -e "const b=require('./coverage-baseline.json'); console.log('files keys:', Object.keys(b.files).length)"`
Expected: both `targets` present at 100/100; `files keys: 0`.

- [ ] **Step 5: Discard the Docker-regenerated baseline (authoritative reseed comes from CI in Task 7)**

Run: `git checkout coverage-baseline.json`
Expected: working tree clean for `coverage-baseline.json` (the committed `files:{}` baseline stands;
CI's merge-lcov is the authoritative reseed source — Task 7).

- [ ] **Step 6: No commit** (verification-only task; nothing to commit if Step 5 left the tree clean).

---

## Task 7: Preflight, push, open PR, reseed from the PR's own merge lcov

**Files:**

- Possibly modify: `coverage-baseline.json` (only if CI's merge lcov differs from `files:{}` — see Step 5)

- [ ] **Step 1: Full local preflight (CI parity)**

Run: `bun run preflight`
Expected: all gates green locally (typecheck across packages, biome, tests, audits incl.
`exclusion-parity` + `coverage-floor`). Fix any red before pushing (ship-readiness: no push-and-see).

- [ ] **Step 2: Push the branch and open the PR**

```bash
git push -u origin dev/asafgolombek/true-coverage-D2
gh pr create --title "True Coverage D2: un-exclude imap-client + team.ts; document start.ts; reclassify options.ts (type-only)" \
  --body "Sub-project D2 of the True Coverage program. Honest-shrink of the heavy/borderline exclusions:
- imap-client.ts: un-excluded (DI seam + comprehensive tests already existed).
- team.ts: un-excluded via two extractions (runTeamFederationRpc + handleConsentNotification) + team-federation.test.ts.
- start.ts: documented (irreducible subprocess/socket/timer glue).
- ipc/server/options.ts: reclassified type-only (zero-SF), regrouped.

Baseline files stays {}. Spec: docs/superpowers/specs/2026-06-14-true-coverage-D2-shrink-exclusions-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Wait for the authoritative gate**

Watch: `gh pr checks --watch`
Authoritative = **"PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage"**. The windows-2025
cross-platform red is the chronic flake → rerun it, don't debug it.

- [ ] **Step 4: Confirm the coverage-floor gate passed against `files:{}`**

In the `Unit + Coverage` job log, expect `coverage-floor: ok (… baselined; … scanned)` with **no**
`below_floor` / `must_raise` for `imap-client.ts` or `team.ts`. If the gate is green against the
committed `files:{}` baseline, **no reseed is needed** (this is the expected outcome — both files
clear with headroom, like D1).

- [ ] **Step 5: Reseed ONLY if the gate flags drift (from the PR's own merge lcov)**

If (and only if) CI shows a coverage-floor violation, reseed from the PR's own merge artifact — never
Docker/main:

```bash
gh run download <pr-run-id> -n coverage-lcov-merged
cp lcov.info coverage/lcov.info   # adjust to the downloaded path
bun run audit:coverage-floor:update-baseline
```

Then `git diff coverage-baseline.json`: KEEP only watermark changes for files **this PR touched**
(imap-client/team.ts/their incidental siblings); REVERT environmental drift on untouched files
(B7/B9 three-drift-class rule). Verify `targets` (executor/envelope @100) round-tripped untouched and
`files` is still `{}` (un-excluded files that cleared add no entry). Commit + push:
`git commit -am "test(true-coverage): D2 reseed baseline from PR merge lcov"`.

- [ ] **Step 6: Resolve every CodeRabbit + Sonar thread**

Branch protection BLOCKS merge on any unresolved conversation. Fix real issues in code (same
standard for tests); for genuine false-positives, reply with the justification and resolve. Re-run
the chronic windows flake if it's the only red. Leave the squash-merge to the user.

---

## Self-review checklist (run after the plan is written)

- **Spec coverage:** imap-client un-exclude (T1) ✓; team.ts two-extraction un-exclude (T2+T3) ✓;
  start.ts document (T4) ✓; options.ts type-only reclassify (T5) ✓; baseline `files:{}` + flagship
  targets intact (T6, T7.5) ✓; reseed-from-merge-lcov mechanics (T7) ✓; repl/doctor/policy/admin/
  chatops untouched ✓ (no task — correct, spec §2 "no change").
- **Placeholder scan:** none — every code/test block is complete; `<pr-run-id>` in T7.5 is a runtime
  value (the actual CI run id), not a plan placeholder.
- **Type consistency:** `TeamRpcClient` (existing), `ConfirmPrompt` (T2.3), `runTeamFederationRpc`
  (T2.7), `handleConsentNotification(client, params, prompt, isCancelled)` (T2.6), `renderAuditTable`
  exported (T2.5) — all four args + names match between the test (T2.1) and the implementation steps.
- **Invariants:** no new invariant; `team.ts` is a CLI IPC client (federation gates are gateway-side);
  `security-invariants.test.ts` (69/69) + `audit:invariants` stay green (run in T7.1 preflight).

---

## Review dispositions (Antigravity plan review, applied 2026-06-14)

Both points dispositioned; each empirically validated before recording.

- **2.1 Cover the `handleConsentNotification` cancel branch → FIX (via predicate injection) +
  EXPLAIN.** The reviewer's specific fix (mock prompt returns `Symbol.for("clack:cancel")`) **does
  not work** and its test would fail: verified 2026-06-14 that the *real* `isCancel` from
  `@clack/prompts` returns **false** for both `Symbol.for("clack:cancel")` and a fresh `Symbol(...)`
  (clack's `CANCEL_SYMBOL` is a module-private unregistered `Symbol("clack:cancel")`). `cli-mocks.ts`
  only matches it because it **`mock.module`s** `@clack/prompts` wholesale (its own
  `isCancel: (v) => v === Symbol.for("clack:cancel")`, line 48) — and D2 forbids `mock.module`. With
  the real `isCancel`, the reviewer's mock would fall through to a `consentRespond(approved:false)`
  call, so `expect(calls).toHaveLength(0)` fails. **The reviewer's goal (100% branch) is still
  achieved** — by the route they missed: inject the cancel predicate (`isCancelled`) as a required
  4th param (idiomatic, type-safe — the real `isCancel` type-guard is assignable to
  `(value: unknown) => boolean`; runtime-verified). The DI test passes `(v) => v === SENTINEL`; the
  real `runConsentListener` shell binds the real `isCancel`. 100% branch on the extracted function,
  DI-only. (Plan T2 step 1/6/9 + spec §4 updated.)

- **2.2 Suppress stderr noise in the error test → FIX (and strengthen).** The error test now spies
  `process.stderr.write` (capture into a local, **restore in `finally`** for leak-safety per the
  B10/B13 cross-file-global lessons), which both silences the test-run noise **and** asserts the
  error arm's content (`"Error sending consent decision"`) — a stronger test than the original
  resolves-undefined-only check. (Plan T2 step 1 updated.)
