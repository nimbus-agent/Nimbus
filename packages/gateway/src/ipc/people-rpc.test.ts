import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../test/helpers/rpc-harness.ts";
import { insertPerson } from "../people/person-store.ts";
import { dispatchPeopleRpc, PeopleRpcError } from "./people-rpc.ts";

function seedItem(
  db: Database,
  args: {
    id: string;
    service: string;
    externalId: string;
    authorId: string | null;
    modifiedAt?: number;
    title?: string;
  },
): void {
  const mt = args.modifiedAt ?? 1_700_000_000_000;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [args.id, args.service, "doc", args.externalId, args.title ?? "doc", mt, mt, args.authorId],
  );
}

function seedPerson(
  db: Database,
  overrides: {
    id: string;
    displayName?: string | null;
    canonicalEmail?: string | null;
    githubLogin?: string | null;
    slackHandle?: string | null;
    linked?: boolean;
    metadata?: Record<string, unknown>;
  },
): void {
  insertPerson(db, {
    id: overrides.id,
    displayName: overrides.displayName ?? null,
    canonicalEmail: overrides.canonicalEmail ?? null,
    githubLogin: overrides.githubLogin ?? null,
    gitlabLogin: null,
    slackHandle: overrides.slackHandle ?? null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    bitbucketUuid: null,
    microsoftUserId: null,
    discordUserId: null,
    linked: overrides.linked ?? true,
    metadata: overrides.metadata ?? {},
  });
}

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function call(method: string, params: unknown): { kind: "hit"; value: unknown } | { kind: "miss" } {
  return dispatchPeopleRpc({ method, params, localIndex: fixture.localIndex });
}

describe("dispatchPeopleRpc — routing", () => {
  test("unknown method returns miss", () => {
    const r = call("people.unknown", {});
    expect(r.kind).toBe("miss");
  });
});

