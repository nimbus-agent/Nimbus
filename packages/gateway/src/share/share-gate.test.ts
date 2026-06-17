import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { createShare } from "./share-gate.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async () => {},
    listKeys: async () => [...m.keys()],
  };
}
const audit: { actionType: string; hitlStatus: string }[] = [];
function deps(approve: boolean, db: Database) {
  return {
    db,
    vault: fakeVault(),
    label: "Asaf",
    now: () => 1000,
    collectSession: () => ({
      turns: [{ role: "user" as const, text: "ping alice@corp.com", timestamp: 1 }],
      toolCalls: [],
    }),
    buildRecipe: () =>
      ({
        recipeVersion: 1,
        sourceSessionId: "s1",
        generatedAt: 1,
        steps: [],
        graphTraversals: [],
      }) as unknown,
    requestApproval: async () => approve,
    recordAudit: (e: { actionType: string; hitlStatus: string }) => audit.push(e),
  };
}

describe("createShare (I27 gate)", () => {
  test("rejected approval => no file, audit records rejected, nothing persisted", async () => {
    audit.length = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const r = await createShare(
      { sessionId: "s1", kind: "transcript", sink: { type: "file" } },
      deps(false, db),
    );
    expect(r.status).toBe("rejected");
    expect(audit.at(-1)).toMatchObject({ actionType: "share.publish", hitlStatus: "rejected" });
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 0 });
  });
  test("approved => redacted+signed share returned, persisted, audit approved", async () => {
    audit.length = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const r = await createShare(
      { sessionId: "s1", kind: "transcript", sink: { type: "file" } },
      deps(true, db),
    );
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r.share)).not.toContain("alice@corp.com");
    expect(r.share?.body.redactionSet).toContain("emails");
    expect(audit.at(-1)).toMatchObject({ actionType: "share.publish", hitlStatus: "approved" });
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 1 });
  });

  test("recipe kind: redacts the recipe, sets body.recipe, omits turns/toolCalls", async () => {
    audit.length = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const recipe = {
      recipeVersion: 1,
      sourceSessionId: "s1",
      generatedAt: 1,
      graphTraversals: [],
      steps: [
        {
          stepId: "step-1",
          tool: "gmail_search",
          service: "gmail",
          status: "ok",
          dependsOn: [],
          params: { q: "from:ceo@corp.com" },
        },
      ],
    };
    let previewed: unknown;
    const d = {
      ...deps(true, db),
      buildRecipe: () => recipe as unknown,
      requestApproval: async (preview: unknown) => {
        previewed = preview;
        return true;
      },
    };
    const result = await createShare(
      { sessionId: "s1", kind: "recipe", sink: { type: "file" } },
      d,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.share.body.kind).toBe("recipe");
    expect(result.share.body.turns).toBeUndefined();
    expect(result.share.body.toolCalls).toBeUndefined();
    const body = result.share.body.recipe as { steps: { params: { q: string } }[] };
    // The email within the query string is redacted (substring replacement); the prefix is preserved.
    expect(body.steps[0]?.params.q).toContain("[REDACTED]");
    expect(body.steps[0]?.params.q).not.toContain("ceo@corp.com");
    expect(JSON.stringify(previewed)).toContain("[REDACTED]");
    expect(JSON.stringify(previewed)).not.toContain("ceo@corp.com");
    expect(result.share.body.redactionSet).toContain("emails");
  });

  test("recipe kind: a rejected approval emits nothing", async () => {
    audit.length = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const d = {
      ...deps(false, db),
      buildRecipe: () =>
        ({
          recipeVersion: 1,
          sourceSessionId: "s1",
          generatedAt: 1,
          steps: [],
          graphTraversals: [],
        }) as unknown,
      requestApproval: async () => false,
    };
    const result = await createShare(
      { sessionId: "s1", kind: "recipe", sink: { type: "file" } },
      d,
    );
    expect(result.status).toBe("rejected");
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 0 });
  });
});
