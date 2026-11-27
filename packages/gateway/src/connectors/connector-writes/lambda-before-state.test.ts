// The `aws_lambda_invoke` before-state against the INSTALLED connector (connectors 0.21.0 projects
// `aws_lambda_list`): the installed `aws_lambda_list` handler runs on a stubbed `aws` reply that
// carries secret environment values, and `selectLambdaFunction` reads the answer. The fields the
// prompt shows still arrive under the AWS names it reads, and no environment value reaches it.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { installedConnectorsPackageRoot } from "../testing/connector-write-registrations.ts";
import { selectLambdaFunction } from "./cloud-readers.ts";

const ROOT = installedConnectorsPackageRoot();
const RUN_CLI = join(ROOT, "shared", "run-cli-json.ts");

const SECRET = "fake-secret-lambda-env-value";
const RAW_LIST = {
  Functions: [
    {
      FunctionName: "orders",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      MemorySize: 256,
      Timeout: 30,
      LastModified: "2026-11-01T10:00:00.000+0000",
      Description: "order intake",
      Environment: {
        Variables: { DB_PASSWORD: SECRET, API_TOKEN: `${SECRET}-2` },
        Error: { ErrorCode: "x", Message: `${SECRET}-3` },
      },
      ImageConfigResponse: { ImageConfig: { Command: [`${SECRET}-4`] } },
    },
  ],
};

type SpawnResult = { code: number; stdout: string; stderr: string };
let stubbed: SpawnResult | undefined;

const actual = (await import(RUN_CLI)) as Record<string, unknown> & {
  runCliCode: (c: readonly string[], e: Record<string, string | undefined>) => Promise<SpawnResult>;
};
// Captured BEFORE the mock: once mocked, `actual.runCliCode` is the replacement itself, so calling
// it from the fallback would recurse forever.
const realRunCliCode = actual.runCliCode;
// Delegates to the real function unless this file set a reply, so no other file is affected.
mock.module(RUN_CLI, () => ({
  ...actual,
  runCliCode: (c: readonly string[], e: Record<string, string | undefined>) =>
    stubbed === undefined ? realRunCliCode(c, e) : Promise.resolve(stubbed),
}));

// The gateway's mode, as `run-bundled-connector.ts` sets it (raw handlers, the executor is the
// gate). Cleared before and after every case: `bun test` shares one process across files.
const mode = (await import(join(ROOT, "shared", "connector-mode.ts"))) as {
  setConnectorMode: (m: "gateway" | "standalone") => void;
  resetConnectorModeForTests: () => void;
};
beforeEach(() => {
  mode.resetConnectorModeForTests();
  mode.setConnectorMode("gateway");
});
afterEach(() => {
  mode.resetConnectorModeForTests();
});
afterAll(() => {
  stubbed = undefined;
  mode.resetConnectorModeForTests();
});

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

async function installedLambdaList(): Promise<unknown> {
  const mod = (await import(join(ROOT, "connectors", "aws", "src", "tools.ts"))) as {
    registerAwsTools: (server: unknown) => void;
  };
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      const h = rest.at(-1);
      if (typeof h === "function") handlers.set(name, h as Handler);
      return { enable: () => undefined, disable: () => undefined, remove: () => undefined };
    },
    registerTool: (name: string, _config: unknown, h: Handler) => {
      handlers.set(name, h);
      return { enable: () => undefined, disable: () => undefined, remove: () => undefined };
    },
    server: { getClientCapabilities: () => undefined, oninitialized: undefined },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  };
  mod.registerAwsTools(server);
  const list = handlers.get("aws_lambda_list");
  if (list === undefined)
    throw new Error("the installed aws connector registered no aws_lambda_list");
  stubbed = { code: 0, stdout: JSON.stringify(RAW_LIST), stderr: "" };
  try {
    return await list({});
  } finally {
    stubbed = undefined;
  }
}

describe("aws_lambda_invoke before-state over the installed aws_lambda_list (0.21.0)", () => {
  test("the reader still finds the function and shows its fields", async () => {
    const fields = selectLambdaFunction(await installedLambdaList(), { functionName: "orders" });
    const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(byLabel["Function"]).toBe("orders");
    expect(byLabel["Runtime"]).toBe("nodejs22.x");
    expect(byLabel["Handler"]).toBe("index.handler");
    expect(byLabel["Memory"]).toBe("256 MB");
    expect(byLabel["Timeout"]).toBe("30 s");
    expect(byLabel["Last modified"]).toBe("2026-11-01T10:00:00.000+0000");
    expect(byLabel["Description"]).toBe("order intake");
  });

  test("no environment value reaches the reply or the before-state", async () => {
    const reply = await installedLambdaList();
    expect(JSON.stringify(reply)).not.toContain(SECRET);
    const fields = selectLambdaFunction(reply, { functionName: "orders" });
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  test("the reader shows no environment value even from an unprojected reply", () => {
    const fields = selectLambdaFunction(RAW_LIST, { functionName: "orders" });
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  test("with no stubbed reply the mock delegates to the real runCliCode (no recursion)", async () => {
    const mocked = (await import(RUN_CLI)) as typeof actual;
    // The real function answers an empty command itself, without spawning anything.
    expect(await mocked.runCliCode([], {})).toEqual({
      code: 1,
      stdout: "",
      stderr: "empty command",
    });
  });
});
