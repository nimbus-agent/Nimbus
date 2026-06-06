import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

import {
  getBooleanInput,
  getInput,
  getIntInput,
  safeAnnotateEnvelope,
  safeBool,
  safeInt,
  safeString,
} from "./main.ts";

interface MockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface RecordedRequest {
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

function startMockGateway(responder: () => MockResponse): {
  server: Server;
  url: string;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/deployments") {
        return new Response("Not Found", { status: 404 });
      }
      let parsed: unknown = null;
      try {
        parsed = await req.json();
      } catch {
        /* leave parsed null */
      }
      requests.push({
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: parsed,
      });
      const { status, body, headers } = responder();
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...headers,
        },
      });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, requests };
}

function envForInputs(inputs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[`INPUT_${k.toUpperCase().replaceAll("-", "_")}`] = v;
  }
  return out;
}

async function runAction(args: {
  inputs: Record<string, string>;
  outputFile: string;
  summaryFile: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    ...process.env,
    ...envForInputs(args.inputs),
    GITHUB_OUTPUT: args.outputFile,
    GITHUB_STEP_SUMMARY: args.summaryFile,
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith("INPUT_") && !(k in envForInputs(args.inputs))) {
      delete env[k];
    }
  }
  const mainPath = join(import.meta.dir, "main.ts");
  const proc = Bun.spawn(["bun", "run", mainPath], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let tmpDir: string;
let outputFile: string;
let summaryFile: string;
let server: Server | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-annotate-test-"));
  outputFile = join(tmpDir, "output");
  summaryFile = join(tmpDir, "summary");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
});

