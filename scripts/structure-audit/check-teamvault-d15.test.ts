import { describe, expect, test } from "bun:test";
import { checkTeamVaultPrefixInvariant } from "./check-nimbus-invariants.ts";

describe("D15 — the teamvault. vault-key prefix is composed only in team-vault-keys.ts", () => {
  test("flags the exact prefix literal constructed outside the home file", () => {
    const v = checkTeamVaultPrefixInvariant([
      {
        relPath: "packages/gateway/src/ipc/leaky.ts",
        contents: 'const k = "teamvault." + entry + "." + key;',
      },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D15-teamvault-prefix");
  });

  test("flags a backtick-template prefix literal too", () => {
    const v = checkTeamVaultPrefixInvariant([
      { relPath: "packages/gateway/src/ipc/leaky.ts", contents: "const p = `teamvault.`;" },
    ]);
    expect(v.length).toBe(1);
  });

  test("allows the literal inside team-vault-keys.ts (the home)", () => {
    const v = checkTeamVaultPrefixInvariant([
      {
        relPath: "packages/gateway/src/teamvault/team-vault-keys.ts",
        contents: 'export const TEAM_VAULT_PREFIX = "teamvault." as const;',
      },
    ]);
    expect(v.length).toBe(0);
  });

  test("does NOT flag IPC method-name routing (startsWith) — method namespace shares the literal", () => {
    const v = checkTeamVaultPrefixInvariant([
      {
        relPath: "packages/gateway/src/ipc/server/dispatchers.ts",
        contents: 'if (!method.startsWith("teamvault.")) return skipped;',
      },
    ]);
    expect(v.length).toBe(0);
  });

  test("does NOT flag the audit action-type teamvault.invoke.<decision> (more chars before the quote)", () => {
    const v = checkTeamVaultPrefixInvariant([
      {
        relPath: "packages/gateway/src/teamvault/team-vault-audit.ts",
        contents: "const a = `teamvault.invoke.${decision}`;",
      },
    ]);
    expect(v.length).toBe(0);
  });

  test("does not flag a mention inside a comment", () => {
    const v = checkTeamVaultPrefixInvariant([
      {
        relPath: "packages/gateway/src/ipc/doc.ts",
        contents: '// secrets live under "teamvault." in the OS vault',
      },
    ]);
    expect(v.length).toBe(0);
  });
});
