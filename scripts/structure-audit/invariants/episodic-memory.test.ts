import { describe, expect, test } from "bun:test";

import { iterateSourceFiles } from "../lib.ts";
import type { FileEntry } from "./_shared.ts";
import { checkEpisodicMemoryConfinement } from "./episodic-memory.ts";

const SRC = "packages/gateway/src/";
const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
const GOOD: FileEntry[] = [
  file(
    `${SRC}memory/episodic-store.ts`,
    'db.query("SELECT * FROM episodic_memory"); db.run("DELETE FROM episodic_pending_turn");',
  ),
  file(`${SRC}memory/episodic-memory.ts`, "export class EpisodicMemory { recordOwnerTurn() {} }"),
  file(`${SRC}memory/episodic-summarise.ts`, "export function createEpisodicLlm() {}"),
  file(
    `${SRC}engine/run-ask/episodic.ts`,
    "if (p.offerConnectorWriteTools !== true || p.paths.demo === true) return; port.recordOwnerTurn(); export function recordEpisodicTurn() {}",
  ),
  file(`${SRC}engine/run-ask.ts`, "recordEpisodicTurn(p, sessionId, reply);"),
  file(
    `${SRC}platform/assemble/episodic-boot.ts`,
    "const m = new EpisodicMemory({ llm: createEpisodicLlm(r) }); store.episodic = m;",
  ),
  file(`${SRC}config/memory-toml.ts`, 'import { x } from "./layered-config.ts";'),
];
const rules = (files: FileEntry[]): string[] =>
  checkEpisodicMemoryConfinement(files).map((v) => v.rule);

describe("D52 - long-term episodic memory stays confined (I61)", () => {
  test("the sanctioned layout is clean", () => {
    expect(checkEpisodicMemoryConfinement(GOOD)).toEqual([]);
  });

  test.each([
    ['db.query("SELECT * FROM episodic_memory");', "(a) a table read around the store"],
    ['db.run("INSERT INTO episodic_pending_turn VALUES (1)");', "(a) a pending-turn write"],
    ["mem.recordOwnerTurn(s, q, a);", "(b) a second producer of a pending turn"],
    ["recordEpisodicTurn(p, s, r);", "(b) a second caller of the ask-turn hook"],
    ["const m = new EpisodicMemory({});", "(c) a second memory wired to another model"],
    ["const l = createEpisodicLlm(router);", "(c) a second summariser binding"],
    ["store.episodic = other;", "(c) a second attach site"],
    [
      'import { EpisodicMemory as Mem } from "../memory/episodic-memory.ts"; new Mem({});',
      "(c) construction through an imported alias",
    ],
  ])("%s is refused outside its sites: %s", (body) => {
    expect(rules([...GOOD, file(`${SRC}ipc/other.ts`, body)])).toContain(
      "episodic-memory-confined",
    );
  });

  test.each([
    ["embedQueryDual(rt, t);", "a remote or dual embedding route"],
    ["new RoutingEmbeddingPipeline();", "the routing pipeline"],
    ["createOpenAIEmbedder({});", "the remote embedder"],
    ['import { x } from "../chatops/reply-dispatcher.ts";', "ChatOps"],
    ['import { x } from "../egress/egress-ledger.ts";', "the egress ledger"],
    ['import("../federation/lan-link.ts");', "federation"],
    ['import { x } from "../connectors/registry.ts";', "a connector value"],
    ["await fetch(url);", "a network primitive"],
    ['import http from "node:https";', "a network module"],
  ])("a memory module that contains %s is refused: %s", (body) => {
    expect(rules([...GOOD, file(`${SRC}memory/episodic-extra.ts`, body)])).toContain(
      "episodic-memory-confined",
    );
    expect(rules([...GOOD, file(`${SRC}config/memory-toml.ts`, body)])).toContain(
      "episodic-memory-confined",
    );
  });

  test("type-only imports of the class are fine", () => {
    const t = file(
      `${SRC}ipc/x.ts`,
      'import type { EpisodicMemory } from "../memory/episodic-memory.ts"; import { type EpisodicMemory as M, formatRecallBlock } from "../memory/episodic-memory.ts";',
    );
    expect(rules([...GOOD, t])).toEqual([]);
  });

  test("the owner-turn gate must keep both its signals", () => {
    const missing = GOOD.map((f) =>
      f.relPath === `${SRC}engine/run-ask/episodic.ts`
        ? file(f.relPath, "if (p.paths.demo === true) return;")
        : f,
    );
    expect(rules(missing)).toContain("episodic-memory-confined");
  });

  test("comments and test files are not code", () => {
    expect(
      rules([
        ...GOOD,
        file(
          `${SRC}ipc/other.ts`,
          "// episodic_memory recordOwnerTurn new EpisodicMemory(\nconst s = 1;",
        ),
        file(
          `${SRC}ipc/other.test.ts`,
          "x.recordOwnerTurn(); db.run('DELETE FROM episodic_memory');",
        ),
        file(`${SRC}memory/episodic.test-helpers.ts`, "new EpisodicMemory({}); fetch(u);"),
      ]),
    ).toEqual([]);
  });

  test("is green on the repo, and the anchor is in the scanned set", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles())
      files.push({ relPath: f.relPath, contents: f.contents });
    expect(files.some((f) => f.relPath === `${SRC}memory/episodic-store.ts`)).toBe(true);
    expect(checkEpisodicMemoryConfinement(files)).toEqual([]);
  });
});