describe("requireString — error paths", () => {
  test("missing params (undefined rec) -> -32602", () => {
    expect(() => call("people.get", null)).toThrow(PeopleRpcError);
    try {
      call("people.get", null);
    } catch (e) {
      expect(e).toBeInstanceOf(PeopleRpcError);
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("missing key -> -32602", () => {
    try {
      call("people.get", { wrong: "key" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("id");
    }
  });

  test("non-string value -> -32602", () => {
    try {
      call("people.get", { id: 42 });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("whitespace-only string -> -32602", () => {
    try {
      call("people.get", { id: "   " });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });
});

describe("optionalLimit — error paths", () => {
  test("non-number limit -> -32602", () => {
    try {
      call("people.list", { limit: "twenty" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("limit");
    }
  });

  test("non-finite (Infinity) -> -32602", () => {
    try {
      call("people.list", { limit: Number.POSITIVE_INFINITY });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("NaN -> -32602", () => {
    try {
      call("people.list", { limit: Number.NaN });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
    }
  });

  test("missing key falls back to default (no throw)", () => {
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
  });

  test("undefined rec falls back to default", () => {
    const r = call("people.list", null);
    expect(r.kind).toBe("hit");
  });

  test("float limit is floored", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    seedPerson(fixture.db, { id: "p2", displayName: "B" });
    const r = call("people.list", { limit: 1.9 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(1);
  });
});

describe("people.get", () => {
  test("known id returns full record with item count", () => {
    seedPerson(fixture.db, {
      id: "p1",
      displayName: "Asaf",
      canonicalEmail: "asaf@example.com",
      githubLogin: "asaf",
      metadata: { source: "test" },
    });
    seedItem(fixture.db, { id: "github:i1", service: "github", externalId: "i1", authorId: "p1" });
    seedItem(fixture.db, { id: "github:i2", service: "github", externalId: "i2", authorId: "p1" });
    const r = call("people.get", { id: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as Record<string, unknown>;
    expect(v["id"]).toBe("p1");
    expect(v["displayName"]).toBe("Asaf");
    expect(v["canonicalEmail"]).toBe("asaf@example.com");
    expect(v["githubLogin"]).toBe("asaf");
    expect(v["itemCount"]).toBe(2);
    expect(v["metadata"]).toEqual({ source: "test" });
  });

  test("unknown id returns null", () => {
    const r = call("people.get", { id: "missing" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toBeNull();
  });

  test("trim is applied to id", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.get", { id: "  p1  " });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect((r.value as Record<string, unknown>)["id"]).toBe("p1");
  });
});

describe("people.list", () => {
  test("returns persons in id order with item counts", () => {
    seedPerson(fixture.db, { id: "p2", displayName: "Bea" });
    seedPerson(fixture.db, { id: "p1", displayName: "Alice" });
    seedItem(fixture.db, { id: "github:i1", service: "github", externalId: "i1", authorId: "p1" });
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list.map((p) => p["id"])).toEqual(["p1", "p2"]);
    expect(list[0]?.["itemCount"]).toBe(1);
    expect(list[1]?.["itemCount"]).toBe(0);
  });

  test("unlinkedOnly: true filters out linked persons", () => {
    seedPerson(fixture.db, { id: "p_linked", linked: true });
    seedPerson(fixture.db, { id: "p_unlinked", linked: false });
    const r = call("people.list", { unlinkedOnly: true });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.["id"]).toBe("p_unlinked");
  });

  test("unlinkedOnly: false is treated as full list", () => {
    seedPerson(fixture.db, { id: "p_linked", linked: true });
    seedPerson(fixture.db, { id: "p_unlinked", linked: false });
    const r = call("people.list", { unlinkedOnly: false });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });

  test("metadata defaults to {} when person.metadata is empty", () => {
    seedPerson(fixture.db, { id: "p1" });
    const r = call("people.list", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list[0]?.["metadata"]).toEqual({});
  });
});

describe("people.unlinked", () => {
  test("returns only unlinked", () => {
    seedPerson(fixture.db, { id: "p_a", linked: false });
    seedPerson(fixture.db, { id: "p_b", linked: true });
    seedPerson(fixture.db, { id: "p_c", linked: false });
    const r = call("people.unlinked", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list.map((p) => p["id"]).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "p_a",
      "p_c",
    ]);
  });

  test("honors custom limit", () => {
    seedPerson(fixture.db, { id: "p_a", linked: false });
    seedPerson(fixture.db, { id: "p_b", linked: false });
    seedPerson(fixture.db, { id: "p_c", linked: false });
    const r = call("people.unlinked", { limit: 2 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });
});

describe("people.search", () => {
  test("query filter matches displayName", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "Alice Wonder" });
    seedPerson(fixture.db, { id: "p2", displayName: "Bob Smith" });
    const r = call("people.search", { query: "alice" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const list = r.value as Array<Record<string, unknown>>;
    expect(list.map((p) => p["id"])).toEqual(["p1"]);
  });

  test("empty query falls back to list-all", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    seedPerson(fixture.db, { id: "p2", displayName: "B" });
    const r = call("people.search", { query: "" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });

  test("missing query is treated as empty", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.search", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(1);
  });

  test("non-string query is treated as empty", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.search", { query: 42 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(1);
  });
});

describe("people.items", () => {
  test("returns items for a known person, ordered by modified_at DESC", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    seedItem(fixture.db, {
      id: "github:i_old",
      service: "github",
      externalId: "i_old",
      authorId: "p1",
      modifiedAt: 1_000,
    });
    seedItem(fixture.db, {
      id: "github:i_new",
      service: "github",
      externalId: "i_new",
      authorId: "p1",
      modifiedAt: 5_000,
    });
    seedItem(fixture.db, {
      id: "github:i_other",
      service: "github",
      externalId: "i_other",
      authorId: "p_other",
    });
    const r = call("people.items", { personId: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const items = r.value as Array<Record<string, unknown>>;
    expect(items.map((i) => i["id"])).toEqual(["i_new", "i_old"]);
  });

  test("returns empty array for a known person with no items", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.items", { personId: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual([]);
  });

  test("unknown personId throws -32602", () => {
    try {
      call("people.items", { personId: "missing" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("Unknown person id");
    }
  });

  test("custom limit is honored", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    for (let i = 0; i < 5; i++) {
      seedItem(fixture.db, {
        id: `github:i${i}`,
        service: "github",
        externalId: `i${i}`,
        authorId: "p1",
        modifiedAt: 1_000 + i,
      });
    }
    const r = call("people.items", { personId: "p1", limit: 2 });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value as unknown[]).toHaveLength(2);
  });
});

describe("people.merge", () => {
  test("same id returns survivor without throwing", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    const r = call("people.merge", { personIdA: "p1", personIdB: "p1" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { survivorId: string; person: Record<string, unknown> };
    expect(v.survivorId).toBe("p1");
    expect(v.person["id"]).toBe("p1");
  });

  test("unknown person id -> -32602", () => {
    seedPerson(fixture.db, { id: "p1", displayName: "A" });
    try {
      call("people.merge", { personIdA: "p1", personIdB: "missing" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("unknown person id");
    }
  });

  test("conflicting canonical emails -> -32602", () => {
    seedPerson(fixture.db, { id: "p1", canonicalEmail: "a@example.com" });
    seedPerson(fixture.db, { id: "p2", canonicalEmail: "b@example.com" });
    try {
      call("people.merge", { personIdA: "p1", personIdB: "p2" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32602);
      expect((e as PeopleRpcError).message).toContain("conflicting canonical emails");
    }
  });

  test("happy path merges handles and reassigns items (both emails null)", () => {
    seedPerson(fixture.db, {
      id: "p_keep",
      displayName: "Keeper",
      githubLogin: null,
      linked: false,
    });
    seedPerson(fixture.db, {
      id: "p_drop",
      displayName: "Other",
      githubLogin: "ghuser",
      linked: true,
    });
    seedItem(fixture.db, {
      id: "github:i1",
      service: "github",
      externalId: "i1",
      authorId: "p_drop",
    });
    const r = call("people.merge", { personIdA: "p_keep", personIdB: "p_drop" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const v = r.value as { survivorId: string; person: Record<string, unknown> };
    expect(v.survivorId).toBe("p_keep");
    expect(v.person["githubLogin"]).toBe("ghuser");
    expect(v.person["canonicalEmail"]).toBeNull();
    expect(v.person["linked"]).toBe(true);
    expect(v.person["itemCount"]).toBe(1);

    const dropRow = fixture.db.query("SELECT id FROM person WHERE id = ?").get("p_drop") as {
      id: string;
    } | null;
    expect(dropRow).toBeNull();
  });

  test("UNIQUE-constraint conflict surfaces as -32603 (catchall)", () => {
    seedPerson(fixture.db, { id: "p_keep" });
    seedPerson(fixture.db, { id: "p_drop", canonicalEmail: "x@example.com" });
    try {
      call("people.merge", { personIdA: "p_keep", personIdB: "p_drop" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PeopleRpcError).rpcCode).toBe(-32603);
    }
  });
});
