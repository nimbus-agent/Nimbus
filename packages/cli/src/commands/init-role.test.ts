import { describe, expect, test } from "bun:test";

import {
  connectorSuggestions,
  parseRoleFlag,
  RoleFlagError,
  type RoleStepDeps,
  resolveRole,
  roleChoices,
  runRoleStep,
} from "./init-role.ts";

// Shaped like the gateway's real `pack.list` reply (`packs/pack-install.ts` `PackListResult`):
// installed rows carry `visibleAgents`/`sourceMappings`/`roles`/`suggestedConnectors`; available
// rows carry `description`/`roles`/`suggestedConnectors`.
const AVAILABLE_PM = {
  id: "pm",
  name: "Product",
  version: "1.0.0",
  description: "Decisions, glossary and catch-up for product work.",
  roles: ["product"],
  suggestedConnectors: ["slack", "jira", "notion", "google_drive"],
};
const AVAILABLE_DEVOPS = {
  id: "devops",
  name: "DevOps",
  version: "1.1.0",
  description: "On-call and delivery.",
  roles: ["devops", "sre"],
  suggestedConnectors: ["pagerduty", "github"],
};
const INSTALLED_PM = {
  id: "pm",
  name: "Product",
  version: "1.0.0",
  source: "bundled",
  updateAvailable: false,
  visibleAgents: ["decisions", "glossary", "catchup"],
  sourceMappings: [],
  roles: ["product"],
  suggestedConnectors: ["slack", "jira", "notion", "google_drive"],
};

const listNone = {
  profile: "default",
  installed: [],
  available: [AVAILABLE_PM, AVAILABLE_DEVOPS],
  skipped: [],
};
const listPm = {
  profile: "default",
  installed: [INSTALLED_PM],
  available: [AVAILABLE_DEVOPS],
  skipped: [],
};

const CATALOG = {
  agents: [],
  connectors: [
    { kind: "builtin", id: "slack", displayName: "Slack", signIn: "browser" },
    { kind: "builtin", id: "jira", displayName: "Jira", signIn: "atlassian" },
    { kind: "builtin", id: "notion", displayName: "Notion", signIn: "browser" },
    { kind: "builtin", id: "google_drive", displayName: "Google Drive", signIn: "browser" },
  ],
  suggestedConnectors: ["slack", "jira", "notion", "google_drive"],
  visibility: { basis: "packs", packs: ["pm"], notes: [] },
};
const NEUTRAL_CATALOG = { ...CATALOG, suggestedConnectors: ["google_drive", "slack"] };

describe("parseRoleFlag", () => {
  test("absent → undefined; a value → it", () => {
    expect(parseRoleFlag([])).toBeUndefined();
    expect(parseRoleFlag(["--no-detect", "--role", "product"])).toBe("product");
  });
  test("a missing or malformed value is a usage error", () => {
    expect(() => parseRoleFlag(["--role"])).toThrow(RoleFlagError);
    expect(() => parseRoleFlag(["--role", "Bad!"])).toThrow(RoleFlagError);
    expect(() => parseRoleFlag(["--role", "--no-sync"])).toThrow(RoleFlagError);
  });
});

describe("roleChoices / resolveRole", () => {
  test("one choice per pack, then Engineering, Design, Something else", () => {
    const c = roleChoices(listNone);
    expect(c.map((x) => x.label)).toEqual([
      "Product",
      "DevOps",
      "Engineering",
      "Design",
      "Something else",
    ]);
    expect(c[0]).toEqual({
      value: "pack:pm",
      label: "Product",
      hint: "Decisions, glossary and catch-up for product work.",
    });
  });

  test("an installed pack is listed once, first", () => {
    expect(roleChoices(listPm).map((x) => x.value)).toEqual([
      "pack:pm",
      "pack:devops",
      "engineering",
      "design",
      "other",
    ]);
  });

  test("a malformed reply leaves only the fixed choices", () => {
    expect(roleChoices("nope").map((x) => x.value)).toEqual(["engineering", "design", "other"]);
    expect(roleChoices({ installed: [{ id: 3 }], available: "x" })).toHaveLength(3);
  });

  test("resolves a role tag, an id, pack:<id> and the fixed roles; unknown → undefined", () => {
    expect(resolveRole("product", listNone)).toEqual({
      kind: "pack",
      packId: "pm",
      name: "Product",
      installed: false,
    });
    expect(resolveRole("pm", listPm)).toMatchObject({ packId: "pm", installed: true });
    expect(resolveRole("pack:devops", listNone)).toMatchObject({ packId: "devops" });
    expect(resolveRole("sre", listNone)).toMatchObject({ packId: "devops" });
    expect(resolveRole("engineering", listNone)).toEqual({ kind: "engineering" });
    expect(resolveRole("other", listNone)).toEqual({ kind: "other" });
    expect(resolveRole("bogus", listNone)).toBeUndefined();
  });
});

