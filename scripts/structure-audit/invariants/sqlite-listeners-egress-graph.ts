// Static invariant rules: toolgen keys, SQLite init, listener registry, egress chokepoint and co-owned graph types.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { CO_OWNED_ENTITY_TYPES } from "../../../packages/gateway/src/graph/relationship-graph.ts";
import { stripComments } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import {
  D22_AGENT_RECORD_CALLER,
  D22_AGENT_RECORD_DEFINITION,
  D22_AGENT_RECORD_RE,
  D22_APPEND_ALLOWED_PREFIX,
  D22_APPEND_RE,
  D22_DISPATCH_ALLOWED,
  D22_DISPATCH_RE,
  D22_REGISTER_ROUTE_ALLOWED,
  D22_REGISTER_ROUTE_RE,
} from "./actuation-embedding-registry.ts";

// D29 (c) (I39): the `toolgen.` VAULT-KEY prefix a generated tool's per-host credential lives under
// (`toolgen.<toolId>.<hostSlug>`) is composed only in `toolgen/toolgen-credentials.ts`'s
// `toolCredentialKey`. Matches the TEMPLATE-LITERAL SHAPE of the actual key -- a `toolgen.` prefix,
// an interpolation, a literal `.`, and a second interpolation -- rather than any string that merely
// starts with `toolgen.`: `toolgen-stub.ts` legitimately builds the unrelated single-segment
// extension id `` `toolgen.${toolId}` `` (no second `.${...}` segment), and a rule keyed on the
// bare prefix would false-positive on it. Written as what CANNOT pass: any file other than
// `toolgen-credentials.ts` composing a string with this exact two-segment shape is a second Vault
// keyspace producer that can drift from the escaping scheme `toolCredentialKey` implements (see
// that function's own comment on why the escape ORDER matters).
//
// STATED BOUND, matching D27(b)'s bound on `media_grant`: the keys are composed dynamically, so a
// prefix built through string concatenation or an indirection this regex cannot see still evades a
// text scan. Capability confinement -- only `toolgen-credentials.ts` is ever handed the Vault for
// that prefix -- is the real defense; this rule and the `VAULT_KEY_ALLOW_LIST` entry above both
// document the keyspace rather than fully enforcing it.
const D29_VAULT_KEY_DEFINITION_FILE = "packages/gateway/src/toolgen/toolgen-credentials.ts";
const D29_VAULT_KEY_RE = /`toolgen\.\$\{[^}]*\}\.\$\{[^}]*\}/;

export function checkToolgenVaultKeyConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D29_VAULT_KEY_DEFINITION_FILE) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D29_VAULT_KEY_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(c)-toolgen-vault-key-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D29 (d) (I40): there is no unverified read accessor for a saved generated-tool artifact.
// `toolgen-saved-store.ts`'s `readVerifiedSavedTool` is the ONLY function this codebase permits to
// hand a saved tool's body or fields to a caller, and it verifies the artifact's Ed25519 signature
// (I40) before returning anything -- see that file's own docstring, which calls this "the whole
// point of it existing".
//
// Keyed on IDENTIFIERS, not on the on-disk path text. A proposed form scanned file contents for
// `/toolgen[\\/]saved/`, and there are ZERO such literals anywhere in this tree -- the store
// composes every path from its own private constants (`join(configDir, STORE_DIR, SAVED_DIR,
// toolId)`), so that rule would match nothing and report green forever, which is worse than no
// rule at all: it reads as coverage.
//
// `SAVED_DIR` is the store's own private directory-segment constant (value `"saved"`). Deliberately
// NOT `STORE_DIR` (value `"toolgen"`): the unrelated ephemeral script store (`toolgen-script-store.ts`)
// declares its own module-private `STORE_DIR` of the same name for an unrelated purpose, so keying
// on that name would false-positive on a file this rule has no business flagging. `SAVED_DIR` names
// no other file's concept and is safe to key on without that collision.
// `readSavedToolUnverified` and `rawSavedArtifact` name no function that exists in this tree today;
// they are the SHAPE a future bypass would plausibly take (a "just peek at the JSON" helper, a
// debug dump, a fast path that trusts the row's cached health column because "it already says
// healthy") rather than a shape actually present anywhere yet. `readVerifiedSavedTool` itself is
// deliberately NOT matched -- it is the sanctioned door this rule exists to protect, not to flag.
//
// STATED BOUND, in D27(b)'s own style: a dynamically composed path, or a renamed local built by
// string concatenation or re-exported under an alias, still evades a text scan -- that residual is
// closed the way the others are, by capability, not by this rule: only `toolgen-saved-store.ts` is
// ever hard-coded with the saved-tool directory layout, and every other module reaches a saved
// artifact only through `readVerifiedSavedTool`. This rule is the backstop for a second definition
// or a leaked constant appearing in the wrong file, exactly as D27(b) says of `media_grant`.
const D29D_STORE = "packages/gateway/src/toolgen/toolgen-saved-store.ts";
const D29D_FORBIDDEN_RE = /\b(SAVED_DIR|readSavedToolUnverified|rawSavedArtifact)\b/;

export function checkSavedToolAccessorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D29D_STORE) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D29D_FORBIDDEN_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(d)-saved-tool-accessor-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D30: a file that can OPEN a SQLite database reaches the full-SQLite install first.
//
// `Database.setCustomSQLite(path)` is what makes `db.loadExtension()` — and therefore sqlite-vec,
// and therefore vector search, hybrid ranking and session-memory recall — work at all on macOS,
// where Bun links Apple's extension-less system SQLite. It is process-wide, it only works before
// the first database is opened, and a Bun `Worker` is a separate realm with its own `bun:sqlite`.
// So the install has to happen in EVERY process and realm that opens a database, ahead of the
// open. `platform/sqlite-runtime.ts`'s `ensureFullSqlite()` is that install (a no-op off darwin,
// and idempotent, so calling it in a realm that has already installed one costs nothing).
//
// Issue #1029 is what a missed call looks like: nobody ever made ONE of these calls, sqlite-vec
// has never loaded on macOS in CI or on a user's machine, and the symptom was 54 test sites
// quietly skipping themselves. A partial fix has the same shape and is harder to see, because the
// three entry points that WERE wired make the product look fixed.
//
// WRITTEN AS WHAT CANNOT PASS, not as an allow-list of what may. There is no allow-list at all:
// every file in the scanned set that can construct a `Database` names `ensureFullSqlite`. A new
// entry point added tomorrow is a violation on the day it is written, with no list for anyone to
// forget to update — this repo's recorded lesson is that allow-list guards fail silently.
//
// WHAT COUNTS AS "can open one": a VALUE import from `bun:sqlite`. `import type { Database }` is
// the overwhelmingly common form here (~200 files receive a handle they did not open) and binds
// nothing at runtime, so it is correctly invisible to this rule. Everything that DOES bind the
// constructor is caught, including the forms a `new Database(` text scan misses and that are
// already present in this tree: the alias (`db/snapshot.ts`'s
// `import { Database as BunDatabase, type Database }`) and the static factory
// (`index/migrated-db-template.ts`'s `Database.deserialize`). A namespace or default import is
// caught for the same reason.
//
// STATED BOUND: this proves the call is PRESENT in the file, never that it happens before the
// open — a text scan cannot order two statements, and a caller could always reach a database
// through a helper in another module. It is the backstop for the failure that actually happened
// (a whole entry point with no call at all), and the primary defense is the same one D27(b) and
// D29(c)/(d) rest on: only these files are ever handed the ability to open a connection.
const D30_INIT = "ensureFullSqlite";
/**
 * One `… from "bun:sqlite"` import statement, clause captured.
 *
 * `[^;]` cannot cross a statement terminator, so a lazy match anchored on the module specifier
 * cannot start at an earlier import and swallow it; `m` anchors the keyword at a line start, and
 * newlines inside the clause are fine because a multi-line import contains no `;`.
 *
 * THAT SEPARATION IS ENFORCED BY BIOME, NOT BY THIS REGEX. It holds because `biome.json` sets
 * `javascript.formatter.semicolons: "always"` and every file in the scanned set is formatted, so a
 * preceding import always ends in `;`. In a semicolon-free tree an `import { Database } from
 * "bun:sqlite"` on one line followed by a type-only import on the next would be captured as one
 * clause, and the value binding would make the pair report a violation. That is the FAIL-SAFE
 * direction — a false positive a reader can see, never a miss — but it is a property of the
 * formatter, and a change to that setting would need this rule revisited.
 */