afterEach(() => {
  if (server !== null) {
    server.stop(true);
    server = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseInputs = {
  service: "payment-service",
  environment: "prod",
  status: "success",
  token: "deploy-token-secret",
  sha: "abc123",
  "target-ref": "refs/heads/main",
  "started-at": "1715000000000",
  "finished-at": "1715000060000",
  "run-id": "12345",
  "job-id": "67890",
  "workflow-url": "https://github.com/example/repo/actions/runs/12345",
};

describe("annotate-action main()", () => {
  test("200 → exit 0, writes outputs and summary", async () => {
    const mock = startMockGateway(() => ({
      status: 200,
      body: {
        external_id: "github-actions:run-12345:job-67890",
        service: "payment-service",
        stored_at_ms: 1715000061000,
        is_new: true,
        dora_eligible: true,
      },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(0);
    expect(mock.requests.length).toBe(1);
    const req = mock.requests[0];
    expect(req?.authorization).toBe("Bearer deploy-token-secret");
    expect(req?.contentType).toContain("application/json");
    const body = req?.body as Record<string, unknown>;
    expect(body.service).toBe("payment-service");
    expect(body.environment).toBe("prod");
    expect(body.provider).toBe("github-actions");
    expect(body.status).toBe("success");
    expect(body.sha).toBe("abc123");
    expect(body.ref).toBe("refs/heads/main");
    expect(body.started_at_ms).toBe(1715000000000);
    expect(body.finished_at_ms).toBe(1715000060000);

    const outputText = readFileSync(outputFile, "utf8");
    expect(outputText).toContain("external-id<<");
    expect(outputText).toContain("github-actions:run-12345:job-67890");
    expect(outputText).toContain("is-new<<");
    expect(outputText).toContain("\ntrue\n");
    expect(outputText).toContain("dora-eligible<<");

    const summaryText = readFileSync(summaryFile, "utf8");
    expect(summaryText).toContain("Recorded deployment");
    expect(summaryText).toContain("payment-service");
    expect(summaryText).toContain("prod");
  });

  test("200 is_new=false → summary says 'Updated'", async () => {
    const mock = startMockGateway(() => ({
      status: 200,
      body: {
        external_id: "github-actions:run-12345:job-67890",
        service: "payment-service",
        stored_at_ms: 1715000061000,
        is_new: false,
        dora_eligible: false,
      },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(0);
    const summaryText = readFileSync(summaryFile, "utf8");
    expect(summaryText).toContain("Updated deployment");
    expect(summaryText).toContain("not counted in DORA deploy-frequency");
    const outputText = readFileSync(outputFile, "utf8");
    expect(outputText).toContain("\nfalse\n");
  });

  test("401 → exit 1 by default, warning emitted", async () => {
    const mock = startMockGateway(() => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain("401");
    expect(res.stdout).toContain("http_api.deployment_token");
  });

  test("401 with allow-gateway-failure=true → exit 0", async () => {
    const mock = startMockGateway(() => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url, "allow-gateway-failure": "true" },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("::warning::");
  });

  test("429 with Retry-After → exit 1, warning includes retry-after", async () => {
    const mock = startMockGateway(() => ({
      status: 429,
      body: { error: "rate_limited" },
      headers: { "retry-after": "30" },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain("429");
    expect(res.stdout).toContain("30");
  });

  test("503 write_surface_disabled → exit 1, hint surfaced verbatim", async () => {
    const hintText =
      "set http_api.deployment_token via 'nimbus vault set http_api.deployment_token <value>'";
    const mock = startMockGateway(() => ({
      status: 503,
      body: { error: "write_surface_disabled", hint: hintText },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain("nimbus vault set http_api.deployment_token");
  });

  test("503 surface_disabled with allow-gateway-failure=true → exit 0, hint still surfaced", async () => {
    const hintText =
      "set http_api.deployment_token via 'nimbus vault set http_api.deployment_token <value>'";
    const mock = startMockGateway(() => ({
      status: 503,
      body: { error: "write_surface_disabled", hint: hintText },
    }));
    server = mock.server;

    const res = await runAction({
      inputs: { ...baseInputs, "gateway-url": mock.url, "allow-gateway-failure": "true" },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nimbus vault set http_api.deployment_token");
  });

  test("network failure (unreachable port) → exit 1 by default", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadUrl = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);

    const res = await runAction({
      inputs: {
        ...baseInputs,
        "gateway-url": deadUrl,
        "timeout-ms": "1500",
      },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain("unreachable");
  });

  test("network failure with allow-gateway-failure=true → exit 0", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadUrl = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);

    const res = await runAction({
      inputs: {
        ...baseInputs,
        "gateway-url": deadUrl,
        "timeout-ms": "1500",
        "allow-gateway-failure": "true",
      },
      outputFile,
      summaryFile,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("::warning::");
  });

  test("missing required input: service → exit 1 with error annotation", async () => {
    const inputs = { ...baseInputs } as Record<string, string>;
    delete inputs.service;
    const res = await runAction({ inputs, outputFile, summaryFile });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("::error::");
    expect(res.stdout).toContain("service");
  });

  test("missing required input: token → exit 1 with error annotation", async () => {
    const inputs = { ...baseInputs } as Record<string, string>;
    delete inputs.token;
    const res = await runAction({ inputs, outputFile, summaryFile });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("::error::");
    expect(res.stdout).toContain("token");
  });

  test("optional fields are dropped from payload when empty", async () => {
    const mock = startMockGateway(() => ({
      status: 200,
      body: {
        external_id: "github-actions:run-X",
        service: "payment-service",
        stored_at_ms: 1715000061000,
        is_new: true,
        dora_eligible: true,
      },
    }));
    server = mock.server;

    const inputs: Record<string, string> = {
      service: "payment-service",
      environment: "prod",
      status: "success",
      token: "t",
      sha: "abc123",
      "target-ref": "refs/heads/main",
      "started-at": "1715000000000",
      "gateway-url": mock.url,
    };

    const res = await runAction({ inputs, outputFile, summaryFile });
    expect(res.exitCode).toBe(0);
    const body = mock.requests[0]?.body as Record<string, unknown>;
    expect(body.workflow_url).toBeUndefined();
    expect(body.run_id).toBeUndefined();
    expect(body.job_id).toBeUndefined();
    expect(body.finished_at_ms).toBeUndefined();
  });
});

describe("safe* sanitizers", () => {
  test("safeString strips denied control chars and truncates", () => {
    expect(safeString("a\x00b\x1fc", 10)).toBe("abc");
    expect(safeString("abcdef", 3)).toBe("abc");
    expect(safeString(123, 10)).toBe("");
  });

  test("safeInt truncates finite numbers and zeroes the rest", () => {
    expect(safeInt(3.9)).toBe(3);
    expect(safeInt("42")).toBe(42);
    expect(safeInt("nope")).toBe(0);
    expect(safeInt(undefined)).toBe(0);
  });

  test("safeBool is true only for a literal true", () => {
    expect(safeBool(true)).toBe(true);
    expect(safeBool("true")).toBe(false);
    expect(safeBool(1)).toBe(false);
  });

  test("safeAnnotateEnvelope sanitizes every field with defaults", () => {
    expect(
      safeAnnotateEnvelope({
        external_id: "dep\x00-1",
        service: "checkout",
        stored_at_ms: "1700",
        is_new: true,
        dora_eligible: false,
      }),
    ).toEqual({
      external_id: "dep-1",
      service: "checkout",
      stored_at_ms: 1700,
      is_new: true,
      dora_eligible: false,
    });
    expect(safeAnnotateEnvelope(null)).toEqual({
      external_id: "",
      service: "",
      stored_at_ms: 0,
      is_new: false,
      dora_eligible: false,
    });
  });
});

describe("getInput family (annotate)", () => {
  const touched: string[] = [];
  function setInput(name: string, value: string): void {
    const key = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    process.env[key] = value;
    touched.push(key);
  }
  afterEach(() => {
    for (const key of touched.splice(0)) {
      delete process.env[key];
    }
  });

  test("reads INPUT_<NAME>, booleans, and ints with fallbacks", () => {
    setInput("service", "checkout");
    setInput("flag", "yes");
    setInput("count", "9");
    setInput("bad", "x");
    expect(getInput("service")).toBe("checkout");
    expect(getInput("unset")).toBe("");
    expect(getBooleanInput("flag")).toBe(true);
    expect(getBooleanInput("unset")).toBe(false);
    expect(getIntInput("count", 1)).toBe(9);
    expect(getIntInput("bad", 1)).toBe(1);
    expect(getIntInput("unset", 5)).toBe(5);
  });
});
