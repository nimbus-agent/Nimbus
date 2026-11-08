// packages/gateway/src/engine/audit-files.test.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  COMMIT_WRITE_ACTION_TYPES,
  carriesFileText,
  commitFilesDigest,
  omitFileText,
  withoutFileText,
} from "./audit-files.ts";
import { serviceOf } from "./service-of.ts";

const FILES = [
  { path: "a.ts", content: "héllo" },
  { path: "b.md", content: "x" },
];

describe("omitFileText", () => {
  test("nested: files become a count and the UTF-8 size; everything else is kept", () => {
    const payload = { mcpToolId: "t", input: { owner: "o", message: "m", files: FILES } };
    expect(omitFileText(payload)).toEqual({
      mcpToolId: "t",
      input: { owner: "o", message: "m", files: { count: 2, contentBytes: 7 } },
    });
    expect(payload.input.files).toBe(FILES);
  });

  test("flat: the same at the payload root; an empty list is a well-formed count of 0", () => {
    expect(omitFileText({ owner: "o", files: FILES })).toEqual({
      owner: "o",
      files: { count: 2, contentBytes: 7 },
    });
    expect(omitFileText({ files: [] })).toEqual({ files: { count: 0, contentBytes: 0 } });
  });

  test("no files key: undefined", () => {
    expect(omitFileText({})).toBeUndefined();
    expect(omitFileText({ input: { owner: "o" } })).toBeUndefined();
  });

  test("a malformed list becomes { count, malformed: true } and its text is NEVER kept", () => {
    const secret = "SECRET-FILE-TEXT";
    for (const [files, count] of [
      [[{ path: "a", content: secret }, { path: "b" }], 2],
      [[{ content: secret }], 1],
      [[{ path: 1, content: secret }], 1],
      [[null, { path: "a", content: secret }], 2],
      [[{ path: "a", content: secret, mode: "100755" }, "x"], 2],
      [secret, 0],
      [{ path: "a", content: secret }, 0],
    ] as Array<[unknown, number]>) {
      for (const payload of [{ files }, { mcpToolId: "t", input: { files } }]) {
        const out = omitFileText(payload);
        expect(JSON.stringify(out), JSON.stringify(files)).not.toContain(secret);
        expect(JSON.stringify(out)).toContain(`"count":${String(count)},"malformed":true`);
      }
    }
  });

  test("a non-object input falls back to the root list", () => {
    expect(omitFileText({ input: "x", files: FILES })).toEqual({
      input: "x",
      files: { count: 2, contentBytes: 7 },
    });
  });
});

describe("withoutFileText: only the commit action types and their prepare reads", () => {
  const PREPARE_TYPES = ["github.write.prepare", "gitlab.write.prepare"];

  test("the recognised types are exactly the bound rows' types and their prepare reads", () => {
    const bound = CONNECTOR_WRITE_ROWS.filter((r) => r.bound !== undefined);
    expect([...COMMIT_WRITE_ACTION_TYPES].sort()).toEqual(bound.map((r) => r.actionType).sort());
    expect(bound.map((r) => `${serviceOf(r.actionType)}.write.prepare`).sort()).toEqual(
      PREPARE_TYPES,
    );
    for (const type of [...COMMIT_WRITE_ACTION_TYPES, ...PREPARE_TYPES]) {
      expect(carriesFileText(type), type).toBe(true);
    }
    for (const type of [
      "slack.write.prepare",
      "github.write.prepare.x",
      "github.write",
      "github",
      "",
      "mcp_files.tool.run",
    ]) {
      expect(carriesFileText(type), type).toBe(false);
    }
  });

  test("the write and the prepare read lose their file text, nested", () => {
    for (const type of [...COMMIT_WRITE_ACTION_TYPES, ...PREPARE_TYPES]) {
      const out = withoutFileText({ type, payload: { mcpToolId: "t", input: { files: FILES } } });
      expect(JSON.stringify(out), type).not.toContain("héllo");
      expect(JSON.stringify(out), type).toContain('"contentBytes":7');
    }
  });

  test("any other action keeps its detail, a user-MCP files argument included (I42)", () => {
    for (const type of [
      "mcp_files.tool.run",
      "ext_x.run",
      "github.pr.merge",
      "slack.message.post",
    ]) {
      const action = { type, payload: { input: { files: FILES } } };
      expect(withoutFileText(action), type).toBe(action);
    }
  });

  test("a commit type without files, or without a payload, is returned as it is", () => {
    const noFiles = { type: "github.file.commit", payload: { input: { owner: "o" } } };
    expect(withoutFileText(noFiles)).toBe(noFiles);
    const bare = { type: "github.file.commit" };
    expect(withoutFileText(bare)).toBe(bare);
  });
});

describe("commitFilesDigest", () => {
  const expected = (files: Array<{ path: string; content: string }>) => {
    const h = createHash("sha256");
    for (const f of files) {
      for (const t of [f.path, f.content]) {
        const b = Buffer.from(t, "utf8");
        const len = Buffer.alloc(8);
        len.writeBigUInt64BE(BigInt(b.length));
        h.update(len).update(b);
      }
    }
    return h.digest("hex");
  };

  test("is the length-prefixed SHA-256 of path and content in dispatch order", () => {
    expect(commitFilesDigest({ input: { files: FILES } })).toBe(expected(FILES));
    expect(commitFilesDigest({ files: FILES })).toBe(expected(FILES));
  });

  test("order, boundaries and bytes all matter", () => {
    const d = (files: Array<{ path: string; content: string }>) => commitFilesDigest({ files });
    expect(d([...FILES].reverse())).not.toBe(d(FILES));
    expect(d([{ path: "ab", content: "c" }])).not.toBe(d([{ path: "a", content: "bc" }]));
    expect(d([{ path: "a", content: "x" }])).not.toBe(d([{ path: "a", content: "x " }]));
    expect(d(FILES)).toBe(d(structuredClone(FILES)));
  });

  test("no payload, no list, or a malformed one: undefined", () => {
    expect(commitFilesDigest(undefined)).toBeUndefined();
    expect(commitFilesDigest({})).toBeUndefined();
    expect(commitFilesDigest({ files: "x" })).toBeUndefined();
    expect(commitFilesDigest({ files: [{ path: "a" }] })).toBeUndefined();
  });
});
