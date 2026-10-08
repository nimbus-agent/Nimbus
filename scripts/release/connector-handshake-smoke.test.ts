import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DUMMY_ENV,
  EXPECTED_SERVER_NAME,
  explainNoAnswer,
  findResponse,
  judgeInitialize,
  judgeToolsList,
  main,
  splitJsonRpcLines,
} from "./connector-handshake-smoke.ts";

describe("splitJsonRpcLines", () => {
  test("returns complete messages and keeps the unterminated tail", () => {
    const { messages, rest } = splitJsonRpcLines(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"res',
    );
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(rest).toBe('{"jsonrpc":"2.0","id":2,"res');
  });

  test("drops non-JSON and non-object lines instead of throwing", () => {
    const { messages } = splitJsonRpcLines('starting up\n[1,2]\n"str"\n\n{"id":3,"result":{}}\n');
    expect(messages).toEqual([{ id: 3, result: {} }]);
  });

  test("tolerates CRLF framing", () => {
    const { messages, rest } = splitJsonRpcLines('{"id":1,"result":{}}\r\n');
    expect(messages).toEqual([{ id: 1, result: {} }]);
    expect(rest).toBe("");
  });
});

describe("findResponse", () => {
  test("matches a response by id, never a request or notification with the same id", () => {
    const msgs = [
      { jsonrpc: "2.0", id: 2, method: "elicitation/create", params: {} },
      { jsonrpc: "2.0", method: "notifications/message" },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ];
    expect(findResponse(msgs, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(findResponse(msgs, 1)).toBeUndefined();
  });
});

describe("judgeInitialize", () => {
  test("passes a result with serverInfo", () => {
    expect(judgeInitialize({ id: 1, result: { serverInfo: { name: "nimbus-github" } } })).toEqual({
      ok: true,
      detail: "nimbus-github",
    });
  });

  test("FAILS a server that answers under a different name than the id must map to", () => {
    const v = judgeInitialize(
      { id: 1, result: { serverInfo: { name: "nimbus-gitlab" } } },
      "nimbus-github",
    );
    expect(v.ok).toBe(false);
    expect(judgeInitialize({ id: 1, result: { serverInfo: {} } }, "nimbus-github").ok).toBe(false);
    expect(
      judgeInitialize({ id: 1, result: { serverInfo: { name: "nimbus-github" } } }, "nimbus-github")
        .ok,
    ).toBe(true);
  });

  test("fails an error response and a result without serverInfo", () => {
    expect(judgeInitialize({ id: 1, error: { code: -32600, message: "bad" } }).ok).toBe(false);
    expect(judgeInitialize({ id: 1, result: {} }).ok).toBe(false);
    expect(judgeInitialize({ id: 1, result: null }).ok).toBe(false);
  });
});

describe("judgeToolsList", () => {
  test("passes a non-empty array of named tools", () => {
    const v = judgeToolsList({ id: 2, result: { tools: [{ name: "a" }, { name: "b" }] } });
    expect(v.ok).toBe(true);
  });

  test("FAILS an empty tools array — the state the check exists to catch", () => {
    const v = judgeToolsList({ id: 2, result: { tools: [] } });
    expect(v).toEqual({ ok: false, why: "tools/list returned an EMPTY tools array" });
  });

  test("fails a missing/non-array tools field, an unnamed tool, and an error response", () => {
    expect(judgeToolsList({ id: 2, result: {} }).ok).toBe(false);
    expect(judgeToolsList({ id: 2, result: { tools: "x" } }).ok).toBe(false);
    expect(judgeToolsList({ id: 2, result: { tools: [{ name: "" }] } }).ok).toBe(false);
    expect(judgeToolsList({ id: 2, result: { tools: [{}] } }).ok).toBe(false);
    expect(judgeToolsList({ id: 2, error: { code: -32601, message: "nope" } }).ok).toBe(false);
  });
});

describe("explainNoAnswer", () => {
  test("names a credential refusal explicitly — and it is still reported as a failure reason", () => {
    const why = explainNoAnswer("tools/list", "Error: GITHUB_PAT is not set\n    at x", 1, false);
    expect(why).toContain("missing credential");
    expect(why).toContain("GITHUB_PAT is not set");
  });

  test("distinguishes a timeout, a silent exit and a crash", () => {
    expect(explainNoAnswer("initialize", "", null, true)).toContain("no initialize response");
    expect(explainNoAnswer("initialize", "", 0, false)).toBe(
      "connector exited 0 before initialize with no output",
    );
    expect(explainNoAnswer("initialize", "\nTypeError: boom\n", 1, false)).toBe(
      "connector exited 1 before initialize: TypeError: boom",
    );
  });
});

describe("main", () => {
  test("defines a dummy credential for github under the env var the connector reads", () => {
    expect(DUMMY_ENV["github"]).toEqual({ GITHUB_PAT: "install-smoke-dummy-token" });
  });

  test("the github dummy env var is the one the INSTALLED connector package actually reads", () => {
    // Resolved from the gateway workspace, which is the package that depends on the connectors.
    const pkgJson = Bun.resolveSync(
      "@nimbus-dev/connectors/package.json",
      join(import.meta.dir, "..", "..", "packages", "gateway"),
    );
    const src = readFileSync(
      join(dirname(pkgJson), "connectors", "github", "src", "tools.ts"),
      "utf8",
    );
    for (const name of Object.keys(DUMMY_ENV["github"] ?? {})) {
      expect(src).toContain(`requireProcessEnv("${name}")`);
    }
  });

  test("the expected github server name is the one the INSTALLED connector package declares", () => {
    const pkgJson = Bun.resolveSync(
      "@nimbus-dev/connectors/package.json",
      join(import.meta.dir, "..", "..", "packages", "gateway"),
    );
    const src = readFileSync(
      join(dirname(pkgJson), "connectors", "github", "src", "server.ts"),
      "utf8",
    );
    expect(src).toContain(`name: "${EXPECTED_SERVER_NAME["github"] ?? "?"}"`);
  });

  test("usage errors exit 2 without spawning anything", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["/nonexistent/gateway", "no-such-connector"])).toBe(2);
  });

  test("a binary that cannot be spawned FAILS (exit 1), never passes", async () => {
    expect(await main([join(import.meta.dir, "no-such-gateway-binary"), "github"])).toBe(1);
  });
});
