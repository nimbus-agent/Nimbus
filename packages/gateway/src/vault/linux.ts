import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

import { compareVaultKeysAlphabetically, validateVaultKeyOrThrow } from "./key-format.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

export const SECRET_TOOL_FALLBACK_PATH = "/usr/bin/secret-tool";

const LABEL_PREFIX = "Nimbus: ";

export function resolveSecretToolExecutable(): string | null {
  const w = Bun.which("secret-tool");
  if (w !== null && w.length > 0) {
    return w;
  }
  if (existsSync(SECRET_TOOL_FALLBACK_PATH)) {
    return SECRET_TOOL_FALLBACK_PATH;
  }
  return null;
}

function secretToolExecutable(): string {
  return resolveSecretToolExecutable() ?? SECRET_TOOL_FALLBACK_PATH;
}

function nimbusLabel(key: string): string {
  return `${LABEL_PREFIX}${key}`;
}

export function extractNimbusVaultKeysFromSecretToolSearchOutput(
  stdout: string,
  stderr?: string,
): string[] {
  const keys = new Set<string>();
  const labelLine = /^label = Nimbus: (.+)$/gm;
  for (const m of stdout.matchAll(labelLine)) {
    const k = m[1]?.trim() ?? "";
    if (k.length > 0) {
      keys.add(k);
    }
  }
  if (stderr !== undefined && stderr.length > 0) {
    const nimbusKeyAttr = /^attribute\.nimbus-key = (.+)$/gm;
    for (const m of stderr.matchAll(nimbusKeyAttr)) {
      const k = m[1]?.trim() ?? "";
      if (k.length > 0) {
        keys.add(k);
      }
    }
  }
  return Array.from(keys).sort(compareVaultKeysAlphabetically);
}

function spawnSecretTool(
  args: string[],
  options: { stdin?: string; captureStderr: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdio: ["pipe", "pipe", "pipe" | "ignore"] = options.captureStderr
      ? ["pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "ignore"];
    // windows-console-ok: `vault/linux.ts` runs only on Linux, where the flag is ignored.
    const child = spawn(secretToolExecutable(), args, { stdio });
    const outStream = child.stdout;
    const inStream = child.stdin;
    if (outStream === null || inStream === null) {
      reject(new Error("Vault spawn: missing stdio pipes"));
      return;
    }
    let stdout = "";
    let stderr = "";
    outStream.setEncoding("utf8");
    outStream.on("data", (c: string) => {
      stdout += c;
    });
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
      });
    }
    (child as unknown as EventEmitter).on("error", (err: Error) => {
      reject(err);
    });
    (child as unknown as EventEmitter).on("close", (code: number | null) => {
      resolve({ code, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      inStream.write(options.stdin, "utf8");
    }
    inStream.end();
  });
}

async function runSecretTool(args: string[], stdin?: string): Promise<string> {
  const r =
    stdin === undefined
      ? await spawnSecretTool(args, { captureStderr: false })
      : await spawnSecretTool(args, { stdin, captureStderr: false });
  if (r.code === 0) {
    return r.stdout;
  }
  throw new Error("Vault operation failed");
}

export class LinuxSecretToolVault implements NimbusVault {
  async set(key: string, value: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    await runSecretTool(
      ["store", "--label", nimbusLabel(key), "application", "nimbus", "nimbus-key", key],
      value,
    );
  }

  async get(key: string): Promise<string | null> {
    validateVaultKeyOrThrow(key);
    try {
      const out = await runSecretTool(["lookup", "application", "nimbus", "nimbus-key", key]);
      return out.replace(/\n$/, "");
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    try {
      await runSecretTool(["clear", "application", "nimbus", "nimbus-key", key]);
    } catch {
      /* treat as no-op if missing */
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    let stdout: string;
    let stderr: string;
    try {
      const r = await spawnSecretTool(["search", "--all", "application", "nimbus"], {
        captureStderr: true,
      });
      if (r.code !== 0) {
        return [];
      }
      stdout = r.stdout;
      stderr = r.stderr;
    } catch {
      return [];
    }
    const keys = extractNimbusVaultKeysFromSecretToolSearchOutput(stdout, stderr);
    if (prefix === undefined || prefix.length === 0) {
      return keys;
    }
    return keys.filter((k) => k.startsWith(prefix));
  }
}
