// Static invariant rules: D21 share consent broker, D24 sync context and index-table confinement, item history, incident records and links.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// D21 (I27) extension: `createShare` — the share-gate chokepoint that runs the owner-HITL approval +
// sign + persist — may be CALLED only from share-gate.ts (its home) and the single wiring file
// share-rpc.ts. AND the boot site that builds createShare's `requestApproval` dependency
// (platform/assemble.ts) MUST supply the owner consent broker (`shareConsent.request`) — not an
// arbitrary always-true approval thunk. This binds the HITL set-membership (the executor frozen set,
// I2) to the actual gating call so they cannot silently drift: the share-gate's requestApproval IS
// the owner-HITL approval (a broadcast to the local owner), distinct from the executor gate() path.
// Mirrors D18 (PREFLIGHT_RUNNER_ALLOWED) / D19 (TRIBAL_KB_WRITE_ALLOWED). Test files are exempt.
const D21_CREATESHARE_ALLOWED = [
  "packages/gateway/src/share/share-gate.ts",
  "packages/gateway/src/ipc/share-rpc.ts",
];
const D21_CREATESHARE_RE = /\bcreateShare\b/;
const D21_CONSENT_WIRING_FILE = "packages/gateway/src/platform/assemble.ts";
// Require `shareConsent.request` to be wired AS the `requestApproval` dependency (not merely
// mentioned somewhere) — so an unrelated/dead `shareConsent.request` reference can't satisfy the
// check while the real approval thunk is an always-true stub.
const D21_CONSENT_RE = /requestApproval\s*:[\s\S]{0,400}?shareConsent\.request\b/;