describe("connectorSuggestions", () => {
  test("keeps the catalog's order and marks connected from listStatus", () => {
    const rows = connectorSuggestions(CATALOG, [
      { serviceId: "slack", healthState: "healthy" },
      { serviceId: "jira", healthState: "unauthenticated" },
      { serviceId: "notion" },
    ]);
    expect(rows).toEqual([
      { id: "slack", displayName: "Slack", signIn: "browser", connected: true },
      { id: "jira", displayName: "Jira", signIn: "atlassian", connected: false },
      { id: "notion", displayName: "Notion", signIn: "browser", connected: false },
      { id: "google_drive", displayName: "Google Drive", signIn: "browser", connected: false },
    ]);
  });

  test("an id the catalog does not describe falls back to its id and terminal sign-in", () => {
    expect(connectorSuggestions({ connectors: [], suggestedConnectors: ["x"] }, "bad")).toEqual([
      { id: "x", displayName: "x", signIn: "terminal", connected: false },
    ]);
  });
});

type Rec = {
  log: string[];
  err: string[];
  calls: string[];
  installed: string[];
  confirmed: string[];
  authed: string[];
};

function deps(
  over: Partial<RoleStepDeps> & {
    packList?: unknown[];
    catalog?: unknown;
    pick?: string | undefined;
    installCode?: number;
    confirm?: boolean;
  } = {},
): { deps: RoleStepDeps; rec: Rec } {
  const rec: Rec = { log: [], err: [], calls: [], installed: [], confirmed: [], authed: [] };
  const lists = [...(over.packList ?? [listNone, listPm])];
  const d: RoleStepDeps = {
    interactive: true,
    log: (l) => rec.log.push(l),
    error: (l) => rec.err.push(l),
    call: async (method) => {
      rec.calls.push(method);
      if (method === "pack.list") return lists.length > 1 ? lists.shift() : lists[0];
      if (method === "catalog.list") return over.catalog ?? CATALOG;
      if (method === "connector.listStatus")
        return [{ serviceId: "slack", healthState: "healthy" }];
      throw new Error(`unexpected ${method}`);
    },
    selectRole: async () => ("pick" in over ? over.pick : "pack:pm"),
    installPack: async (id) => {
      rec.installed.push(id);
      return over.installCode ?? 0;
    },
    confirmConnect: async (name) => {
      rec.confirmed.push(name);
      return over.confirm ?? true;
    },
    connectorAuth: async (id) => {
      rec.authed.push(id);
    },
    ...over,
  };
  return { deps: d, rec };
}

