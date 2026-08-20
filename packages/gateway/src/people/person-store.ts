import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type { PersonRecord } from "./person-types.ts";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

type PersonRow = {
  id: string;
  display_name: string | null;
  canonical_email: string | null;
  github_login: string | null;
  gitlab_login: string | null;
  slack_handle: string | null;
  linear_member_id: string | null;
  jira_account_id: string | null;
  notion_user_id: string | null;
  bitbucket_uuid?: string | null;
  microsoft_user_id?: string | null;
  discord_user_id?: string | null;
  linked: number;
  metadata: string | null;
};

function rowToRecord(row: PersonRow): PersonRecord {
  let meta: Record<string, unknown> | null = null;
  if (row.metadata != null && row.metadata !== "") {
    try {
      const p: unknown = JSON.parse(row.metadata);
      if (p !== null && typeof p === "object" && !Array.isArray(p)) {
        meta = p as Record<string, unknown>;
      }
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    displayName: row.display_name,
    canonicalEmail: row.canonical_email,
    githubLogin: row.github_login,
    gitlabLogin: row.gitlab_login,
    slackHandle: row.slack_handle,
    linearMemberId: row.linear_member_id,
    jiraAccountId: row.jira_account_id,
    notionUserId: row.notion_user_id,
    bitbucketUuid: row.bitbucket_uuid ?? null,
    microsoftUserId: row.microsoft_user_id ?? null,
    discordUserId: row.discord_user_id ?? null,
    linked: row.linked === 1,
    metadata: meta,
  };
}

export function getPersonById(db: Database, id: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE id = ?").get(id) as PersonRow | null | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByCanonicalEmail(db: Database, email: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE canonical_email = ?").get(email) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByGithubLogin(db: Database, login: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE github_login = ?").get(login) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByGitlabLogin(db: Database, login: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE gitlab_login = ?").get(login) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonBySlackHandle(db: Database, handle: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE slack_handle = ?").get(handle) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByLinearMemberId(db: Database, memberId: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE linear_member_id = ?").get(memberId) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByJiraAccountId(db: Database, accountId: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE jira_account_id = ?").get(accountId) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByNotionUserId(db: Database, userId: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE notion_user_id = ?").get(userId) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByBitbucketUuid(db: Database, uuid: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE bitbucket_uuid = ?").get(uuid) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByMicrosoftUserId(db: Database, userId: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE microsoft_user_id = ?").get(userId) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function findPersonByDiscordUserId(db: Database, userId: string): PersonRecord | null {
  const row = db.query("SELECT * FROM person WHERE discord_user_id = ?").get(userId) as
    | PersonRow
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return rowToRecord(row);
}

export function insertPerson(
  db: Database,
  row: {
    id: string;
    displayName: string | null;
    canonicalEmail: string | null;
    githubLogin: string | null;
    gitlabLogin: string | null;
    slackHandle: string | null;
    linearMemberId: string | null;
    jiraAccountId: string | null;
    notionUserId: string | null;
    bitbucketUuid?: string | null;
    microsoftUserId?: string | null;
    discordUserId?: string | null;
    linked: boolean;
    metadata: Record<string, unknown>;
  },
): void {
  const meta = JSON.stringify(row.metadata);
  dbRun(
    db,
    `INSERT INTO person (
      id, display_name, canonical_email, github_login, gitlab_login, slack_handle,
      linear_member_id, jira_account_id, notion_user_id, bitbucket_uuid, microsoft_user_id, discord_user_id,
      linked, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.displayName,
      row.canonicalEmail,
      row.githubLogin,
      row.gitlabLogin,
      row.slackHandle,
      row.linearMemberId,
      row.jiraAccountId,
      row.notionUserId,
      row.bitbucketUuid ?? null,
      row.microsoftUserId ?? null,
      row.discordUserId ?? null,
      row.linked ? 1 : 0,
      meta,
    ],
  );
}

export function updatePersonHandles(
  db: Database,
  id: string,
  patch: {
    displayName?: string | null;
    canonicalEmail?: string | null;
    githubLogin?: string | null;
    gitlabLogin?: string | null;
    slackHandle?: string | null;
    linearMemberId?: string | null;
    jiraAccountId?: string | null;
    notionUserId?: string | null;
    bitbucketUuid?: string | null;
    microsoftUserId?: string | null;
    discordUserId?: string | null;
    linked?: boolean;
  },
): void {
  db.transaction(() => {
    if (patch.displayName !== undefined) {
      dbRun(db, "UPDATE person SET display_name = ? WHERE id = ?", [patch.displayName, id]);
    }
    if (patch.canonicalEmail !== undefined) {
      dbRun(db, "UPDATE person SET canonical_email = ? WHERE id = ?", [patch.canonicalEmail, id]);
    }
    if (patch.githubLogin !== undefined) {
      dbRun(db, "UPDATE person SET github_login = ? WHERE id = ?", [patch.githubLogin, id]);
    }
    if (patch.gitlabLogin !== undefined) {
      dbRun(db, "UPDATE person SET gitlab_login = ? WHERE id = ?", [patch.gitlabLogin, id]);
    }
    if (patch.slackHandle !== undefined) {
      dbRun(db, "UPDATE person SET slack_handle = ? WHERE id = ?", [patch.slackHandle, id]);
    }
    if (patch.linearMemberId !== undefined) {
      dbRun(db, "UPDATE person SET linear_member_id = ? WHERE id = ?", [patch.linearMemberId, id]);
    }
    if (patch.jiraAccountId !== undefined) {
      dbRun(db, "UPDATE person SET jira_account_id = ? WHERE id = ?", [patch.jiraAccountId, id]);
    }
    if (patch.notionUserId !== undefined) {
      dbRun(db, "UPDATE person SET notion_user_id = ? WHERE id = ?", [patch.notionUserId, id]);
    }
    if (patch.bitbucketUuid !== undefined) {
      dbRun(db, "UPDATE person SET bitbucket_uuid = ? WHERE id = ?", [patch.bitbucketUuid, id]);
    }
    if (patch.microsoftUserId !== undefined) {
      dbRun(db, "UPDATE person SET microsoft_user_id = ? WHERE id = ?", [
        patch.microsoftUserId,
        id,
      ]);
    }
    if (patch.discordUserId !== undefined) {
      dbRun(db, "UPDATE person SET discord_user_id = ? WHERE id = ?", [patch.discordUserId, id]);
    }
    if (patch.linked !== undefined) {
      dbRun(db, "UPDATE person SET linked = ? WHERE id = ?", [patch.linked ? 1 : 0, id]);
    }
  })();
}

export type PersonListQueryParams = {
  readonly unlinkedOnly?: boolean;
  readonly limit: number;
  /**
   * Restrict via `id IN (<sql>)` where `<sql>` is a caller-supplied SELECT — e.g. a negation
   * predicate's own query (`buildNotReviewedSql`), embedded as a subquery rather than
   * materialised into a bind-parameter list. Mirrors `ItemListQueryParams.idInSql`
   * (`index/item-list-query.ts`) for the same reason: a large matching set must not hit SQLite's
   * per-statement bind-parameter ceiling.
   *
   * `sql` MUST use only plain, unnumbered `?` placeholders — never `?1`-style numbered ones, for
   * the same desynchronization reason documented there. A predicate built with numbered
   * placeholders must be renumbered first (see `toPositionalSubquery` in
   * `index/negation-predicates.ts`).
   */
  readonly idInSql?: { readonly sql: string; readonly vals: readonly (string | number)[] };
};

/**
 * Builds the `listPersons` query without running it, so a caller (`ipc/people-rpc.ts`'s
 * `--explain`) can report the exact SQL/params that shaped a result without a second, drifting
 * copy of the query text. `listPersons` itself is this function plus execution — the same split
 * `buildItemListSql` / `LocalIndex.listItems` uses for items.
 */
export function buildPersonListSql(params: PersonListQueryParams): {
  sql: string;
  vals: Array<string | number>;
} {
  const lim = Math.min(500, Math.max(1, params.limit));
  const filters: string[] = [];
  const vals: Array<string | number> = [];
  if (params.unlinkedOnly === true) {
    filters.push("linked = 0");
  }
  if (params.idInSql !== undefined) {
    filters.push(`id IN (${params.idInSql.sql})`);
    vals.push(...params.idInSql.vals);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM person ${where} ORDER BY id LIMIT ?`;
  vals.push(lim);
  return { sql, vals };
}

export function listPersons(db: Database, options: PersonListQueryParams): PersonRecord[] {
  const { sql, vals } = buildPersonListSql(options);
  const rows = db.query(sql).all(...vals) as PersonRow[];
  return rows.map(rowToRecord);
}

export function searchPersons(db: Database, query: string, limit: number): PersonRecord[] {
  const lim = Math.min(100, Math.max(1, limit));
  const q = query.trim().toLowerCase();
  if (q === "") {
    return listPersons(db, { limit: lim });
  }
  const rows = db
    .query(
      `SELECT * FROM person WHERE
        instr(lower(coalesce(display_name, '')), ?) > 0 OR
        instr(lower(coalesce(canonical_email, '')), ?) > 0 OR
        instr(lower(coalesce(github_login, '')), ?) > 0 OR
        instr(lower(coalesce(gitlab_login, '')), ?) > 0 OR
        instr(lower(coalesce(slack_handle, '')), ?) > 0 OR
        instr(lower(coalesce(linear_member_id, '')), ?) > 0 OR
        instr(lower(coalesce(jira_account_id, '')), ?) > 0 OR
        instr(lower(coalesce(notion_user_id, '')), ?) > 0 OR
        instr(lower(coalesce(bitbucket_uuid, '')), ?) > 0 OR
        instr(lower(coalesce(microsoft_user_id, '')), ?) > 0 OR
        instr(lower(coalesce(discord_user_id, '')), ?) > 0
      ORDER BY id LIMIT ?`,
    )
    .all(q, q, q, q, q, q, q, q, q, q, q, lim) as PersonRow[];
  return rows.map(rowToRecord);
}

export function countItemsByAuthor(db: Database, personId: string): number {
  const row = db.query("SELECT COUNT(*) as c FROM item WHERE author_id = ?").get(personId) as
    | { c: number }
    | null
    | undefined;
  const c = row?.c;
  return typeof c === "number" && Number.isFinite(c) ? Math.floor(c) : 0;
}

export function deletePersonById(db: Database, id: string): void {
  dbRun(db, "DELETE FROM person WHERE id = ?", [id]);
}