export function checkShareConsentBrokerConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // (B) the boot site must feed the owner broker, not an arbitrary approval thunk.
    if (f.relPath === D21_CONSENT_WIRING_FILE) {
      if (!D21_CONSENT_RE.test(stripComments(f.contents))) {
        out.push({
          rule: "D21-share-consent-broker",
          file: f.relPath,
          line: 1,
          snippet:
            "assemble.ts must supply shareConsent.request as createShare's requestApproval (I27)",
        });
      }
      continue;
    }
    // (A) createShare may not be NAMED outside the gate + the one wiring file.
    if (D21_CREATESHARE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D21_CREATESHARE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D21-createshare-callsite",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D24: a SYNCABLE may not reach a raw `vault` or `db` handle through its `SyncContext`.
//
// Before the narrowing, `SyncContext` carried both, so any of ~90 connectors could read any other
// connector's credentials and write any table. They are gone from the type, which makes a
// reintroduction a compile error — but only for as long as nobody adds them back, and a cast
// (`as unknown as SyncContext`) defeats the compiler entirely. That cast is not hypothetical: it
// was the ONE site in the 122-file migration the type system could not catch.
//
// Rule ids here are short kebab naming the PROPERTY, never the `D<N>` label — `db-run`,
// `wrap-spec`, `vault-key` — which is the docs-side name. The two coexist by design.
//
// `sync/sync-capabilities.ts` is the sole exemption: it is where a capability is minted, and it
// holds the handles so that nothing else has to.
const D24_SYNC_HANDLE_ALLOWED = [
  // Where a capability is minted. It holds the handles so nothing else has to.
  "packages/gateway/src/sync/sync-capabilities.ts",
  // FALSE POSITIVE, exempted knowingly: its `ctx` is a `ConnectorWriteContext` — the executor's
  // gateway-side write path with its own vault — not a `SyncContext`. A textual rule cannot tell
  // two identically-named parameters apart, and narrowing it by type would mean parsing. The
  // exemption is the honest form of that limit; the same reasoning applies to any future file
  // whose `ctx` is not a syncable's.
  "packages/gateway/src/connectors/connector-write-transport.ts",
];
// Written as a constructor rather than a literal: an earlier version of this line was authored
// through a script and its leading `\b` became a literal BACKSPACE byte, so the rule matched
// nothing and passed silently. Red-proving it — reintroducing `ctx.vault` and expecting a
// violation — is what caught that; a gate that cannot fail is worse than no gate.
const D24_SYNC_HANDLE_PATTERN = String.raw`\bctx\s*\.\s*(?:vault|db)\b`;
const D24_SYNC_HANDLE_RE = new RegExp(D24_SYNC_HANDLE_PATTERN);

export function checkSyncContextNoRawHandles(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // SYNCABLES only. `connectors/lazy-mesh/*` is the gateway-side spawn and credential path: it
    // holds a real vault by design and is what MINTS the environment a connector runs in, so it is
    // out of scope. The rule flagged it on its first working run — which is also the first evidence
    // the rule works at all.
    const isSyncable =
      f.relPath.startsWith("packages/gateway/src/connectors/") &&
      !f.relPath.startsWith("packages/gateway/src/connectors/lazy-mesh/");
    if (!isSyncable) continue;
    if (D24_SYNC_HANDLE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D24_SYNC_HANDLE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "sync-context-no-raw-handles",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// ---- D24 extension: `work_snapshot` is written only by the capability's store (Phase 10 MB1) ------
//
// Rule `work-snapshot-confined`. A WRITE verb on `work_snapshot` may appear only in the store
// (`index/work-snapshot-store.ts`) and the V91 DDL file; the store's writer `replaceWorkSnapshotRows`
// may be NAMED only by the store and `sync/sync-capabilities.ts`. Reads are unrestricted (the morning
// briefing reads the table). So no syncable, agent, RPC or other store writes a snapshot: a syncable
// reaches it only through the `replaceWorkSnapshot` capability, which binds the service.
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says);
// confinement of the capability itself (scoped to jira, linear and github) is the real defense.
// `iterateGlob` skips every `-sql.ts` file, so the real scan never visits the DDL file; it stays in
// the allow-list only so a synthetic file set (which feeds files directly) can carry it.
const D24_WS_SRC = "packages/gateway/src/";
const D24_WS_STORE = `${D24_WS_SRC}index/work-snapshot-store.ts`;
const D24_WS_DDL = `${D24_WS_SRC}index/work-snapshot-v91-sql.ts`;
const D24_WS_CAPABILITY = `${D24_WS_SRC}sync/sync-capabilities.ts`;
// A constructor over `String.raw`, as the handle pattern above (a script-authored literal once lost
// its `\b`): the rule is red-proved against planted violations.
const D24_WS_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?work_snapshot\b/gi;
const D24_WS_NAME_RE = /\breplaceWorkSnapshotRows\b/g;

export function checkWorkSnapshotConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "work-snapshot-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D24_WS_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D24_WS_STORE && f.relPath !== D24_WS_DDL) {
      for (const m of commentFree.matchAll(D24_WS_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D24_WS_STORE && f.relPath !== D24_WS_CAPABILITY) {
      for (const m of commentFree.matchAll(D24_WS_NAME_RE)) add(f, commentFree, m.index);
    }
  }
  return out;
}

// ---- D24 extension: `chat_read_marker` is written only by its store (Phase 10 MB4) ---------------
//
// Rule `chat-read-marker-confined`. A WRITE verb on `chat_read_marker` may appear only in the store
// (`index/chat-read-marker-store.ts`) and the V92 DDL file; the store's upsert `setChatReadMarkerRows`
// may be NAMED only by the store and `sync/sync-capabilities.ts`, and its removal
// `deleteChatReadMarkersForService` only by the store and the two paths that delete a service's items
// (`index/local-index.ts`, `commands/data-delete.ts`). Reads are unrestricted (the briefing reads the
// table). So no syncable, agent, RPC or other store writes a marker: a syncable reaches it only
// through the `setChatReadMarkers` capability, which binds the service (and only `slack` may call it).
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says); the
// capability's confinement is the real defense. `iterateGlob` skips every `-sql.ts` file, so the real
// scan never visits the DDL file; it stays in the allow-list only so a synthetic file set can carry it.
const D24_CRM_STORE = `${D24_WS_SRC}index/chat-read-marker-store.ts`;
const D24_CRM_DDL = `${D24_WS_SRC}index/chat-read-marker-v92-sql.ts`;
const D24_CRM_REMOVERS: readonly string[] = [
  `${D24_WS_SRC}index/local-index.ts`,
  `${D24_WS_SRC}commands/data-delete.ts`,
];
const D24_CRM_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?chat_read_marker\b/gi;
const D24_CRM_SET_RE = /\bsetChatReadMarkerRows\b/g;
const D24_CRM_DELETE_RE = /\bdeleteChatReadMarkersForService\b/g;

