// Static invariant rule D52: long-term episodic memory stays confined (Phase 10, OR-S4-MEM, I61).
// docs/SECURITY-INVARIANTS.md describes the rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// ---- D52 (long-term episodic memory, I61) ---------------------------------------------------------
// Rule `episodic-memory-confined`. The memory's one safety property is INPUT CONFINEMENT: what is summarised
// and stored comes only from the local owner's own messages and the final answers of their turns, through a
// local model and a local embedder. Each identifier below is matched as a word after comments (and, for the
// code rules, string literals) are stripped, so an aliased import is caught. Test files are not scanned.
//
// (a) the table names `episodic_memory` and `episodic_pending_turn` appear only in the store
//     (`memory/episodic-store.ts`), so nothing else reads or writes a memory around its caps and its types;
// (b) `recordOwnerTurn` is named only by its definition (`memory/episodic-memory.ts`) and its one caller
//     (`engine/run-ask/episodic.ts`), and `recordEpisodicTurn` only by that file and `engine/run-ask.ts`, so
//     the only producer of a pending turn is the ask turn's own `input` and final `reply`;
// (c) `new EpisodicMemory(` and `createEpisodicLlm` only in `platform/assemble/episodic-boot.ts` (and the
//     adapter's own definition), and the property `.episodic =` is assigned only there, so no second
//     instance wired to another model or embedder exists and a demo gateway (which that file refuses) is
//     the only construction path;
// (d) the memory modules (`memory/episodic-*.ts`, `config/memory-toml.ts`) name no remote-embedder or dual
//     route (`embedQueryDual`, `createOpenAIEmbedder`, `RoutingEmbeddingPipeline`) and import nothing from
//     `chatops/`, `egress/`, `federation/`, `share/` or `connectors/`, and use no network primitive: the
//     summariser and the embedder are local by construction, and nothing here can send a summary anywhere;
// (e) the owner-turn decision lives in `engine/run-ask/episodic.ts` and names both `offerConnectorWriteTools`
//     and `paths.demo`: it is the one place a turn becomes the owner's.
// Stated bounds: a text scan, so a dynamically composed name evades it and a second use inside an allow-listed
// file is exempt whole-file; the behavioural tests in `security-invariants/i61-episodic-memory.test.ts` are
// authoritative. `iterateGlob` skips `-sql.ts` files, so the DDL file never reaches (a); it is in the allow-list
// so a synthetic set can carry it.
const SRC = "packages/gateway/src/";
const STORE = `${SRC}memory/episodic-store.ts`;
const MEMORY = `${SRC}memory/episodic-memory.ts`;
const TURN = `${SRC}engine/run-ask/episodic.ts`;
const BOOT = `${SRC}platform/assemble/episodic-boot.ts`;
const SUMMARISE = `${SRC}memory/episodic-summarise.ts`;
const RULE = "episodic-memory-confined";

const TABLE_RE = /\bepisodic_(?:memory|pending_turn)\b/g;
const TABLE_ALLOWED: readonly string[] = [STORE, `${SRC}index/episodic-memory-v107-sql.ts`];

const WORD_RULES: ReadonlyArray<{ re: RegExp; allowed: readonly string[] }> = [
  { re: /\brecordOwnerTurn\b/g, allowed: [MEMORY, TURN] },
  { re: /\brecordEpisodicTurn\b/g, allowed: [TURN, `${SRC}engine/run-ask.ts`] },
  { re: /\bnew\s+EpisodicMemory\b/g, allowed: [BOOT] },
  { re: /\bcreateEpisodicLlm\b/g, allowed: [SUMMARISE, BOOT] },
  { re: /\.episodic\s*=(?!=)/g, allowed: [BOOT] },
];

const D52_MODULE_RE =
  /^packages\/gateway\/src\/(?:memory\/episodic[\w.-]*\.ts|config\/memory-toml\.ts)$/;
const D52_FORBIDDEN_WORD_RE =
  /\b(?:embedQueryDual\w*|createOpenAIEmbedder|RoutingEmbeddingPipeline)\b/g;
const D52_FORBIDDEN_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'][^"']*\/(?:chatops|egress|federation|share|connectors)\/[^"']*["']/g;
const D52_NETWORK_RE =
  /\bfetch\s*\(|\bglobalThis\b|\bBun\.fetch\b|\bnew\s+WebSocket\b|\bXMLHttpRequest\b|["']node:(?:https?|http2|net|tls|dgram)["']|["']undici["']/g;

function lineOf(text: string, index: number | undefined): number {
  return text.slice(0, index).split("\n").length;
}

export function checkEpisodicMemoryConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(SRC)) continue;
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    const original = f.contents.split("\n");
    const noComments = stripComments(f.contents);
    const code = stripStringLiterals(noComments);
    const push = (text: string, index: number | undefined): void => {
      const line = lineOf(text, index);
      out.push({
        rule: RULE,
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    };
    if (!TABLE_ALLOWED.includes(f.relPath)) {
      for (const m of noComments.matchAll(TABLE_RE)) push(noComments, m.index);
    }
    for (const r of WORD_RULES) {
      if (r.allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(r.re)) push(code, m.index);
    }
    if (D52_MODULE_RE.test(f.relPath)) {
      for (const m of code.matchAll(D52_FORBIDDEN_WORD_RE)) push(code, m.index);
      for (const m of noComments.matchAll(D52_FORBIDDEN_IMPORT_RE)) push(noComments, m.index);
      for (const m of noComments.matchAll(D52_NETWORK_RE)) push(noComments, m.index);
    }
    if (
      f.relPath === TURN &&
      !(/\bofferConnectorWriteTools\b/.test(code) && /\bpaths\.demo\b/.test(code))
    ) {
      out.push({
        rule: RULE,
        file: f.relPath,
        line: 1,
        snippet: "the owner-turn gate lost offerConnectorWriteTools or paths.demo",
      });
    }
  }
  return out;
}