describe("runRoleStep", () => {
  test("Product, not installed, interactive: installs, lists suggestions, offers browser sign-in, names decisions", async () => {
    const { deps: d, rec } = deps();
    const answer = await runRoleStep(undefined, d);
    expect(answer).toMatchObject({ kind: "pack", packId: "pm" });
    expect(rec.installed).toEqual(["pm"]);
    const out = rec.log.join("\n");
    expect(out).toContain("Connectors for Product:");
    expect(out).toContain("  Slack  connected");
    expect(out).toContain("  Jira  not connected — nimbus connector auth jira");
    // Slack is connected and Jira signs in with a form: only Notion and Google Drive are offered.
    expect(rec.confirmed).toEqual(["Notion", "Google Drive"]);
    expect(rec.authed).toEqual(["notion", "google_drive"]);
    expect(out).toContain(
      "Nimbus looks for decisions after your connectors sync: nimbus decisions",
    );
  });

  test("a declined install says so and still lists (neutral) connectors", async () => {
    const { deps: d, rec } = deps({
      installCode: 1,
      packList: [listNone, listNone],
      catalog: NEUTRAL_CATALOG,
    });
    await runRoleStep(undefined, d);
    const out = rec.log.join("\n");
    expect(out).toContain("The Product pack was not installed; continuing without it.");
    expect(out).toContain("Connectors for getting started:");
    expect(out).not.toContain("nimbus decisions");
  });

  test("non-interactive with a pack --role: never installs, prints the next step", async () => {
    const { deps: d, rec } = deps({ interactive: false, packList: [listNone, listNone] });
    await runRoleStep("product", d);
    expect(rec.installed).toEqual([]);
    expect(rec.confirmed).toEqual([]);
    expect(rec.log).toContain("Next: nimbus pack install pm");
  });

  test("an already-installed pack is not re-installed", async () => {
    const { deps: d, rec } = deps({ packList: [listPm] });
    await runRoleStep("product", d);
    expect(rec.installed).toEqual([]);
    expect(rec.log).toContain("The Product pack is already installed.");
  });

  test("a cancelled question is Something else: neutral connectors, no pack calls", async () => {
    const { deps: d, rec } = deps({ pick: undefined, catalog: NEUTRAL_CATALOG });
    expect(await runRoleStep(undefined, d)).toEqual({ kind: "other" });
    expect(rec.installed).toEqual([]);
    expect(rec.log).toContain("Connectors for getting started:");
  });

  test("Design: neutral header, no install", async () => {
    const { deps: d, rec } = deps({ pick: "design", catalog: NEUTRAL_CATALOG });
    expect(await runRoleStep(undefined, d)).toEqual({ kind: "design" });
    expect(rec.installed).toEqual([]);
    expect(rec.log).toContain("Connectors for getting started:");
  });

  test("Engineering returns before any connector step", async () => {
    const { deps: d, rec } = deps({ pick: "engineering" });
    expect(await runRoleStep(undefined, d)).toEqual({ kind: "engineering" });
    expect(rec.calls).toEqual(["pack.list"]);
  });

  test("non-interactive with no flag is neutral and asks nothing", async () => {
    let asked = 0;
    const { deps: d, rec } = deps({
      interactive: false,
      catalog: NEUTRAL_CATALOG,
      selectRole: async () => {
        asked += 1;
        return "pack:pm";
      },
    });
    expect(await runRoleStep(undefined, d)).toEqual({ kind: "other" });
    expect(asked).toBe(0);
    expect(rec.confirmed).toEqual([]);
  });

  test("an unknown --role changes nothing and names what is accepted", async () => {
    const { deps: d, rec } = deps();
    const r = await runRoleStep("bogus", d);
    expect(r).toEqual({
      kind: "unknown-role",
      message:
        'nimbus init: unknown --role "bogus". Use one of: pm, product, devops, sre, engineering, design, other.',
    });
    expect(rec.calls).toEqual(["pack.list"]);
    expect(rec.installed).toEqual([]);
  });

  test("a failed browser sign-in is reported and the next one is still offered", async () => {
    const { deps: d, rec } = deps({
      connectorAuth: async (id) => {
        if (id === "notion") throw new Error("Missing OAuth client id for notion");
      },
    });
    await runRoleStep(undefined, d);
    expect(rec.err).toEqual(["  Notion: Missing OAuth client id for notion"]);
    expect(rec.confirmed).toEqual(["Notion", "Google Drive"]);
    expect(rec.log).toContain("  Google Drive: connected.");
  });

  test("a declined sign-in offer is skipped", async () => {
    const { deps: d, rec } = deps({ confirm: false });
    await runRoleStep(undefined, d);
    expect(rec.authed).toEqual([]);
  });
});
