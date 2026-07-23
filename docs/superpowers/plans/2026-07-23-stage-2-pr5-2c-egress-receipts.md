# Stage 2 PR 5 — 2c: egress receipts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the egress ledger visible at the moment of use: a per-answer ledger-delta footer in the chat participant, a readable self-contained proof artifact for "Prove window", an opt-in signed `Nimbus-Egress-Proof` commit trailer, and blocked rows rendered as first-class proof-of-denial.

**Scope decisions (deliberate):**

- **Footer is participant-only.** The webview chat panel already sits next to the live egress status-bar badge; the participant (the Copilot-side surface) is where an answer can trigger egress with no Nimbus chrome in sight.
- **The proof artifact is an HTML report embedding the machine-verifiable JSON**, with verification instructions pointing at `nimbus egress verify` / `nimbus prove`. True in-file BLAKE3+Ed25519 verification would require embedding crypto implementations — out of scope; the JSON inside stays byte-identical to the RPC result.

**Branch:** `dev/asafgolombek/stage2-pr5-2c-receipts` off main (all egress methods exist since client 0.4.0; main now has 0.11.0 anyway).

## Tasks

### Task 1: Per-answer ledger delta in the participant (TDD)

- `participant-types.ts`: `ParticipantClientLike` += `egressHead(): Promise<{ head: string; count: number }>`.
- `participant.ts` free-form path: `head0 = await client.egressHead()` (try/catch → undefined) before the stream; after the stream completes, `head1`; when both resolved: footer `sink.markdown("\n\n---\n_Egress: N row(s) appended to the local ledger during this answer._")` (0 → "no rows appended — nothing left this machine"). Any head error → no footer, `log.warn`.
- Ops commands (read-only briefs) get the same footer via the shared helper — extract `emitEgressDelta(client, sink, log, head0)`.
- Tests: delta rendered for 2-row growth; zero-delta wording; head failure → silent; fakeClient gains `egressHead`.

### Task 2: Proof artifact as self-contained HTML (TDD)

- `sidebar/egress.ts` `buildProofDocument(result, now)` → `{ filename: "egress-proof-<now>.html", content }`: an HTML page (inline CSS only, no external requests) rendering completeness tier + row count, verify status, receipt (digest/pubkey/sig) when present, a rows table (timestamp ISO, destination.method, result, consent), a "How to verify" section naming `nimbus egress verify` and `nimbus prove`, and the raw JSON in a `<script type="application/json" id="nimbus-egress-proof">` block byte-identical to the RPC result.
- `extension.ts` `proveEgressWindow` flow: pass `sign: true` so the receipt is attached; save dialog default name switches to the `.html` filename.
- Tests: filename/extension; content contains tier, verify ok/failed marker, digest when receipt present, embedded JSON parses back to the input.

### Task 3: `Nimbus-Egress-Proof` commit trailer (TDD)

- New setting `nimbus.scm.egressProofTrailer` (boolean, default false) + README settings row (`check-settings-docs` gates this).
- `scm/commands.ts` `generateCommitMessage`: when the setting is on and the client exposes `egressProveWindow`, call `egressProveWindow({ since: now - 24h, sign: true })`; when `receipt` is present append `\n\nNimbus-Egress-Proof: <digest> sig=<sigB64> pubkey=<pubkeyB64>`; missing receipt or error → no trailer + `log.warn` (never block the commit message).
- Tests: trailer appended when enabled+receipt; absent when disabled; absent+warn on error.

### Task 4: Proof-of-denial rendering (TDD)

- `sidebar/egress.ts` `egressRowToItem`: blocked rows get `label` prefixed `⛔ `, `description` `blocked · <relative-time>`, tooltip gains "proof of denial — stopped before dispatch"; `contextValue: "nimbusEgressDenial"` for future menu wiring.
- Tests: blocked vs authorized rendering.

### Task 5: Full gates, push, PR

Standard gate set incl. `package`+`check-vsix-contents`; whole-branch review; PR to main referencing the spec and the M7/Provable-Locality alignment.