export function checkChatReadMarkerConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "chat-read-marker-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D24_WS_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D24_CRM_STORE && f.relPath !== D24_CRM_DDL) {
      for (const m of commentFree.matchAll(D24_CRM_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D24_CRM_STORE && f.relPath !== D24_WS_CAPABILITY) {
      for (const m of commentFree.matchAll(D24_CRM_SET_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D24_CRM_STORE && !D24_CRM_REMOVERS.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D24_CRM_DELETE_RE)) add(f, commentFree, m.index);
    }
  }
  return out;
}

// D46(b) (Phase 10 IC1, incident-engine spec § 5.1): `item_history` is written only by its module.
// Rule `item-history-confined`. A WRITE verb on `item_history` may appear only in `index/item-history.ts`
// (and the V94 DDL file); `recordItemUpsertHistory` / `recordItemDeleteHistory` are named only there and in
// `index/item-store.ts` (`upsertIndexedItem`, `deleteItemByPrimaryKey`); `deleteItemHistoryForService` only
// there, in `index/item-store.ts` (`deleteAllItemsForService`, which `LocalIndex.removeConnectorIndexData`
// calls) and in `commands/data-delete.ts` (an owner erasure); `pruneItemHistory` only there and in
// `index/item-history-retention.ts`. Reads are unrestricted (the reconstruction and the incident assembly
// read the table). D46 has sub-rules (a), (b) and (d) after IC3: (a) confines `incident/**` (below, next to
// D48), (d) confines the incident record tables, and (c) is reserved by the incident-engine spec for IC5.
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says). The retention
// module's batch DELETE lives in `item-history.ts`, which it only calls. `iterateGlob` skips every `-sql.ts`
// file, so the real scan never visits the DDL file; it stays in the allow-list only so a synthetic file set
// can carry it.
const D46_SRC = "packages/gateway/src/";
const D46_STORE = `${D46_SRC}index/item-history.ts`;
const D46_DDL = `${D46_SRC}index/item-history-v94-sql.ts`;
const D46_ITEM_STORE = `${D46_SRC}index/item-store.ts`;
const D46_RETENTION = `${D46_SRC}index/item-history-retention.ts`;
const D46_ERASERS: readonly string[] = [D46_ITEM_STORE, `${D46_SRC}commands/data-delete.ts`];
const D46_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?item_history\b/gi;
const D46_RECORD_RE = /\brecordItem(?:Upsert|Delete)History\b/g;
const D46_ERASE_RE = /\bdeleteItemHistoryForService\b/g;
const D46_PRUNE_RE = /\bpruneItemHistory\b/g;

