export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  reset(): void;
  restore(): void;
}

export function captureOutput(): CapturedOutput {
  let stdoutBuf = "";
  let stderrBuf = "";
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;
  const origDebug = console.debug;

  const writeToStdout = (...args: unknown[]): void => {
    stdoutBuf += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  const writeToStderr = (...args: unknown[]): void => {
    stderrBuf += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };

  console.log = writeToStdout;
  console.info = writeToStdout;
  console.debug = writeToStdout;
  console.warn = writeToStderr;
  console.error = writeToStderr;

  return {
    get stdout(): string {
      return stdoutBuf;
    },
    get stderr(): string {
      return stderrBuf;
    },
    reset(): void {
      stdoutBuf = "";
      stderrBuf = "";
    },
    restore(): void {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      console.info = origInfo;
      console.debug = origDebug;
    },
  };
}
