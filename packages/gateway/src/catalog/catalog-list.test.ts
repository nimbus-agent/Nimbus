import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertExtensionRow } from "../automation/extension-store.ts";
import { mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { insertUserMcpConnector } from "../connectors/user-mcp-store.ts";
import { upsertRunGrant } from "../extensions/run-grant-store.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { buildCatalogList, NEUTRAL_SUGGESTED_CONNECTORS } from "./catalog-list.ts";

/** The two presentation deps the RPC supplies; neutral values unless a test is about them. */
const EXTRAS = {
  signInFor: (): "terminal" => "terminal",
  packSuggestions: [] as readonly string[],
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function setup(): { db: Database; root: string } {
  const db = openMigratedMemoryDb();
  const root = mkdtempSync(join(tmpdir(), "nimbus-catalog-list-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  return { db, root };
}

function snapshotOf(agentsBody: string): () => { doc: ReturnType<typeof mergeLayerDocs> } {
  const doc = mergeLayerDocs([
    parseLayerDoc(
      { kind: "base", id: "base", path: "/virtual/base.toml" },
      `[agents]\n${agentsBody}\n`,
    ),
  ]);
  return () => ({ doc });
}

function addExtension(
  db: Database,
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  opts: { tamper?: boolean } = {},
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const bytes = JSON.stringify({ id, version: "1.0.0", entry: "dist/index.js", ...manifest });
  writeFileSync(join(dir, "nimbus.extension.json"), bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: dir,
    manifest_hash: hash,
    entry_hash: "0".repeat(64),
    installed_at: 1,
    last_verified_at: 1,
  });
  if (opts.tamper === true) {
    writeFileSync(join(dir, "nimbus.extension.json"), `${bytes} `);
  }
}

describe("buildCatalogList", () => {
  test("lists every agent with visible from the snapshot", () => {
    const { db } = setup();
    const r = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf('hide = ["decisions"]') });
    expect(r.agents).toHaveLength(17);
    expect(r.agents.find((a) => a.name === "decisions")?.visible).toBe(false);
    expect(r.agents.find((a) => a.name === "oncall")?.visible).toBe(true);
    expect(r.visibility.basis).toBe("all");
  });

  test("lists builtins, then extensions, then user MCP servers", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.example.b", { name: "B" });
    addExtension(db, root, "com.example.a", { name: "A" });
    insertUserMcpConnector(db, {
      service_id: "mcp_zeta",
      command: "x",
      args_json: "[]",
      read_paths_json: "[]",
      net_hosts_json: "[]",
      model_access: 0,
    });
    insertUserMcpConnector(db, {
      service_id: "mcp_alpha",
      command: "x",
      args_json: "[]",
      read_paths_json: "[]",
      net_hosts_json: "[]",
      model_access: 0,
    });
    const { connectors } = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") });
    const kinds = connectors.map((c) => c.kind);
    const firstExt = kinds.indexOf("extension");
    const firstMcp = kinds.indexOf("user-mcp");
    expect(kinds.slice(0, firstExt).every((k) => k === "builtin")).toBe(true);
    expect(firstExt).toBeGreaterThan(0);
    expect(connectors.slice(firstExt).map((c) => c.id)).toEqual([
      "com.example.a",
      "com.example.b",
      "mcp_alpha",
      "mcp_zeta",
    ]);
    expect(firstMcp).toBe(firstExt + 2);
    const builtinIds = connectors.slice(0, firstExt).map((c) => c.id);
    expect(builtinIds).toEqual([...builtinIds].sort());
  });

  test("an extension whose manifest fails verification is listed with name null", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.example.t", { name: "Tampered" }, { tamper: true });
    const ext = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") }).connectors.find(
      (c) => c.id === "com.example.t",
    );
    expect(ext).toMatchObject({ kind: "extension", name: null, serviceId: null });
  });

  test("an extension whose manifest name is blank is listed with name null", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.example.blank", { name: "  " });
    const ext = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") }).connectors.find(
      (c) => c.id === "com.example.blank",
    );
    expect(ext).toMatchObject({ kind: "extension", name: null });
  });

  test("a verified manifest name is trimmed and cut to 200 characters", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.example.long", { name: ` ${"n".repeat(300)} ` });
    const ext = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") }).connectors.find(
      (c) => c.id === "com.example.long",
    );
    expect(ext).toMatchObject({ name: "n".repeat(200) });
  });

  test("an approved extension carries its run grant's service id", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.example.run", { name: "Runner" });
    upsertRunGrant(db, {
      extension_id: "com.example.run",
      service_id: "ext_run",
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    const ext = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") }).connectors.find(
      (c) => c.id === "com.example.run",
    );
    expect(ext).toMatchObject({ serviceId: "ext_run", name: "Runner" });
  });

  test("an installed unbundled connector is listed once, as an extension, never as built in", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.nimbus.readwise", { name: "Readwise" });
    const { connectors } = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") });
    const builtinIds = connectors.filter((c) => c.kind === "builtin").map((c) => c.id);
    expect(builtinIds).not.toContain("readwise");
    const matches = connectors.filter((c) => /readwise/i.test(c.id));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: "extension",
      id: "com.nimbus.readwise",
      name: "Readwise",
    });
  });
});

describe("buildCatalogList — onboarding suggestions and sign-in", () => {
  test("suggestedConnectors is the neutral default when no pack suggests any", () => {
    const { db } = setup();
    const r = buildCatalogList({ ...EXTRAS, db, snapshot: snapshotOf("") });
    expect(r.suggestedConnectors).toEqual([...NEUTRAL_SUGGESTED_CONNECTORS]);
    expect([...NEUTRAL_SUGGESTED_CONNECTORS]).toEqual([
      "google_drive",
      "slack",
      "notion",
      "gmail",
      "github",
      "linear",
    ]);
  });

  test("pack suggestions replace the neutral default, in order, and unknown ids are dropped", () => {
    const { db } = setup();
    const r = buildCatalogList({
      ...EXTRAS,
      db,
      snapshot: snapshotOf(""),
      packSuggestions: ["slack", "no_such_connector", "jira"],
    });
    expect(r.suggestedConnectors).toEqual(["slack", "jira"]);
  });

  test("an installed extension's service id may be suggested", () => {
    const { db, root } = setup();
    addExtension(db, root, "com.example.notes", { name: "Notes" });
    upsertRunGrant(db, {
      extension_id: "com.example.notes",
      service_id: "ext_notes",
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    const r = buildCatalogList({
      ...EXTRAS,
      db,
      snapshot: snapshotOf(""),
      packSuggestions: ["ext_notes"],
    });
    expect(r.suggestedConnectors).toEqual(["ext_notes"]);
  });

  test("every builtin row carries signIn from signInFor", () => {
    const { db } = setup();
    const r = buildCatalogList({
      ...EXTRAS,
      db,
      snapshot: snapshotOf(""),
      signInFor: (id) => (id === "slack" ? "browser" : "terminal"),
    });
    const builtins = r.connectors.filter((c) => c.kind === "builtin");
    expect(builtins.find((c) => c.id === "slack")).toMatchObject({ signIn: "browser" });
    expect(builtins.every((c) => "signIn" in c)).toBe(true);
  });
});
