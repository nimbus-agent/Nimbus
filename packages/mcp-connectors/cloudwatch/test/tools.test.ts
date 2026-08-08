import { afterEach, describe, expect, it, mock } from "bun:test";
import { CLOUDWATCH_TOOL_NAMES, registerCloudwatchTools } from "../src/tools.ts";

function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: (
      name: string,
      _desc: string,
      _schema: unknown,
      cb: (i: unknown) => Promise<unknown>,
    ) => {
      tools[name] = cb;
    },
    tools,
  };
}

/** Parse the JSON payload from an mcpJsonResult content envelope. */
function parseResult(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const first = (result as { content: { type: string; text: string }[] }).content[0];
    if (first?.type === "text") {
      return JSON.parse(first.text) as unknown;
    }
  }
  return result;
}

describe("registerCloudwatchTools", () => {
  const originalSpawn = Bun.spawn;

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it("registers exactly the expected tool names", () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);
    for (const name of CLOUDWATCH_TOOL_NAMES) {
      expect(typeof tools[name]).toBe("function");
    }
    expect(Object.keys(tools)).toHaveLength(CLOUDWATCH_TOOL_NAMES.length);
  });

  it("cloudwatch_list calls aws cli and returns results", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock(() => {
      const stdoutContent = JSON.stringify({
        logGroups: [{ logGroupName: "test-group-1", arn: "arn:aws:logs:..." }],
      });
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([stdoutContent]),
        stderr: new Blob([""]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    // @ts-expect-error test mock
    const result = parseResult(await tools["cloudwatch_list"]!({})) as {
      logGroups: { logGroupName: string }[];
    };
    expect(result.logGroups).toHaveLength(1);
    expect(result.logGroups[0]?.logGroupName).toBe("test-group-1");

    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[0][0];
    expect(spawnArgs).toEqual([
      "aws",
      "logs",
      "describe-log-groups",
      "--limit",
      "50",
      "--output",
      "json",
    ]);
  });

  it("cloudwatch_list calls aws cli with prefix when provided", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock(() => {
      const stdoutContent = JSON.stringify({
        logGroups: [{ logGroupName: "prefix-group-1", arn: "arn:aws:logs:..." }],
      });
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([stdoutContent]),
        stderr: new Blob([""]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    // @ts-expect-error test mock
    const result = parseResult(await tools["cloudwatch_list"]!({ prefix: "pref" })) as {
      logGroups: { logGroupName: string }[];
    };
    expect(result.logGroups).toHaveLength(1);
    expect(result.logGroups[0]?.logGroupName).toBe("prefix-group-1");

    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[0][0];
    expect(spawnArgs).toEqual([
      "aws",
      "logs",
      "describe-log-groups",
      "--limit",
      "50",
      "--log-group-name-prefix",
      "pref",
      "--output",
      "json",
    ]);
  });

  it("cloudwatch_get calls aws cli and returns match + streams", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock((args: string[]) => {
      let stdoutContent = "";
      if (args.includes("describe-log-groups")) {
        stdoutContent = JSON.stringify({
          logGroups: [{ logGroupName: "exact-group-match", arn: "arn:aws:logs:match" }],
        });
      } else if (args.includes("describe-log-streams")) {
        stdoutContent = JSON.stringify({
          logStreams: [{ logStreamName: "stream-1" }, { logStreamName: "stream-2" }],
        });
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([stdoutContent]),
        stderr: new Blob([""]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    // @ts-expect-error test mock
    const result = parseResult(
      await tools["cloudwatch_get"]!({ logGroupName: "exact-group-match" }),
    ) as {
      logGroup: { logGroupName: string };
      streams: { logStreamName: string }[];
    };
    expect(result.logGroup.logGroupName).toBe("exact-group-match");
    expect(result.streams).toHaveLength(2);
    expect(result.streams[0]?.logStreamName).toBe("stream-1");

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const groupsArgs = mockSpawn.mock.calls[0][0];
    const streamsArgs = mockSpawn.mock.calls[1][0];

    expect(groupsArgs).toEqual([
      "aws",
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      "exact-group-match",
      "--limit",
      "50",
      "--output",
      "json",
    ]);

    expect(streamsArgs).toEqual([
      "aws",
      "logs",
      "describe-log-streams",
      "--log-group-name",
      "exact-group-match",
      "--order-by",
      "LastEventTime",
      "--descending",
      "--limit",
      "50",
      "--output",
      "json",
    ]);
  });

  it("cloudwatch_get returns null logGroup if missing", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock((args: string[]) => {
      let stdoutContent = "";
      if (args.includes("describe-log-groups")) {
        stdoutContent = JSON.stringify({
          logGroups: [{ logGroupName: "other-group", arn: "arn:aws:logs:other" }],
        });
      } else if (args.includes("describe-log-streams")) {
        stdoutContent = JSON.stringify({
          logStreams: [],
        });
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([stdoutContent]),
        stderr: new Blob([""]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    // @ts-expect-error test mock
    const result = parseResult(
      await tools["cloudwatch_get"]!({ logGroupName: "exact-group-match" }),
    ) as {
      logGroup: null;
      streams: unknown[];
    };
    expect(result.logGroup).toBeNull();
    expect(result.streams).toEqual([]);
  });

  it("cloudwatch_search filters groups locally case-insensitively", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock(() => {
      const stdoutContent = JSON.stringify({
        logGroups: [
          { logGroupName: "My-Test-Group" },
          { logGroupName: "another-test" },
          { logGroupName: "unrelated" },
        ],
      });
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([stdoutContent]),
        stderr: new Blob([""]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    // @ts-expect-error test mock
    const result = parseResult(await tools["cloudwatch_search"]!({ query: "TEST" })) as {
      matches: { logGroupName: string }[];
    };
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.logGroupName).toBe("My-Test-Group");
    expect(result.matches[1]?.logGroupName).toBe("another-test");
  });

  it("throws error on non-zero exit code", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock(() => {
      return {
        exited: Promise.resolve(1),
        stdout: new Blob([""]),
        stderr: new Blob(["AccessDeniedException"]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    await expect(tools["cloudwatch_list"]!({})).rejects.toThrow(
      "aws logs describe-log-groups failed: AccessDeniedException",
    );
  });

  it("handles empty string stdout", async () => {
    const { server, tools } = stubServer();
    // @ts-expect-error test mock
    registerCloudwatchTools(server);

    const mockSpawn = mock(() => {
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]), // aws logs describe-log-groups returning empty string
        stderr: new Blob([""]),
      };
    });
    // @ts-expect-error test mock
    Bun.spawn = mockSpawn;

    // @ts-expect-error test mock
    const result = parseResult(await tools["cloudwatch_list"]!({})) as Record<string, never>;
    expect(result).toEqual({});
  });
});
