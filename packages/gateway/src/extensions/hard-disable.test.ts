import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
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
  signatureDisabledRegistry,
  signatureDisableMessage,
} from "./hard-disable.ts";
import type { SignatureDisableReason } from "./verify-signature.ts";

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

    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.id).toBe("legacy.ext");
    expect(preT2DisabledCount()).toBe(1);
    expect(preT2DisabledIds()).toEqual(["legacy.ext"]);

    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("legacy.ext") as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
    expect(warns).toHaveLength(1);
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

    expect(disabled).toHaveLength(0);
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

    expect(disabled).toHaveLength(0);
    expect(preT2DisabledCount()).toBe(0);
    expect(preT2DisabledIds()).toEqual([]);
    const row = db.query("SELECT enabled FROM extension WHERE id = ?").get("with.network") as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });

  test("does NOT disable manifest with missing permissions field (no key at all)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { dir, manifestHex } = writeExtensionDir("nimbus-preT2-missing-", "no.perms", {
      id: "no.perms",
      version: "1.0.0",
    });
    insertRow(db, "no.perms", dir, manifestHex);

    const { logger } = memoryLogger();
    const disabled = hardDisablePreT2Extensions({ db, logger });

    expect(disabled).toHaveLength(0);
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

    expect(second).toHaveLength(1);
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

describe("signatureDisabledRegistry", () => {
  beforeEach(() => signatureDisabledRegistry.reset());

  test("mark + reasonFor round-trip", () => {
    signatureDisabledRegistry.mark("ext-a", "publisher_key_missing");
    expect(signatureDisabledRegistry.reasonFor("ext-a")).toBe("publisher_key_missing");
  });

  test("has + count", () => {
    expect(signatureDisabledRegistry.has("ext-a")).toBe(false);
    expect(signatureDisabledRegistry.count()).toBe(0);
    signatureDisabledRegistry.mark("ext-a", "signature_failed");
    expect(signatureDisabledRegistry.has("ext-a")).toBe(true);
    expect(signatureDisabledRegistry.count()).toBe(1);
  });

  test("list returns sorted by id", () => {
    signatureDisabledRegistry.mark("ext-c", "signature_failed");
    signatureDisabledRegistry.mark("ext-a", "publisher_key_missing");
    signatureDisabledRegistry.mark("ext-b", "publisher_key_mismatch");
    expect(signatureDisabledRegistry.list().map((e) => e.id)).toEqual(["ext-a", "ext-b", "ext-c"]);
  });

  test("reset clears all", () => {
    signatureDisabledRegistry.mark("ext-a", "signature_failed");
    signatureDisabledRegistry.reset();
    expect(signatureDisabledRegistry.count()).toBe(0);
  });
});

describe("signatureDisableMessage", () => {
  // Every reason gets its own remediation because the remedies genuinely differ: a missing or
  // rotated publisher key is fixed by supplying the key (`--publisher-key`), while a failed or
  // malformed signature means the bytes on disk no longer match what was signed, and a key would
  // not help. A single generic "reinstall it" line would be wrong for
  // half the set, which is why the switch is exhaustive over `SignatureDisableReason` rather
  // than defaulting.
  // A hand-written tuple would compile happily when a fifth reason is added, and that reason
  // would then never reach the distinctness check below. `Record<SignatureDisableReason, true>`
  // makes omitting one a compile error — the same shape the repo uses for `GapCategory`.
  const REASON_SET: Record<SignatureDisableReason, true> = {
    publisher_key_missing: true,
    publisher_key_mismatch: true,
    signature_failed: true,
    signature_malformed: true,
  };
  const REASONS = Object.keys(REASON_SET) as SignatureDisableReason[];

  test("names the extension, the version and the machine-readable reason", () => {
    const msg = signatureDisableMessage("acme.foo", "3.1.4", "signature_failed");
    expect(msg).toContain("acme.foo");
    expect(msg).toContain("3.1.4");
    expect(msg).toContain("signature_failed");
  });

  test("says the extension was disabled, never that the user disabled it", () => {
    const msg = signatureDisableMessage("acme.foo", "3.1.4", "publisher_key_missing");
    expect(msg).toMatch(/signature verification/i);
    // The positive assertion alone would pass on a message that ALSO blamed the owner, which is
    // the one reading this whole feature exists to rule out. Both word orders, since "you
    // disabled it" and "disabled by you" are the same mistake.
    expect(msg).not.toMatch(
      /\b(?:user|you|owner)\b[^.]*\bdisabled\b|\bdisabled\b[^.]*\b(?:user|you|owner)\b/i,
    );
  });

  test("every reason yields a distinct, non-empty remediation", () => {
    const remediations = REASONS.map((r) => signatureDisableMessage("acme.foo", "1.0.0", r));
    for (const m of remediations) expect(m.trim().length).toBeGreaterThan(0);
    expect(new Set(remediations).size).toBe(REASONS.length);
  });

  test("a key-resolution failure points at `--publisher-key`, a bytes failure does not", () => {
    expect(signatureDisableMessage("acme.foo", "1.0.0", "publisher_key_missing")).toContain(
      "--publisher-key <path>",
    );
    expect(signatureDisableMessage("acme.foo", "1.0.0", "publisher_key_mismatch")).toContain(
      "--publisher-key <path>",
    );
    expect(signatureDisableMessage("acme.foo", "1.0.0", "signature_failed")).not.toContain(
      "--publisher-key <path>",
    );
    expect(signatureDisableMessage("acme.foo", "1.0.0", "signature_malformed")).not.toContain(
      "--publisher-key <path>",
    );
  });
});
