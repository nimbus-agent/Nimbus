import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isCatchupBrief } from "../../../src/agents/_lib/findings.ts";
import { runCatchup } from "../../../src/agents/catchup.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { insertPerson } from "../../../src/people/person-store.ts";

function seedTwoServices(db: Database): void {
  const now = Date.now();
  insertPerson(db, {
    id: "p-self",
    displayName: "Self",
    canonicalEmail: "self@example.com",
    githubLogin: "self",
    gitlabLogin: null,
    slackHandle: null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    bitbucketUuid: null,
    linked: false,
    metadata: {},
  });
  const stmt = db.prepare(
    "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned, author_id) " +
      "VALUES (?, ?, ?, ?, ?, '', ?, ?, 0, ?)",
  );
  for (let i = 0; i < 8; i++) {
    stmt.run(
      `gh:${i}`,
      "github",
      "pr",
      `acme/payment#${100 + i}`,
      `gh PR ${i}`,
      now - i * 60_000,
      now,
      "p-self",
    );
  }
  stmt.run("lin:1", "linear", "issue", "lin-1", "linear issue 1", now - 1_000, now, "p-self");
}

describe("nimbus catchup (e2e, in-process)", () => {
  test("first section is the higher-activity service; latency < 15 s; HITL-free", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedTwoServices(db);

    const start = performance.now();
    const brief = await runCatchup(
      {
        sinceMs: 3 * 24 * 60 * 60 * 1000,
        mePersonIdOverride: "p-self",
      },
      { db, sessionId: "e2e-catchup-1", notify: () => {} },
    );
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(15_000);
    expect(isCatchupBrief(brief)).toBe(true);
    expect(brief.selfPersonId).toBe("p-self");
    expect(brief.sections.length).toBeGreaterThan(0);
    expect(brief.sections[0]?.serviceId).toBe("github");
    expect(brief.involvement.ownedServices).toContain("github");
    expect(brief.involvement.ownedServices).not.toContain("linear");
  });

  test("missing_user_identity gap fires when all three resolver tiers miss", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    const brief = await runCatchup(
      {
        sinceMs: 3 * 24 * 60 * 60 * 1000,
        runGitOverride: async () => null,
        osUsernameOverride: "",
      },
      { db, sessionId: "e2e-catchup-2", notify: () => {} },
    );
    expect(brief.selfPersonId).toBeNull();
    expect(brief.gaps.some((g) => g.category === "missing_user_identity")).toBe(true);
  });

  test("--service filter restricts sections", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedTwoServices(db);
    const brief = await runCatchup(
      {
        sinceMs: 3 * 24 * 60 * 60 * 1000,
        service: "linear",
        mePersonIdOverride: "p-self",
      },
      { db, sessionId: "e2e-catchup-3", notify: () => {} },
    );
    expect(brief.sections.every((s) => s.serviceId === "linear")).toBe(true);
  });

  test("structural HITL-free: catchup.ts must not import ToolExecutor or HITL_REQUIRED", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../src/agents/catchup.ts"),
      "utf8",
    ) as string;
    expect(source).not.toContain("ToolExecutor");
    expect(source).not.toContain("HITL_REQUIRED");
  });
});
