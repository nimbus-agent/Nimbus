import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionManifest, runContractTests } from "@nimbus-dev/sdk";

export const MANIFEST = "nimbus.extension.json";

export type TestArgs = { root: string };

export function parseTestArgs(args: string[], cwd: string = process.cwd()): TestArgs {
  const rootArg = args[0]?.trim() ?? "";
  return { root: rootArg === "" ? cwd : rootArg };
}

export function loadAndValidateManifest(root: string): ExtensionManifest {
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`No ${MANIFEST} in ${root}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid manifest root in ${manifestPath}`);
  }
  return raw as ExtensionManifest;
}

export function getTestScript(pkgPath: string): string | undefined {
  if (!existsSync(pkgPath)) {
    return undefined;
  }
  let pkgRaw: unknown;
  try {
    pkgRaw = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return undefined;
  }
  const scripts =
    pkgRaw !== null && typeof pkgRaw === "object" && !Array.isArray(pkgRaw)
      ? (pkgRaw as { scripts?: unknown }).scripts
      : undefined;
  const testScript =
    scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)
      ? (scripts as { test?: unknown }).test
      : undefined;
  if (typeof testScript === "string" && testScript.trim() !== "") {
    return testScript;
  }
  return undefined;
}

export async function runTest(args: string[]): Promise<void> {
  const { root } = parseTestArgs(args);
  const manifest = loadAndValidateManifest(root);
  runContractTests(manifest);

  const pkgPath = join(root, "package.json");
  const testScript = getTestScript(pkgPath);
  if (testScript !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["test"], {
        cwd: root,
        stdio: "inherit",
        shell: false,
      });
      (child as unknown as EventEmitter).on("error", (err: Error) => {
        reject(err);
      });
      (child as unknown as EventEmitter).on("close", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`bun test exited with code ${String(code)}`));
        }
      });
    });
  }

  console.log("Extension contract OK.");
}
