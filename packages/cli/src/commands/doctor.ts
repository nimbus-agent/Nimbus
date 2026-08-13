import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { IPCClient } from "../ipc-client/index.ts";
import { gatewayStatePath, isProcessAlive, readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

import {
  runDoctor as coreRunDoctor,
  createDoctorVaultExec,
  type DoctorCoreDeps,
} from "./doctor-core.ts";
import type { FixKeyringDeps } from "./doctor-fix-keyring.ts";

// `--fix-keyring` spawns a whole dbus-run-session + gnome-keyring-daemon round
// trip, not a single D-Bus property read, so it gets a much longer budget
// than the read-only Vault probe's 5s default.
const FIX_KEYRING_EXEC_TIMEOUT_MS = 30_000;

function statMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

function mkdirMode(path: string, mode: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
}

function writeFileMode(path: string, data: string, mode: number): void {
  writeFileSync(path, data, { mode });
  chmodSync(path, mode);
}

// Deliberately does NOT catch: doctor-fix-keyring.ts's `existingKeyringPath`
// calls this only after its own `statMode` check has confirmed the
// directory exists, so any error here (EACCES, EPERM, ...) is a genuine
// enumeration failure the fail-closed guard must see, not "empty directory".
function listDir(path: string): readonly string[] {
  return readdirSync(path);
}

const fixKeyringDeps: FixKeyringDeps = {
  exec: createDoctorVaultExec(FIX_KEYRING_EXEC_TIMEOUT_MS),
  homeDir: () => homedir(),
  statMode,
  mkdirMode,
  writeFileMode,
  listDir,
};

const productionDeps: DoctorCoreDeps = {
  getCliPlatformPaths,
  readGatewayState,
  isProcessAlive,
  gatewayStatePath,
  makeClient: (socketPath) => new IPCClient(socketPath),
  fixKeyringDeps,
};

export function runDoctor(args: string[]): Promise<void> {
  return coreRunDoctor(args, productionDeps);
}
