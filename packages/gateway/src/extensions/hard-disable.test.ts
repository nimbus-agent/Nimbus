import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

import { insertExtensionRow } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  hardDisablePreT2Extensions,
  PRE_T2_DISABLE_REASON,
  preT2DisabledCount,
  preT2DisabledIds,
  preT2DisableMessage,
} from "./hard-disable.ts";

function memoryLogger(): { logger: Logger; warns: unknown[] } {
  const warns: unknown[] = [];
  const logger = {
    warn: (o: unknown, msg?: string) => {
      warns.push({ o, msg });
    },
    error: () => {},
  } as unknown as Logger;
  return { logger, warns };
}

function writeExtensionDir(
  prefix: string,
  _id: string,
  manifest: Record<string, unknown>,
): { dir: string; manifestHex: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const manifestPath = join(dir, "nimbus.extension.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist/index.js"), "/* entry */", "utf8");
  const manifestHex = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  return { dir, manifestHex };
}

function insertRow(db: Database, id: string, dir: string, manifestHex: string): void {
  const t = Date.now();
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: dir,
    manifest_hash: manifestHex,
    entry_hash: createHash("sha256").update("/* entry */").digest("hex"),
    installed_at: t,
    last_verified_at: t,
  });
}

describe("hardDisablePreT2Extensions", () => {
  test("disables extension whose manifest uses legacy array form", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = writeExtensionDir("nimbus-preT2-legacy-", "legacy.ext", {
      id: "legacy.ext",
      version: "1.0.0",
      permissions: ["read-files", "trash"],
    });
    insertRow(db, "legacy.ext", dir, manifestHex);

    const { logger, warns } = memoryLogger();
    const disabled = hardDisablePreT2Extensions({ db, logger });

    expect(disabled.length).toBe(1);
    expect(disabled[0]?.id).toBe("legacy.ext");
    expect(preT2DisabledCount()).toBe(1);
    expect(preT2DisabledIds()).toEqual(["legacy.ext"]);

    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("legacy.ext") as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
    expect(warns.length).toBe(1);
    expect(JSON.stringify(warns[0])).toContain("hard-disabled pre-T2");
  });

  test("does NOT disable object-form manifest with empty permissions (explicit default-deny)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = writeExtensionDir("nimbus-preT2-empty-", "explicit.empty", {
      id: "explicit.empty",
      version: "1.0.0",
      permissions: {},
    });
    insertRow(db, "explicit.empty", dir, manifestHex);

    const { logger } = memoryLogger();
    const disabled = hardDisablePreT2Extensions({ db, logger });

    expect(disabled.length).toBe(0);
    expect(preT2DisabledCount()).toBe(0);
    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("explicit.empty") as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });

  test("does NOT disable object-form manifest with declared network hosts", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = writeExtensionDir("nimbus-preT2-network-", "with.network", {
      id: "with.network",
      version: "1.0.0",
      permissions: { network: ["api.github.com"] },
    });
    insertRow(db, "with.network", dir, manifestHex);

    const { logger } = memoryLogger();
    const disabled = hardDisablePreT2Extensions({ db, logger });

    expect(disabled.length).toBe(0);
    expect(preT2DisabledCount()).toBe(0);
    expect(preT2DisabledIds()).toEqual([]);
    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("with.network") as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });

  test("does NOT disable manifest with missing permissions field (no key at all)", () => {
    // A manifest with no `permissions` key is normalized to default-deny by
    // the validator. It is NOT the pre-T2 legacy form (which used an array)
    // — we cannot distinguish "I wrote this for T2 and forgot the key" from
    // "I wrote this pre-T2 and had no key" any other way, so we err on the
    // permissive side. The intended target of hard-disable is the legacy
    // ARRAY form, which is the only form that was ever shipped under
    // pre-T2 documentation.
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = writeExtensionDir("nimbus-preT2-missing-", "no.perms", {
      id: "no.perms",
      version: "1.0.0",
    });
    insertRow(db, "no.perms", dir, manifestHex);

    const { logger } = memoryLogger();
    const disabled = hardDisablePreT2Extensions({ db, logger });

    expect(disabled.length).toBe(0);
    expect(preT2DisabledCount()).toBe(0);
  });

  test("is idempotent: subsequent calls keep the same set", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = writeExtensionDir("nimbus-preT2-idem-", "legacy.idem", {
      id: "legacy.idem",
      version: "1.0.0",
      permissions: [],
    });
    insertRow(db, "legacy.idem", dir, manifestHex);

    const { logger } = memoryLogger();
    hardDisablePreT2Extensions({ db, logger });
    const second = hardDisablePreT2Extensions({ db, logger });

    expect(second.length).toBe(1);
    expect(preT2DisabledCount()).toBe(1);
    expect(preT2DisabledIds()).toEqual(["legacy.idem"]);
  });

  test("mixed registry: only legacy entries are disabled", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const legacy = writeExtensionDir("nimbus-preT2-mix-legacy-", "legacy.mix", {
      id: "legacy.mix",
      version: "1.0.0",
      permissions: ["any"],
    });
    insertRow(db, "legacy.mix", legacy.dir, legacy.manifestHex);
    const modern = writeExtensionDir("nimbus-preT2-mix-modern-", "modern.mix", {
      id: "modern.mix",
      version: "2.0.0",
      permissions: { network: ["api.example.com"] },
    });
    insertRow(db, "modern.mix", modern.dir, modern.manifestHex);

    const { logger } = memoryLogger();
    const disabled = hardDisablePreT2Extensions({ db, logger });
    expect(disabled.map((r) => r.id)).toEqual(["legacy.mix"]);
    expect(preT2DisabledIds()).toEqual(["legacy.mix"]);

    const enabledFlags = db.query("SELECT id, enabled FROM extension ORDER BY id").all() as Array<{
      id: string;
      enabled: number;
    }>;
    expect(enabledFlags).toEqual([
      { id: "legacy.mix", enabled: 0 },
      { id: "modern.mix", enabled: 1 },
    ]);
  });

  test("constants — disable reason and message contract", () => {
    expect(PRE_T2_DISABLE_REASON).toBe("needs_reinstall_pre_t2");
    const msg = preT2DisableMessage("acme.foo", "3.1.4");
    expect(msg).toContain("Extension acme.foo v3.1.4 was installed before sandbox hardening");
    expect(msg).toContain("(T2 PR 1, 2026-05-16)");
    expect(msg).toContain("Reinstall to enable: nimbus extension reinstall acme.foo");
  });
});