export function checkItemHistoryConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "item-history-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D46_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D46_STORE && f.relPath !== D46_DDL) {
      for (const m of commentFree.matchAll(D46_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46_STORE && f.relPath !== D46_ITEM_STORE) {
      for (const m of commentFree.matchAll(D46_RECORD_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46_STORE && !D46_ERASERS.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D46_ERASE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46_STORE && f.relPath !== D46_RETENTION) {
      for (const m of commentFree.matchAll(D46_PRUNE_RE)) add(f, commentFree, m.index);
    }
  }
  return out;
}

// D46(d) (Phase 10 IC3, incident-engine spec § 5.3): the incident record tables are written only by their store.
// Rule `incident-record-confined`. A WRITE verb on `incident_record` or `incident_record_version` may appear only
// in `incident/incident-store.ts` and the V100 DDL file; `upsertIncidentRecord` only there and in
// `incident/assemble.ts` (the one assembler); `markRecordChecked` only there and in `incident/incident-engine.ts`;
// `eraseIncidentRecordsForService` and `pruneIncidentRecords` only there and in `incident/incident-erasure.ts`;
// `eraseIncidentDataForService` only in `incident/incident-erasure.ts` (its definition), `index/local-index.ts`
// (`removeConnectorIndexData`) and `commands/data-delete.ts` (the two owner erasures);
// `pruneIncidentRecordsWithBriefs` only there and in `incident/incident-retention.ts`. The pushed briefs built from
// a record are deleted only through `deletePushedBriefsForErasure` (and counted through
// `countPushedBriefsForErasure`), named only in `oncall-push/push-store.ts` and `incident/incident-erasure.ts`, and a
// write verb on `pushed_brief` itself stays in `oncall-push/push-store.ts` (and the V64 DDL). Reads are unrestricted.
// Stated bounds: a text scan, so a dynamically composed table name evades it; `iterateGlob` skips every `-sql.ts`
// file, so the real scan never visits the DDL files (they stay in the allow-list for a synthetic file set).
const D46D_SRC = "packages/gateway/src/";
const D46D_STORE = `${D46D_SRC}incident/incident-store.ts`;
const D46D_DDL = `${D46D_SRC}index/incident-record-v100-sql.ts`;
const D46D_ASSEMBLE = `${D46D_SRC}incident/assemble.ts`;
const D46D_ENGINE = `${D46D_SRC}incident/incident-engine.ts`;
const D46D_ERASURE = `${D46D_SRC}incident/incident-erasure.ts`;
const D46D_RETENTION = `${D46D_SRC}incident/incident-retention.ts`;
const D46D_PUSH_STORE = `${D46D_SRC}oncall-push/push-store.ts`;
const D46D_PUSH_DDL = `${D46D_SRC}index/oncall-push-v64-sql.ts`;
const D46D_VERBS =
  "(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|DELETE\\s+FROM|UPDATE(?:\\s+OR\\s+\\w+)?|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|ALTER\\s+TABLE)";
export const d46dWriteRe = (table: string): RegExp =>
  new RegExp(`\\b${D46D_VERBS}\\s+(?:["'\`[]?\\w+["'\`\\]]?\\s*\\.\\s*)?["'\`[]?${table}\\b`, "gi");
const D46D_RECORD_WRITE_RE = d46dWriteRe("incident_record(?:_version)?");
const D46D_BRIEF_WRITE_RE = d46dWriteRe("pushed_brief");
const D46D_IDENTIFIERS: readonly { readonly re: RegExp; readonly allowed: readonly string[] }[] = [
  { re: /\bupsertIncidentRecord\b/g, allowed: [D46D_STORE, D46D_ASSEMBLE] },
  { re: /\bmarkRecordChecked\b/g, allowed: [D46D_STORE, D46D_ENGINE] },
  { re: /\beraseIncidentRecordsForService\b/g, allowed: [D46D_STORE, D46D_ERASURE] },
  { re: /\bpruneIncidentRecords\b/g, allowed: [D46D_STORE, D46D_ERASURE] },
  {
    re: /\beraseIncidentDataForService\b/g,
    allowed: [
      D46D_ERASURE,
      `${D46D_SRC}index/local-index.ts`,
      `${D46D_SRC}commands/data-delete.ts`,
    ],
  },
  { re: /\bpruneIncidentRecordsWithBriefs\b/g, allowed: [D46D_ERASURE, D46D_RETENTION] },
  { re: /\b(?:delete|count)PushedBriefsForErasure\b/g, allowed: [D46D_PUSH_STORE, D46D_ERASURE] },
];

export function checkIncidentRecordConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "incident-record-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D46D_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D46D_STORE && f.relPath !== D46D_DDL) {
      for (const m of commentFree.matchAll(D46D_RECORD_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46D_PUSH_STORE && f.relPath !== D46D_PUSH_DDL) {
      for (const m of commentFree.matchAll(D46D_BRIEF_WRITE_RE)) add(f, commentFree, m.index);
    }
    for (const id of D46D_IDENTIFIERS) {
      if (id.allowed.includes(f.relPath)) continue;
      for (const m of commentFree.matchAll(id.re)) add(f, commentFree, m.index);
    }
  }
  return out;
}