const D30_IMPORT_RE = /^import\s+([^;]*?)\s*from\s*["']bun:sqlite["']/gm;

/** Does this `bun:sqlite` import clause bind anything at RUNTIME (as opposed to types only)? */
export function bunSqliteImportBindsValue(clause: string): boolean {
  const trimmed = clause.trim();
  // `import type { … } from "bun:sqlite"` — the whole statement is erased.
  if (/^type\b/.test(trimmed)) return false;
  const braces = /\{([\s\S]*)\}/.exec(trimmed);
  // No braces: a default or namespace import (`import sqlite from`, `import * as sqlite from`),
  // both of which hand the caller the constructor.
  if (braces === null) return true;
  // A side-effect-only import (`import "bun:sqlite"`) never reaches here — it has no clause and
  // so no ` from `. Anything before the braces (a default binding) is a value.
  if (trimmed.slice(0, trimmed.indexOf("{")).trim() !== "") return true;
  return (braces[1] ?? "")
    .split(",")
    .map((sp) => sp.trim())
    .filter((sp) => sp !== "")
    .some((sp) => !/^type\s/.test(sp));
}

export function checkSqliteRuntimeInit(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    const code = stripComments(f.contents);
    if (code.includes(D30_INIT)) continue;
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D30_IMPORT_RE.source, "gm"))) {
      if (!bunSqliteImportBindsValue(m[1] ?? "")) continue;
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D30-sqlite-runtime-init",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D31: a file that OPENS a listening socket registers it with the live `ListenerRegistry`
// (`locality/listener-registry.ts`), tied to no invariant, exactly as D30 is not.
//
// `nimbus wow`'s locality panel shows the owner which listeners are open RIGHT NOW and whether
// each is loopback, read live off `processListeners.live()`. That panel is only honest if the
// registry reflects what it claims to — a listen site among the three shapes below, added
// tomorrow with no `registerListener()` call, would make the panel silently incomplete rather than
// visibly broken, the same failure shape D30's `ensureFullSqlite()` gap was.
//
// STATED BOUND: this rule polices exactly the three CALL SHAPES named below, in a GATEWAY-PROCESS
// file (the scan goes by path, so it also covers `platform/sandbox/net-forward-host.ts`, which runs
// in the `__nimbus-sandbox` wrapper rather than the gateway) — it cannot see two other kinds of open socket. One: a socket a LIBRARY opens internally
// (today: `bonjour-service`'s `new Bonjour()` inside `federation/mdns-discovery-provider.ts`,
// which binds UDP 5353 multicast). That registration is by HAND, proven only by its own test, and
// is outside this rule's reach the same way D27(b)'s `media_grant` table confinement and D29(c)'s
// `toolgen.` Vault-key prefix are — capability confinement, not a text scan, is the real defense
// there. Two: a socket a gateway-SPAWNED CHILD PROCESS opens on its own — today,
// `computer-use/cu-lanes/browser-launch.ts` launches Chromium with `--remote-debugging-port=0`
// during a live `nimbus computer` browser session, a real loopback CDP listening socket no
// gateway file itself calls `Bun.serve`/`Bun.listen`/`net.createServer` for, so this rule never
// sees it either. That is why the locality panel's own heading reads "Listeners the gateway has
// open right now:" rather than an unqualified "Listeners" claim.
//
// THE EXEMPTION IS FILE-LEVEL, not call-level — the same granularity as D30's `ensureFullSqlite()`
// check: ONE `registerListener(` call anywhere in a file exempts EVERY `Bun.serve`/`Bun.listen`/
// `net.createServer` call in that same file from this scan, not only the call nearest it.
//
// WRITTEN AS WHAT CANNOT PASS, not as an allow-list of what may — same reasoning as D30: a new
// listen site among the three shapes below is a violation on the day it is written, with nothing
// for anyone to remember to add to a list.
//
// WHAT COUNTS AS "opens a listening socket": `Bun.serve(`, `Bun.listen(` (including a generic
// argument, `Bun.listen<State>(`) and `net.createServer(`. A `typeof Bun.listen<…>` / `typeof
// Bun.serve` TYPE QUERY — the shape `ipc/server/server.ts` carries at
// `ReturnType<typeof Bun.listen<BunSessionData>>` — opens nothing at runtime and must not force a
// registration; it is blanked out (character-for-character, so line numbers of a REAL call later
// in the same file are unaffected) before the main pattern is matched, so a file that carries only
// the type query is clean, and a file that carries BOTH the type query and a real
// `Bun.listen<State>({` call is still caught by the real call once the type query is blanked out
// from under it.
const D31_TYPEOF_QUERY_RE = /\btypeof\s+Bun\.(?:serve|listen)(?:\s*<[^<>]*>)?/g;
const D31_LISTEN_RE = /\bBun\.(?:serve|listen)\b|\bcreateServer\s*\(/g;
// Matches the CALL, anchored on a non-identifier character (or start of text) immediately
// before it — never a bare substring. `unregisterListener` (the handle every one of the five
// sites hands back to its own stop path) CONTAINS "registerListener" as a substring, so an
// earlier `stripped.includes("registerListener")` short-circuited the whole scan for any file
// that merely NAMES an unregister handle, without ever calling `registerListener(` itself —
// `server.ts` passed for the wrong reason (skipped before the `typeof` blanking below ever ran),
// and a future file that stores an unregister handle and opens a socket without registering
// would have been clean too. The negative lookbehind is what rules that out: `(?<!e)` on its own
// would also reject a real call written as `registerListener(` at the very start of a file, so it
// is scoped to identifier characters specifically.
const D31_REGISTER_CALL_RE = /(?<![A-Za-z0-9_$])registerListener\s*\(/;

/** Blank every match of `re` in `text`, replacing non-newline characters with spaces so every
 * later line number (and every later match offset) is unaffected. */
function blankMatches(text: string, re: RegExp): string {
  return text.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

export function checkListenerRegistryConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const stripped = stripComments(f.contents);
    if (D31_REGISTER_CALL_RE.test(stripped)) continue;
    const scanned = blankMatches(stripped, D31_TYPEOF_QUERY_RE);
    const original = f.contents.split("\n");
    for (const m of scanned.matchAll(new RegExp(D31_LISTEN_RE.source, "g"))) {
      const line = scanned.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D31-listener-registry-registration",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

export function checkEgressChokepointConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (D22_DISPATCH_RE.test(line) && f.relPath !== D22_DISPATCH_ALLOWED) {
        out.push({
          rule: "D22-connectors-dispatch",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (D22_APPEND_RE.test(line) && !f.relPath.startsWith(D22_APPEND_ALLOWED_PREFIX)) {
        out.push({
          rule: "D22-egress-append",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (
        D22_AGENT_RECORD_RE.test(line) &&
        f.relPath !== D22_AGENT_RECORD_CALLER &&
        f.relPath !== D22_AGENT_RECORD_DEFINITION
      ) {
        out.push({
          rule: "D22-agent-brief-egress",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (D22_REGISTER_ROUTE_RE.test(line) && !D22_REGISTER_ROUTE_ALLOWED.includes(f.relPath)) {
        out.push({
          rule: "D22-register-route",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// graph-entity flat/co-owned confinement — NOT a numbered security invariant and not a new one:
// this rule enforces a data-integrity property (Task 4 of the graph-entity-metadata-namespacing
// plan), not a docs/SECURITY-INVARIANTS.md row, so it deliberately does not take a "D2x" number —
// taking one would misstate what CLAUDE.md's "Static complement" line documents (D10 through D22
// map 1:1 onto specific I-numbers). It follows the D20–D22 SHAPE — a named regex plus an
// allowed-path constant — without claiming their provenance.
//
// WHAT IT PROTECTS: `graph_entity.metadata` is namespaced per-writer for the co-owned types
// named by `CO_OWNED_ENTITY_TYPES` — imported directly from relationship-graph.ts rather than
// restated here, so the two lists cannot drift (this script already imports other production
// constants, e.g. CONNECTOR_VAULT_SECRET_KEYS above). The membership rule, and which entries are
// live collisions versus defensive or uniformity inclusions, is documented at that constant and
// deliberately NOT duplicated here — a copy would be one more thing to keep true.
// The flat `upsertGraphEntity` REPLACES the whole `metadata` column; calling it with a co-owned
// type is exactly the bug Tasks 1–3 fixed (a code-symbol sync wiping the ownership-pass's owner
// counts). Step 1's `NonCoOwnedType<T>` already rejects a LITERAL co-owned type at compile time;
// this rule is the second, independent layer, covering literals in any file — including a file
// the compiler guard cannot see if the call site widens its type parameter, and including files
// added after this commit.
//
// A NEW co-owned type must be added to `CO_OWNED_ENTITY_TYPES` in relationship-graph.ts, in the
// SAME commit it becomes co-owned; this rule reads that constant directly and needs no edit of its
// own, but the commit must still convert every new co-owned write site to
// `upsertGraphEntityNamespaced` or this rule (and the compiler guard) will start catching them.
//
// MATCH SHAPE: the real call site is always multi-line —
//   upsertGraphEntity(db, {
//     type: "source_file",
// — never on one line — so a same-line regex would miss every real occurrence and pass vacuously.
// `[\s\S]{0,120}?` (lazy) spans from the `(` the regex just consumed to the `type:` literal,
// across newlines. 120 is bounded deliberately: re-measured against every real
// `upsertGraphEntity(` call site in graph-populator.ts on 2026-08-19, `type:` is always the FIRST
// field and starts 10–12 characters after that `(` (`db, {`, a newline, then a four- or
// six-space indent). 120 is therefore an order of magnitude of slack without being able to reach
// a SUBSEQUENT call, whose own `upsertGraphEntity(` starts hundreds of characters later in every
// measured case. This bound is asserted directly in this file's tests — a `type:` pushed past the
// window is NOT matched — rather than inferred from how fast the scan runs.
//
// `\bupsertGraphEntity\s*\(` does not match `upsertGraphEntityNamespaced`, and the reason is the
// `\s*\(`, NOT a trailing `\b`: the shipped pattern below has a LEADING `\b` only. In
// `upsertGraphEntityNamespaced(` the character right after `...Entity` is `N` — neither
// whitespace nor `(` — so the pattern cannot complete there. (A trailing `\b` would separate the
// two names as well, since `y`→`N` is word-to-word and no boundary exists; it simply is not what
// the code does, and this comment claimed it was.) No explicit exclusion of the namespaced name
// is needed either way.
//
// EXEMPTION: `.test.ts` files, matching every other rule in this file (D20/D21/D22). Tasks 1 and 3
// established that fixture-only test writes — `upsertGraphEntity<string>(db, { type: "person", ... })`
// with no `metadata`, existing only to materialise a node so a relation has an endpoint — correctly
// keep the flat call: neither "ownership" nor "symbols" describes a test fixture, and converting
// them would write a namespace nobody reads. The exemption is by FILE PATH, not by the presence of
// an explicit `<string>` type argument: trusting that argument as an opt-out marker would let ANY
// caller — including a future production writer — silence this rule by adding one type parameter,
// which is exactly the kind of escape hatch a "what cannot pass" rule must not offer. In the real
// `bun run audit:invariants` run this exemption is defense-in-depth rather than load-bearing:
// `iterateSourceFiles()` (scripts/structure-audit/lib.ts) already excludes every `.test.ts` file
// before any rule sees it. It matters when a check function here is exercised directly against a
// synthetic `FileEntry[]`, which is exactly how this file's own tests — and the fixture files named
// above — are exercised.
//
// LIMIT, stated rather than implied: like Step 1's `NonCoOwnedType<T>` compiler guard, this rule
// resolves LITERALS only. `upsertGraphEntity(db, { type: someVariable, ... })` evades both layers
// no matter what `someVariable` holds at runtime — neither layer can see through a `string`-typed
// binding to the value it carries. Together the two layers close every literal shape present in
// the tree today; a call site that computes its type dynamically evades both, and nothing here
// claims otherwise.
const GRAPH_ENTITY_FLAT_DEFINITION_SITE = "packages/gateway/src/graph/relationship-graph.ts";
const GRAPH_ENTITY_COOWNED_TYPE_ALT = CO_OWNED_ENTITY_TYPES.join("|");
// The optional `<...>` segment is LOAD-BEARING, not defensive tidiness. `upsertGraphEntity` is
// generic, so `upsertGraphEntity<string>(db, { type: "person", … })` instantiates `T` as `string`
// explicitly; `NonCoOwnedType<string>` collapses back to `string` (a non-union never distributes),
// so the compiler guard accepts it. Without this segment the regex did not match that shape
// either, which left a production caller able to defeat BOTH layers by adding one type argument —
// re-creating, by accident, exactly the caller-controlled opt-out the path-based exemption below
// was chosen to avoid. Red-proved in both directions before and after this change: a probe file
// using `<string>` passed `audit:invariants` AND `typecheck` beforehand, and fails the audit now.
// Bounded (`{0,120}`) and `(`-free so it cannot run past the call it is matching.
const GRAPH_ENTITY_COOWNED_FLAT_RE = new RegExp(
  `\\bupsertGraphEntity(?:\\s*<[^()]{0,120}>)?\\s*\\([\\s\\S]{0,120}?type:\\s*["'\`](?:${GRAPH_ENTITY_COOWNED_TYPE_ALT})["'\`]`,
  "g",
);

export function checkFlatUpsertGraphEntityCoOwnedTypes(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath === GRAPH_ENTITY_FLAT_DEFINITION_SITE) continue;
    const stripped = stripComments(f.contents);
    const lines = stripped.split("\n");
    GRAPH_ENTITY_COOWNED_FLAT_RE.lastIndex = 0;
    let m: RegExpExecArray | null = GRAPH_ENTITY_COOWNED_FLAT_RE.exec(stripped);
    while (m !== null) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "graph-entity-flat-coowned",
        file: f.relPath,
        line,
        snippet: (lines[line - 1] ?? "").trim(),
      });
      m = GRAPH_ENTITY_COOWNED_FLAT_RE.exec(stripped);
    }
  }
  return out;
}
