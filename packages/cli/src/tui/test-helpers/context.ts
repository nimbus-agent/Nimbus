import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IpcContextValue } from "../ipc-context.ts";
import type { StubIpcClient } from "./stub-client.ts";

export const silentLogger: IpcContextValue["logger"] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as IpcContextValue["logger"];

export function ipcContextFor(stub: StubIpcClient): IpcContextValue {
  return {
    client: stub.asClient(),
    logger: silentLogger,
  };
}

export function makeHistoryPath(prefix = "nimbus-tui-"): {
  readonly path: string;
  readonly cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: join(dir, "hist.json"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