// D46(e) (Phase 10 IC4, incident-engine spec § 5.4): the incident link on an action is minted only inside
// `incident/`. Rule `incident-link-minted-in-incident`. Three clauses over every non-test file of
// `packages/gateway/src/`, comments stripped:
//   (1) the identifier `mintIncidentLink` (a call, an import, aliased or not) only in its own module,
//       `incident/incident-link-mint.ts`, in `incident/remediation.ts` (Phase 10 IC5a: the one module that
//       runs a stored proposal as an incident-linked action), in `postmortem/postmortem-push.ts` (Phase 10
//       IC7a: the owner's post-mortem push) and in `incident-update/update-send.ts` (Phase 10 IC9b: the owner's
//       update post as an incident-linked action);
//   (2) `type IncidentLink`, `interface IncidentLink` and `function assertIncidentLink` are declared only in
//       `engine/incident-link.ts`, the one module the executor validates a link through;
//   (3) a QUOTED `"incident":{` key (a string or template literal that spells a link into a JSON row) appears
//       only in the two readers that parse or compare a row's first characters, `incident/action-links.ts`
//       and `audit/incident-replay.ts`. The executor writes the key as an object property, so no other file
//       has a reason to spell one; a hand-built forged row is what this catches.
// Stated bounds: a text scan, so a dynamically composed name or key evades it (the executor's runtime
// refusals (shape, origin, delegation) and the replay's anchored prefix read are the other half), and an
// object literal that names the key unquoted is not matched by clause (3).
const D46E_SRC = "packages/gateway/src/";
const D46E_MINT = `${D46E_SRC}incident/incident-link-mint.ts`;
// The files that may NAME the minter: its own module and each module that runs a linked owner action (IC5a's
// remediation, IC7a's post-mortem push, IC9b's incident update send, IC6's runbook steps, and owner ruling 9's live investigation reads).
const D46E_MINT_USERS: readonly string[] = [
  D46E_MINT,
  `${D46E_SRC}incident/remediation.ts`,
  `${D46E_SRC}postmortem/postmortem-push.ts`,
  `${D46E_SRC}incident-update/update-send.ts`,
  `${D46E_SRC}runbook/runbook-run.ts`,
  `${D46E_SRC}investigation/investigation-live.ts`,
];
const D46E_LINK = `${D46E_SRC}engine/incident-link.ts`;
const D46E_READERS: readonly string[] = [
  `${D46E_SRC}incident/action-links.ts`,
  `${D46E_SRC}audit/incident-replay.ts`,
];
const D46E_MINT_RE = /\bmintIncidentLink\b/g;
const D46E_DECL_RE =
  /\b(?:type\s+IncidentLink\s*=|interface\s+IncidentLink\b|function\s+assertIncidentLink\b)/g;
const D46E_KEY_RE = /\\?["']incident\\?["']\s*:\s*\{/g;

export function checkIncidentLinkMinting(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "incident-link-minted-in-incident",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath)) continue;
    if (!f.relPath.startsWith(D46E_SRC)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (!D46E_MINT_USERS.includes(f.relPath)) {
      for (const m of code.matchAll(D46E_MINT_RE)) add(f, code, m.index);
    }
    if (f.relPath !== D46E_LINK) {
      for (const m of code.matchAll(D46E_DECL_RE)) add(f, code, m.index);
    }
    if (!D46E_READERS.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D46E_KEY_RE)) add(f, commentFree, m.index);
    }
  }
  return out;
}
