import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureResult, spawnCapture } from "./capture.ts";
import { type EventsScript, FakeGateway } from "./fake-gateway.ts";
import type { CompiledScript, ConsentStep } from "./yaml-script.ts";

export interface HarnessOpts {
  readonly compiled: CompiledScript;
  readonly events: EventsScript;
  readonly cliEntry: string;
}

export interface PerStepCapture {
  readonly input: string;
  readonly capture: CaptureResult;
}

export interface HarnessRun {
  readonly captures: ReadonlyArray<PerStepCapture>;
  readonly tmpDirPrefix: string;
}

function socketPathFor(tmpDir: string): string {
  if (process.platform === "win32") {
    return String.raw`\\.\pipe\nimbus-cast-${process.pid}-${Date.now()}`;
  }
  return join(tmpDir, "gw.sock");
}

function writeConsentJsonl(path: string, consents: ReadonlyArray<ConsentStep>): void {
  const lines = consents
    .map((c) => JSON.stringify({ approved: c.consent === "approve" }))
    .join("\n");
  writeFileSync(path, lines.length > 0 ? `${lines}\n` : "", "utf8");
}

function dataDirFor(tmpDir: string): string {
  if (process.platform === "win32") {
    return join(tmpDir, "Nimbus", "data");
  }
  if (process.platform === "darwin") {
    return join(tmpDir, "Library", "Application Support", "Nimbus");
  }
  return join(tmpDir, "nimbus");
}

function writeFakeGatewayState(dataDir: string, socketPath: string): void {
  mkdirSync(dataDir, { recursive: true });
  const state: { pid: number; socketPath: string } = {
    pid: 1,
    socketPath,
  };
  writeFileSync(join(dataDir, "gateway.json"), JSON.stringify(state), "utf8");
}

export async function runHarness(opts: HarnessOpts): Promise<HarnessRun> {
  const tmpDir = mkdtempSync(join(tmpdir(), "cast-driver-"));
  const socketPath = socketPathFor(tmpDir);
  const dataDir = dataDirFor(tmpDir);

  writeFakeGatewayState(dataDir, socketPath);

  const gateway = new FakeGateway({ socketPath, events: opts.events });
  await gateway.start();

  const captures: PerStepCapture[] = [];
  try {
    for (let idx = 0; idx < opts.compiled.inputGroups.length; idx += 1) {
      const group = opts.compiled.inputGroups[idx];
      if (group === undefined) continue;

      const consentJsonl = join(tmpDir, `consent-${idx}.jsonl`);
      writeConsentJsonl(consentJsonl, group.consents);

      const cmd = parseInput(group.input.input, opts.cliEntry);
      const result = await spawnCapture({
        cmd,
        env: {
          ...(process.env as Record<string, string>),
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          TERM: "dumb",
          COLUMNS: "120",
          LINES: "40",
          LANG: "C.UTF-8",
          NIMBUS_GATEWAY_SOCKET: socketPath,
          NIMBUS_SCRIPT_CONSENT_SOURCE: consentJsonl,
          LOCALAPPDATA: tmpDir,
          APPDATA: tmpDir,
          XDG_DATA_HOME: tmpDir,
          XDG_CONFIG_HOME: tmpDir,
          XDG_RUNTIME_DIR: tmpDir,
          HOME: tmpDir,
        },
        timeoutMs: group.input.timeoutMs ?? 60_000,
      });

      captures.push({ input: group.input.input, capture: result });

      const combined = result.chunks.map((c) => c.data).join("");
      if (group.input.expect !== undefined && !combined.includes(group.input.expect)) {
        throw new Error(`step ${idx}: expect missed: "${group.input.expect}"`);
      }
      for (const c of group.consents) {
        if (c.expect !== undefined && !combined.includes(c.expect)) {
          throw new Error(`step ${idx}: consent expect missed: "${c.expect}"`);
        }
      }

      gateway.advanceStep();
    }
  } finally {
    await gateway.stop();
  }

  return { captures, tmpDirPrefix: tmpDir };
}

function parseInput(rawInput: string, cliEntry: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of rawInput) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  if (tokens[0] !== "nimbus") {
    throw new Error(`harness: input must start with "nimbus", got "${tokens[0] ?? ""}"`);
  }
  return ["bun", cliEntry, ...tokens.slice(1)];
}
