import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { fakeVault, read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { artifactDigest, canonicalArtifactBytes } from "../toolgen/toolgen-artifact.ts";
import { sweepToolgenCredentials } from "../toolgen/toolgen-credential-sweep.ts";
import { toolCredentialKey } from "../toolgen/toolgen-credentials.ts";
import {
  signArtifact,
  TOOLGEN_SIGNING_PRIVKEY,
  TOOLGEN_SIGNING_PUBKEY,
} from "../toolgen/toolgen-keypair.ts";
import { ToolgenRegistry } from "../toolgen/toolgen-registry.ts";
import { insertSavedTool } from "../toolgen/toolgen-saved-repo.ts";
import { loadSavedToolsIntoRegistry } from "../toolgen/toolgen-saved-spawn.ts";
import { savedToolDir, writeSavedTool } from "../toolgen/toolgen-saved-store.ts";
import type { GeneratedToolArtifact } from "../toolgen/toolgen-types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

describe("I40 — a saved generated tool is durable only under a live signature, not a cached hash", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    return db;
  }

  function tmpConfigDir(): string {
    return mkdtempSync(join(tmpdir(), "nimbus-i40-"));
  }

  function testArtifact(toolId: string): GeneratedToolArtifact {
    return {
      toolId,
      toolName: `generated_${toolId}`,
      description: "a saved tool used only by this invariant test",
      body: "return { ok: true };",
      approvedHosts: ["api.example.com"],
      credentialHosts: [],
      manifest: {
        id: `toolgen.${toolId}`,
        version: "0.0.0",
        permissions: { network: [], filesystem: { read: [], write: [] } },
        updateChannel: "stable",
      },
      inputSchema: { type: "object", properties: {} },
    };
  }

  /**
   * Signs, writes and rows a saved tool exactly the way `saveGeneratedTool` (the real approval
   * path) does — sign, write the three files, THEN insert the row.
   */
  async function createSavedTool(
    db: Database,
    configDir: string,
    vault: NimbusVault,
    toolId: string,
  ): Promise<void> {
    const art = testArtifact(toolId);
    const canonicalJson = canonicalArtifactBytes(art);
    const digest = artifactDigest(art);
    const { sigB64, pubkeyB64 } = await signArtifact(vault, canonicalJson);
    await writeSavedTool(configDir, toolId, { canonicalJson, sigB64, script: "// unused" });
    insertSavedTool(db, {
      toolId,
      toolName: art.toolName,
      description: art.description,
      artifactJson: canonicalJson,
      artifactDigest: digest,
      signature: sigB64,
      pubkey: pubkeyB64,
      approvedAt: 1,
      savedAt: 1,
      lastLoadedAt: null,
      disabledReason: null,
    });
  }

  test("I40: readVerifiedSavedTool is the ONLY exported accessor for a saved artifact", async () => {
    // The store's own file-level docstring calls this "the whole point of it existing" (D29(d)):
    // no other production file may name the on-disk artifact file directly. Comments stripped
    // first — `toolgen-artifact.ts`'s own docstring MENTIONS `artifact.json` in prose, which must
    // not count as a second accessor any more than a comment trips D29(d) itself.
    const files = await readDirFiles("packages/gateway/src");
    const hits = files
      .filter((f) => /["'`]artifact\.json["'`]/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(hits).toEqual(["packages/gateway/src/toolgen/toolgen-saved-store.ts"]);

    // And within that one file, the bytes are read from disk in exactly one place — inside
    // readVerifiedSavedTool, the sanctioned door. A second internal read site (a "fast path"
    // added later in the same file, still exported or not) would show up here too.
    const src = await read("packages/gateway/src/toolgen/toolgen-saved-store.ts");
    const readSites = [...src.matchAll(/readFile\([^)]*ARTIFACT_FILE/g)];
    expect(readSites).toHaveLength(1);
  });

  test("I40: a saved artifact failing verification is not offered to the model", async () => {
    const db = freshDb();
    const configDir = tmpConfigDir();
    const vault = fakeVault();
    await createSavedTool(db, configDir, vault, "t1");

    // Tamper with the artifact bytes AFTER signing — the signature was made over the original
    // bytes. This is the filesystem-write-attacker scenario I40 defends against: the digest
    // cached on the `generated_tool` row would not catch this on its own (that is I40's own
    // residual argument against relying on a cached hash), but a live signature re-verify does.
    writeFileSync(join(savedToolDir(configDir, "t1"), "artifact.json"), "tampered");

    const registry = new ToolgenRegistry();
    await loadSavedToolsIntoRegistry(
      {
        db,
        configDir,
        vault,
        runtime: { requiredReadPaths: () => [] },
        config: { enabled: true },
        enforced: { capabilitiesDisabled: new Set<string>() },
      },
      registry,
    );

    // Absent from the registry entirely — never present-and-erroring — and so never reachable
    // through the one path (`forSession`) that decides what a model session actually sees.
    expect(registry.savedTools()).toEqual([]);
    expect(registry.forSession("any-session")).toEqual([]);
  });

  test("I40: tool.save is RESERVED in the HITL frozen set — inert, not load-bearing", () => {
    // `HITL_REQUIRED_BACKING` is module-PRIVATE (I2 asserts it is never exported), so this
    // asserts through the frozen `HITL_REQUIRED` facade, which IS exported — importing the
    // backing set would not compile, and a source-regex check would pass on a commented-out
    // entry.
    //
    // What this test does NOT claim, corrected from an earlier overstatement: I40's "durable only
    // under an owner-approved signature" guarantee does not depend on this membership. Nothing
    // constructs an executor action of type `tool.save`; `saveGeneratedTool` prompts through its
    // own `ToolgenSaveConsentBroker` and never consults `HITL_REQUIRED` at all — exactly as I33's
    // `code.execute`, I35's `computer.action` and I39's `tool.generate` do, all three of which are
    // correctly ABSENT from this set. Deleting this entry would change no behaviour.
    //
    // It is asserted anyway because the design spec RESERVES the name, so this is where an
    // executor-routed save would belong; the test pins the reservation, and the comment above
    // pins what it is worth. The real enforcement of the save prompt lives in
    // `toolgen-save-gate.test.ts`.
    expect(HITL_REQUIRED.has("tool.save")).toBe(true);
  });

  test("I40: no saved tool retains a credential across a sweep", async () => {
    const vault = fakeVault();
    const savedToolCredentialKey = toolCredentialKey("t1", "api.example.com");
    await vault.set(savedToolCredentialKey, "secret-value");
    await vault.set(TOOLGEN_SIGNING_PRIVKEY, "priv-seed");
    await vault.set(TOOLGEN_SIGNING_PUBKEY, "pub-key");

    const swept = await sweepToolgenCredentials(vault);

    expect(swept).toBe(1);
    expect(await vault.get(savedToolCredentialKey)).toBeNull();
    // The signing keypair itself is the ONE thing a sweep must never take — it is what keeps
    // every already-approved saved tool's signature verifying after the sweep runs.
    expect(await vault.get(TOOLGEN_SIGNING_PRIVKEY)).toBe("priv-seed");
    expect(await vault.get(TOOLGEN_SIGNING_PUBKEY)).toBe("pub-key");
  });
});
