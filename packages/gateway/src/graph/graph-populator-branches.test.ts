/**
 * Branch-coverage tests for graph-populator.ts.
 *
 * Uses Database(":memory:") + createMemoryIndexDb() (which runs all migrations
 * via LocalIndex.ensureSchema).  Each test calls syncGraphFromIndexedItem
 * directly and asserts concrete DB rows.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const openedDbs: Database[] = [];

function freshDb(): Database {
  const db = createMemoryIndexDb();
  openedDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openedDbs.splice(0)) {
    db.close();
  }
});

function countEntities(db: Database, type: string): number {
  const row = db.query("SELECT COUNT(*) AS c FROM graph_entity WHERE type = ?").get(type) as {
    c: number;
  };
  return row.c;
}

function countRelations(db: Database, relType: string): number {
  const row = db.query("SELECT COUNT(*) AS c FROM graph_relation WHERE type = ?").get(relType) as {
    c: number;
  };
  return row.c;
}

function allRelationTypes(db: Database): string[] {
  const rows = db.query("SELECT DISTINCT type FROM graph_relation ORDER BY type").all() as Array<{
    type: string;
  }>;
  return rows.map((r) => r.type);
}

function insertPerson(db: Database, id: string, displayName: string | null): void {
  // Insert a person row so personDisplayName() can look it up.
  // person schema: id, display_name, canonical_email (no 'email' column).
  db.run(`INSERT OR IGNORE INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)`, [
    id,
    displayName,
    `${id}@example.com`,
  ]);
}

// ---------------------------------------------------------------------------
// syncGraphFromIndexedItem — top-level guards
// ---------------------------------------------------------------------------

describe("syncGraphFromIndexedItem — version guard", () => {
  test("returns early without touching graph tables when schema version < 7", () => {
    // Plain Database(":memory:") has user_version = 0 (< 7) — no migrations run
    const db = new Database(":memory:");
    // Manually create the graph_entity table so we can check it stays empty
    db.run(
      `CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT, external_id TEXT, label TEXT, service TEXT, metadata TEXT)`,
    );
    db.run(
      `CREATE TABLE graph_relation (from_id TEXT, to_id TEXT, type TEXT, weight INTEGER, created_at INTEGER)`,
    );

    syncGraphFromIndexedItem(db, {
      id: "pr:1",
      service: "github",
      type: "pr",
      title: "My PR",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });

    const count = db.query("SELECT COUNT(*) AS c FROM graph_entity").get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe("syncGraphFromIndexedItem — unknown type guard", () => {
  test("returns early for a type not in ITEM_LINKED_ENTITY_TYPES", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "blah:1",
      service: "unknown",
      type: "not_a_real_type",
      title: "Whatever",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });
    const count = db.query("SELECT COUNT(*) AS c FROM graph_entity").get() as { c: number };
    expect(count.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// syncPrGraph — branch matrix
// ---------------------------------------------------------------------------

describe("syncPrGraph", () => {
  test("PR with repo (via 'repo' key), authorId, and merged commit creates all edges", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:pull:99",
      service: "github",
      type: "pr",
      title: "Add feature",
      bodyPreview: null,
      authorId: "user:42",
      metadata: {
        repo: "acme/app",
        merged: true,
        merge_commit_sha: "deadbeef1234",
        user: "alice",
      },
    });

    expect(countEntities(db, "pr")).toBe(1);
    expect(countEntities(db, "repo")).toBe(1);
    expect(countEntities(db, "person")).toBe(1);
    expect(countEntities(db, "commit")).toBe(1);
    expect(countRelations(db, "targets")).toBe(1);
    expect(countRelations(db, "authored")).toBe(1);
    expect(countRelations(db, "merged_as")).toBe(1);
  });

  test("PR with repo via 'project' fallback (no 'repo' key)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "gitlab:mr:5",
      service: "gitlab",
      type: "pr",
      title: "MR title",
      bodyPreview: null,
      authorId: null,
      metadata: { project: "group/project" },
    });

    expect(countEntities(db, "repo")).toBe(1);
    const repoRow = db.query("SELECT external_id FROM graph_entity WHERE type = 'repo'").get() as {
      external_id: string;
    };
    expect(repoRow.external_id).toBe("gitlab:group/project");
  });

  test("PR without repo metadata creates only the pr entity (no targets edge)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:pull:7",
      service: "github",
      type: "pr",
      title: "No repo PR",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });

    expect(countEntities(db, "pr")).toBe(1);
    expect(countEntities(db, "repo")).toBe(0);
    expect(allRelationTypes(db)).not.toContain("targets");
  });

  test("PR with empty authorId string skips person entity", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:pull:8",
      service: "github",
      type: "pr",
      title: "No author",
      bodyPreview: null,
      authorId: "",
      metadata: {},
    });

    expect(countEntities(db, "person")).toBe(0);
    expect(countRelations(db, "authored")).toBe(0);
  });

  test("PR merged=false skips merged_as edge even when merge_commit_sha present", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:pull:9",
      service: "github",
      type: "pr",
      title: "Open PR",
      bodyPreview: null,
      authorId: null,
      metadata: { merged: false, merge_commit_sha: "abc123" },
    });

    expect(countRelations(db, "merged_as")).toBe(0);
  });

  test("PR merged=true but no merge_commit_sha skips merged_as edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:pull:10",
      service: "github",
      type: "pr",
      title: "Merged PR no sha",
      bodyPreview: null,
      authorId: null,
      metadata: { merged: true },
    });

    expect(countRelations(db, "merged_as")).toBe(0);
  });

  test("PR author label uses personDisplayName when person row exists with display_name", () => {
    const db = freshDb();
    insertPerson(db, "user:77", "Alice Wonderland");
    syncGraphFromIndexedItem(db, {
      id: "github:pull:11",
      service: "github",
      type: "pr",
      title: "Alice PR",
      bodyPreview: null,
      authorId: "user:77",
      metadata: {},
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("Alice Wonderland");
  });

  test("PR author label falls back to 'user' metadata when person has no display_name", () => {
    const db = freshDb();
    insertPerson(db, "user:88", null);
    syncGraphFromIndexedItem(db, {
      id: "github:pull:12",
      service: "github",
      type: "pr",
      title: "PR with user meta",
      bodyPreview: null,
      authorId: "user:88",
      metadata: { user: "bob_the_builder" },
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("bob_the_builder");
  });

  test("PR author label falls back to authorId when neither display_name nor user metadata", () => {
    const db = freshDb();
    // No person row inserted — personDisplayName returns null; no user metadata
    syncGraphFromIndexedItem(db, {
      id: "github:pull:13",
      service: "github",
      type: "pr",
      title: "PR fallback label",
      bodyPreview: null,
      authorId: "raw:user:id:99",
      metadata: {},
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("raw:user:id:99");
  });

  test("PR author label: person row exists but display_name is whitespace-only → falls back", () => {
    const db = freshDb();
    insertPerson(db, "user:55", "   ");
    syncGraphFromIndexedItem(db, {
      id: "github:pull:14",
      service: "github",
      type: "pr",
      title: "Whitespace name",
      bodyPreview: null,
      authorId: "user:55",
      metadata: { user: "trimmed_fallback" },
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("trimmed_fallback");
  });
});

// ---------------------------------------------------------------------------
// syncIssueGraph — branch matrix
// ---------------------------------------------------------------------------

describe("syncIssueGraph", () => {
  test("issue with repo and authorId creates belongs_to and opened edges", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:issue:5",
      service: "github",
      type: "issue",
      title: "Bug report",
      bodyPreview: null,
      authorId: "user:10",
      metadata: { repo: "acme/app" },
    });

    expect(countEntities(db, "issue")).toBe(1);
    expect(countEntities(db, "repo")).toBe(1);
    expect(countEntities(db, "person")).toBe(1);
    expect(countRelations(db, "belongs_to")).toBe(1);
    expect(countRelations(db, "opened")).toBe(1);
  });

  test("issue without repo metadata skips belongs_to edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:issue:6",
      service: "github",
      type: "issue",
      title: "No repo issue",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });

    expect(countEntities(db, "issue")).toBe(1);
    expect(countEntities(db, "repo")).toBe(0);
    expect(countRelations(db, "belongs_to")).toBe(0);
  });

  test("issue with empty authorId string skips person entity and opened edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:issue:7",
      service: "github",
      type: "issue",
      title: "Anonymous issue",
      bodyPreview: null,
      authorId: "",
      metadata: {},
    });

    expect(countEntities(db, "person")).toBe(0);
    expect(countRelations(db, "opened")).toBe(0);
  });

  test("issue author label: personDisplayName available", () => {
    const db = freshDb();
    insertPerson(db, "user:33", "Carol Smith");
    syncGraphFromIndexedItem(db, {
      id: "github:issue:8",
      service: "github",
      type: "issue",
      title: "Carol's issue",
      bodyPreview: null,
      authorId: "user:33",
      metadata: {},
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("Carol Smith");
  });

  test("issue author label: fallback to 'user' metadata", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:issue:9",
      service: "github",
      type: "issue",
      title: "Issue user fallback",
      bodyPreview: null,
      authorId: "no-such-person",
      metadata: { user: "dave_handle" },
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("dave_handle");
  });

  test("issue author label: fallback to authorId when no display_name or user meta", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "github:issue:10",
      service: "github",
      type: "issue",
      title: "Issue raw id",
      bodyPreview: null,
      authorId: "raw:author:id",
      metadata: {},
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("raw:author:id");
  });
});

// ---------------------------------------------------------------------------
// syncMessageGraph — branch matrix
// ---------------------------------------------------------------------------

describe("syncMessageGraph", () => {
  test("message with authorId and channel creates posted and belongs_to edges", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "slack:msg:abc",
      service: "slack",
      type: "message",
      title: "Hello world",
      bodyPreview: null,
      authorId: "user:slack:1",
      metadata: { channel: "C123GENERAL" },
    });

    expect(countEntities(db, "message")).toBe(1);
    expect(countEntities(db, "person")).toBe(1);
    expect(countEntities(db, "channel")).toBe(1);
    expect(countRelations(db, "posted")).toBe(1);
    expect(countRelations(db, "belongs_to")).toBe(1);
  });

  test("message with null authorId skips person and posted edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "slack:msg:xyz",
      service: "slack",
      type: "message",
      title: "Bot message",
      bodyPreview: null,
      authorId: null,
      metadata: { channel: "C456BOT" },
    });

    expect(countEntities(db, "message")).toBe(1);
    expect(countEntities(db, "person")).toBe(0);
    expect(countRelations(db, "posted")).toBe(0);
    expect(countRelations(db, "belongs_to")).toBe(1);
  });

  test("message without channel metadata skips channel entity and belongs_to edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "slack:msg:noc",
      service: "slack",
      type: "message",
      title: "DM message",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });

    expect(countEntities(db, "channel")).toBe(0);
    expect(countRelations(db, "belongs_to")).toBe(0);
  });

  test("message authorId uses 'user' metadata as label fallback when no display_name", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "slack:msg:meta",
      service: "slack",
      type: "message",
      title: "User meta fallback",
      bodyPreview: null,
      authorId: "unknown:person:7",
      metadata: { user: "eva_user" },
    });

    const row = db.query("SELECT label FROM graph_entity WHERE type = 'person'").get() as {
      label: string;
    };
    expect(row.label).toBe("eva_user");
  });
});

// ---------------------------------------------------------------------------
// syncGitCommitGraph — branch matrix
// ---------------------------------------------------------------------------

describe("syncGitCommitGraph", () => {
  test("git_commit without sha metadata returns early (no entities created)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:commit:no-sha",
      service: "filesystem",
      type: "git_commit",
      title: "Missing sha",
      bodyPreview: null,
      authorId: null,
      metadata: { repoRoot: "/home/user/project" },
    });

    expect(countEntities(db, "commit")).toBe(0);
  });

  test("git_commit with sha but no repoRoot creates commit entity with no in_repo edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:commit:abc",
      service: "filesystem",
      type: "git_commit",
      title: "Some commit",
      bodyPreview: null,
      authorId: null,
      metadata: { sha: "abc123def456" },
    });

    expect(countEntities(db, "commit")).toBe(1);
    expect(countEntities(db, "workspace")).toBe(0);
    expect(countRelations(db, "in_repo")).toBe(0);
  });

  test("git_commit with sha and repoRoot creates commit + workspace + in_repo edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:commit:full",
      service: "filesystem",
      type: "git_commit",
      title: "Full commit",
      bodyPreview: null,
      authorId: null,
      metadata: { sha: "deadcafe0000", repoRoot: "/home/user/project" },
    });

    expect(countEntities(db, "commit")).toBe(1);
    expect(countEntities(db, "workspace")).toBe(1);
    expect(countRelations(db, "in_repo")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// syncDependencyGraph — branch matrix
// ---------------------------------------------------------------------------

describe("syncDependencyGraph", () => {
  test("dependency without packageName returns early (no entities)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:dep:no-name",
      service: "filesystem",
      type: "dependency",
      title: "No name",
      bodyPreview: null,
      authorId: null,
      metadata: { version: "1.0.0" },
    });

    expect(countEntities(db, "package")).toBe(0);
  });

  test("dependency without version returns early (no entities)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:dep:no-ver",
      service: "filesystem",
      type: "dependency",
      title: "No version",
      bodyPreview: null,
      authorId: null,
      metadata: { packageName: "lodash" },
    });

    expect(countEntities(db, "package")).toBe(0);
  });

  test("dependency with packageName and version but no repoRoot creates package only", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:dep:lodash",
      service: "filesystem",
      type: "dependency",
      title: "lodash@4.17.21",
      bodyPreview: null,
      authorId: null,
      metadata: { packageName: "lodash", version: "4.17.21" },
    });

    expect(countEntities(db, "package")).toBe(1);
    expect(countEntities(db, "workspace")).toBe(0);
    expect(countRelations(db, "depends_on")).toBe(0);
  });

  test("dependency with packageName, version, and repoRoot creates full depends_on edge", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:dep:express",
      service: "filesystem",
      type: "dependency",
      title: "express@4.18.0",
      bodyPreview: null,
      authorId: null,
      metadata: { packageName: "express", version: "4.18.0", repoRoot: "/home/user/app" },
    });

    expect(countEntities(db, "package")).toBe(1);
    expect(countEntities(db, "workspace")).toBe(1);
    expect(countRelations(db, "depends_on")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// syncCodeSymbolGraph — branch matrix
// ---------------------------------------------------------------------------

describe("syncCodeSymbolGraph", () => {
  test("code_symbol without file returns early (no entities)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:sym:no-file",
      service: "filesystem",
      type: "code_symbol",
      title: "myFunc",
      bodyPreview: null,
      authorId: null,
      metadata: { name: "myFunc" },
    });

    expect(countEntities(db, "symbol")).toBe(0);
  });

  test("code_symbol without name returns early (no entities)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:sym:no-name",
      service: "filesystem",
      type: "code_symbol",
      title: "unknown",
      bodyPreview: null,
      authorId: null,
      metadata: { file: "src/index.ts" },
    });

    expect(countEntities(db, "symbol")).toBe(0);
  });

  test("code_symbol with file and name but no repoRoot creates symbol only", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:sym:bare",
      service: "filesystem",
      type: "code_symbol",
      title: "bareFunc",
      bodyPreview: null,
      authorId: null,
      metadata: { file: "src/util.ts", name: "bareFunc" },
    });

    expect(countEntities(db, "symbol")).toBe(1);
    const sym = db.query("SELECT label FROM graph_entity WHERE type = 'symbol'").get() as {
      label: string;
    };
    expect(sym.label).toBe("bareFunc — src/util.ts");
    expect(countEntities(db, "source_file")).toBe(0);
    expect(countRelations(db, "defined_in")).toBe(0);
  });

  test("code_symbol with file, name, and repoRoot creates symbol + source_file + workspace with defined_in and in_repo edges", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "fs:sym:full",
      service: "filesystem",
      type: "code_symbol",
      title: "fullFunc",
      bodyPreview: null,
      authorId: null,
      metadata: { file: "src/main.ts", name: "fullFunc", repoRoot: "/home/user/repo" },
    });

    expect(countEntities(db, "symbol")).toBe(1);
    expect(countEntities(db, "source_file")).toBe(1);
    expect(countEntities(db, "workspace")).toBe(1);
    expect(countRelations(db, "defined_in")).toBe(1);
    expect(countRelations(db, "in_repo")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// syncApiEndpointGraph — service_name fallback
// ---------------------------------------------------------------------------

describe("syncApiEndpointGraph", () => {
  test("api_endpoint with no service_name metadata uses 'unknown' as service label", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "openapi:ep:no-svc",
      service: "openapi",
      type: "api_endpoint",
      title: "GET /health",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });

    const svc = db
      .query("SELECT external_id, label FROM graph_entity WHERE type = 'service'")
      .get() as { external_id: string; label: string };
    expect(svc.label).toBe("unknown");
    expect(svc.external_id).toBe("openapi:service:unknown");
  });
});

// ---------------------------------------------------------------------------
// syncObsidianNoteGraph — additional branch coverage
// ---------------------------------------------------------------------------

describe("syncObsidianNoteGraph — extra branches", () => {
  test("obsidian_note with vault_id present in metadata sets vault_id in entity metadata", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "obsidian:v1#Note.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "Note",
      bodyPreview: null,
      authorId: null,
      metadata: { vault_id: "vault-abc" },
    });

    const row = db
      .query("SELECT metadata FROM graph_entity WHERE type = 'obsidian_note'")
      .get() as { metadata: string };
    const meta = JSON.parse(row.metadata) as { vault_id: string };
    expect(meta.vault_id).toBe("vault-abc");
  });

  test("obsidian_note with no vault_id in metadata falls back to 'unknown'", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "obsidian:v2#Note.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "Note2",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    });

    const row = db
      .query("SELECT metadata FROM graph_entity WHERE type = 'obsidian_note'")
      .get() as { metadata: string };
    const meta = JSON.parse(row.metadata) as { vault_id: string };
    expect(meta.vault_id).toBe("unknown");
  });

  test("obsidian_note: resolved_wikilink_ids not an array → no backlinks edges", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "obsidian:v3#Note.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "Note3",
      bodyPreview: null,
      authorId: null,
      metadata: { vault_id: "v3", resolved_wikilink_ids: "not-an-array" },
    });

    expect(countRelations(db, "backlinks")).toBe(0);
  });

  test("obsidian_note: empty-string target in wikilink_ids array is skipped", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "obsidian:v4#Note.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "Note4",
      bodyPreview: null,
      authorId: null,
      metadata: { vault_id: "v4", resolved_wikilink_ids: ["", "   "] },
    });

    expect(countRelations(db, "backlinks")).toBe(0);
  });

  test("obsidian_note: numeric entry in wikilink_ids array is skipped (not a string)", () => {
    const db = freshDb();
    syncGraphFromIndexedItem(db, {
      id: "obsidian:v5#Note.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "Note5",
      bodyPreview: null,
      authorId: null,
      metadata: { vault_id: "v5", resolved_wikilink_ids: [42, true, null] },
    });

    expect(countRelations(db, "backlinks")).toBe(0);
  });

  test("obsidian_note: target id in wikilink_ids not in DB (tgt === null) → no backlink", () => {
    const db = freshDb();
    // Target note id doesn't exist in graph_entity — tgt query returns null
    syncGraphFromIndexedItem(db, {
      id: "obsidian:v6#Note.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "Note6",
      bodyPreview: null,
      authorId: null,
      metadata: { vault_id: "v6", resolved_wikilink_ids: ["obsidian:v6#NonExistent.md"] },
    });

    expect(countRelations(db, "backlinks")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stringField — edge cases via metadata paths
// ---------------------------------------------------------------------------

describe("stringField edge cases (exercised via metadata lookup)", () => {
  test("metadata value is a number (not string) → field treated as absent", () => {
    const db = freshDb();
    // sha is a number → stringField returns undefined → syncGitCommitGraph returns early
    syncGraphFromIndexedItem(db, {
      id: "fs:commit:numeric-sha",
      service: "filesystem",
      type: "git_commit",
      title: "Numeric sha",
      bodyPreview: null,
      authorId: null,
      metadata: { sha: 12345 },
    });

    expect(countEntities(db, "commit")).toBe(0);
  });

  test("metadata value is an empty string → field treated as absent", () => {
    const db = freshDb();
    // sha is "" → stringField returns undefined → syncGitCommitGraph returns early
    syncGraphFromIndexedItem(db, {
      id: "fs:commit:empty-sha",
      service: "filesystem",
      type: "git_commit",
      title: "Empty sha",
      bodyPreview: null,
      authorId: null,
      metadata: { sha: "" },
    });

    expect(countEntities(db, "commit")).toBe(0);
  });
});
