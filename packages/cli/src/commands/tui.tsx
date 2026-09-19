import { render as inkRender } from "ink";

import { IPCClient } from "../ipc-client/index.ts";
import { createCliFileLogger } from "../lib/cli-logger.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { App } from "../tui/App.tsx";
import { currentFallbackEnv, detectFallbackReason } from "../tui/detect-fallback.ts";
import { IpcContext } from "../tui/ipc-context.ts";
import { runRepl } from "./repl.ts";

function printFallback(reason: string): void {
  process.stderr.write(`Unsuitable terminal detected (${reason}) — falling back to REPL.\n`);
}

export async function runTui(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "nimbus tui — rich Ink TUI for interactive sessions.\n" +
        "Falls back to `nimbus repl` on unsuitable terminals (TERM=dumb, NO_COLOR, non-TTY, CI=true, height<20).\n" +
        "No flags.\n",
    );
    return;
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write(`${gatewayNotRunningMessage(paths.demo === true)}\n`);
    process.exitCode = 1;
    return;
  }

  const reason = detectFallbackReason(currentFallbackEnv());
  if (reason !== null) {
    printFallback(reason);
    await runRepl(args);
    return;
  }

  const { logger } = await createCliFileLogger(paths);
  const client = new IPCClient(state.socketPath);
  await client.connect();

  const historyPath = `${paths.dataDir}/tui-query-history.json`;

  let exited = false;
  const cleanup = async (): Promise<void> => {
    if (exited) {
      return;
    }
    exited = true;
    try {
      await client.disconnect();
    } catch {
      // best-effort
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    void cleanup().then(() => {
      const code = signal === "SIGTERM" ? 143 : 130;
      process.exit(code);
    });
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("exit", () => {
    void cleanup();
  });

  const ink = inkRender(
    <IpcContext.Provider value={{ client, logger }}>
      <App
        historyPath={historyPath}
        onExit={() => {
          ink.unmount();
          void cleanup().then(() => {
            process.exit(0);
          });
        }}
      />
    </IpcContext.Provider>,
  );
  await ink.waitUntilExit();
  await cleanup();
}
