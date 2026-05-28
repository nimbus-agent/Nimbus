import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { envGet } from "../env.ts";

export type GatewayLaunchPlan =
  | { ok: true; cmd: string[]; cwd?: string }
  | { ok: false; message: string };

export type GatewayLaunchDeps = {
  exists: (path: string) => boolean;
  whichBun: () => string | undefined;
};

const GATEWAY_SOURCE_ENTRY = "packages/gateway/src/index.ts";

function defaultDeps(): GatewayLaunchDeps {
  return {
    exists: existsSync,
    whichBun: (): string | undefined => Bun.which("bun") ?? undefined,
  };
}

function gatewayBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "nimbus-gateway.exe" : "nimbus-gateway";
}

export function walkUpDirs(startDir: string): string[] {
  const out: string[] = [];
  let d = resolve(startDir);
  for (;;) {
    out.push(d);
    const parent = resolve(dirname(d));
    if (parent === d) {
      break;
    }
    d = parent;
  }
  return out;
}

export function isNimbusWorkspaceRoot(dir: string, exists: (path: string) => boolean): boolean {
  const pkgPath = join(dir, "package.json");
  if (!exists(pkgPath)) {
    return false;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const o = raw as { name?: unknown; workspaces?: unknown };
    return o.name === "nimbus" && Array.isArray(o.workspaces);
  } catch {
    return false;
  }
}

export function findNimbusRepoRootFromDirs(
  startDirs: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  const seen = new Set<string>();
  for (const raw of startDirs) {
    for (const dir of walkUpDirs(raw)) {
      if (seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      if (isNimbusWorkspaceRoot(dir, exists)) {
        return dir;
      }
    }
  }
  return undefined;
}

export function getNimbusRepoSearchStartDirs(execPath: string, importMetaUrl: string): string[] {
  const fromExec = dirname(resolve(execPath));
  const fromModule = dirname(fileURLToPath(importMetaUrl));
  return [fromExec, fromModule];
}

function isBunExecutable(execPath: string): boolean {
  const base = basename(execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

function resolveBunPath(execPath: string, whichBun: () => string | undefined): string | undefined {
  if (isBunExecutable(execPath)) {
    return execPath;
  }
  return whichBun();
}

const FAILURE_HINT = `Options: install nimbus-gateway next to this executable, build the gateway (bun run build in packages/gateway), run from the monorepo with bun on PATH, or set NIMBUS_GATEWAY_EXECUTABLE to the gateway binary path.`;

function resolveFromOverride(exists: (path: string) => boolean): GatewayLaunchPlan | undefined {
  const override = envGet("NIMBUS_GATEWAY_EXECUTABLE")?.trim();
  if (override === undefined || override.length === 0) {
    return undefined;
  }
  if (!exists(override)) {
    return {
      ok: false,
      message: `NIMBUS_GATEWAY_EXECUTABLE is set but file not found: ${override}`,
    };
  }
  return { ok: true, cmd: [override] };
}

function resolveFromRepoRoot(
  repoRoot: string,
  binName: string,
  execPath: string,
  exists: (path: string) => boolean,
  whichBun: () => string | undefined,
): GatewayLaunchPlan | undefined {
  const distJs = join(repoRoot, "dist", "nimbus-gateway.js");
  const distExe = join(repoRoot, "dist", binName);
  const jsThere = exists(distJs);
  const exeThere = exists(distExe);
  const bunPath = resolveBunPath(execPath, whichBun);

  if (
    jsThere &&
    bunPath !== undefined &&
    (!exeThere || statSync(distJs).mtimeMs >= statSync(distExe).mtimeMs)
  ) {
    return { ok: true, cmd: [bunPath, distJs], cwd: repoRoot };
  }

  if (exeThere) {
    return { ok: true, cmd: [distExe] };
  }

  const sourceEntry = join(repoRoot, GATEWAY_SOURCE_ENTRY);
  if (!exists(sourceEntry)) {
    return undefined;
  }
  if (bunPath !== undefined) {
    return {
      ok: true,
      cmd: [bunPath, "run", GATEWAY_SOURCE_ENTRY],
      cwd: repoRoot,
    };
  }
  return {
    ok: false,
    message: `Found the Nimbus monorepo at ${repoRoot} but no compiled gateway at dist/${binName} (and no dist/nimbus-gateway.js), and Bun is not on PATH (required to run gateway from source). ${FAILURE_HINT}`,
  };
}

export function resolveGatewayLaunch(
  execPath: string,
  importMetaUrl: string,
  platform: NodeJS.Platform = process.platform,
  partialDeps?: Partial<GatewayLaunchDeps>,
): GatewayLaunchPlan {
  const { exists, whichBun } = { ...defaultDeps(), ...partialDeps };

  const override = resolveFromOverride(exists);
  if (override !== undefined) {
    return override;
  }

  const binName = gatewayBinaryName(platform);
  const sibling = join(dirname(resolve(execPath)), binName);
  if (exists(sibling)) {
    return { ok: true, cmd: [sibling] };
  }

  const startDirs = getNimbusRepoSearchStartDirs(execPath, importMetaUrl);
  const repoRoot = findNimbusRepoRootFromDirs(startDirs, exists);
  if (repoRoot !== undefined) {
    const fromRepo = resolveFromRepoRoot(repoRoot, binName, execPath, exists, whichBun);
    if (fromRepo !== undefined) {
      return fromRepo;
    }
  }

  return {
    ok: false,
    message: `Could not locate the Gateway: no sibling ${binName}, no monorepo checkout, and NIMBUS_GATEWAY_EXECUTABLE is unset. ${FAILURE_HINT}`,
  };
}
