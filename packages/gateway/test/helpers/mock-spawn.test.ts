import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockSpawn } from "./mock-spawn.ts";

let mock: MockSpawn;

beforeEach(() => {
  mock = new MockSpawn();
  mock.install();
});

afterEach(() => {
  mock.restore();
});

describe("MockSpawn", () => {
  test("records binary, argv, and env on Bun.spawn calls", async () => {
    mock.respond("aws", { exitCode: 0, stdout: "{}" });
    const proc = Bun.spawn(["aws", "lambda", "list-functions"], {
      env: { AWS_REGION: "us-east-1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(out).toBe("{}");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].binary).toBe("aws");
    expect(mock.calls[0].argv).toEqual(["lambda", "list-functions"]);
    expect(mock.calls[0].env["AWS_REGION"]).toBe("us-east-1");
  });

  test("non-zero exitCode is surfaced", async () => {
    mock.respond("kubectl", { exitCode: 1, stderr: "boom" });
    const proc = Bun.spawn(["kubectl", "get", "pods"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
  });

  test("argvMatch lets the more-specific stub win for matching args", async () => {
    mock.respond(
      "gcloud",
      { exitCode: 0, stdout: '{"name":"proj"}' },
      {
        argvMatch: (a) => a[0] === "projects" && a[1] === "describe",
      },
    );
    mock.respond("gcloud", { exitCode: 1, stdout: "" }); // catch-all
    const proc = Bun.spawn(["gcloud", "projects", "describe", "p"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const text = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(text).toBe('{"name":"proj"}');
  });

  test("throws on unmatched spawn", () => {
    expect(() => Bun.spawn(["unmatched-binary"], { stdout: "pipe", stderr: "pipe" })).toThrow(
      /MockSpawn: no stub matched/,
    );
  });

  test("install twice without restore throws", () => {
    expect(() => mock.install()).toThrow(/install\(\) called twice/);
  });

  test("restore is idempotent (safe to call without install)", () => {
    const fresh = new MockSpawn();
    expect(() => fresh.restore()).not.toThrow();
  });
});
