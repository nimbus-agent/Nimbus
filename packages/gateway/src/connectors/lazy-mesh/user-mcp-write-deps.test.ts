// The production facts of the user MCP write-directory rule, and the reader the executors use
// (I15; Phase 28 AD5b-2).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { formatConsentPrompt } from "../../engine/executor.ts";
import { USER_MCP_WRITE_HEADER } from "../../engine/user-mcp-write-lines.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import { insertUserMcpConnector, type UserMcpConnectorRow } from "../user-mcp-store.ts";
import { userMcpWriteGrantsReader } from "../user-mcp-write-reader.ts";
import {
  productionWriteDirDeps,
  registeredWriteDirsOf,
  serverCodePathsOf,
} from "./user-mcp-write-deps.ts";

function row(over: Partial<UserMcpConnectorRow> = {}): UserMcpConnectorRow {
  return {
    service_id: "mcp_notes",
    command: "/opt/srv/bin/notes",
    args_json: "[]",
    created_at: 1,
    read_paths_json: "[]",
    net_hosts_json: "[]",
    model_access: 0,
    write_paths_json: "[]",
    ...over,
  };
}

const PATHS: PlatformPaths = {
  configDir: "/n/config",
  dataDir: "/n/data",
  logDir: "/elsewhere/logs",
  socketPath: "/n/sock",
  extensionsDir: "/n/ext",
  tempDir: "/n/tmp",
  sandboxDir: "/n/cache/sandbox",
};

describe("serverCodePathsOf", () => {
  test("the command's directory and every absolute argument of every server", () => {
    expect(
      serverCodePathsOf(
        [
          row({ args_json: JSON.stringify(["/srv/notes/main.js", "--quiet", "relative.js"]) }),
          row({ service_id: "mcp_b", command: "/usr/local/bin/tool" }),
        ],
        "linux",
      ),
    ).toEqual(["/opt/srv/bin", "/srv/notes/main.js", "/usr/local/bin"]);
  });

  test("a relative command contributes no directory; malformed or non-array arguments contribute nothing", () => {
    expect(serverCodePathsOf([row({ command: "node" })], "linux")).toEqual([]);
    expect(serverCodePathsOf([row({ args_json: "not json" })], "linux")).toEqual(["/opt/srv/bin"]);
    expect(serverCodePathsOf([row({ args_json: '{"a":1}' })], "linux")).toEqual(["/opt/srv/bin"]);
    expect(serverCodePathsOf([row({ args_json: '[1, "/abs"]' })], "linux")).toEqual([
      "/opt/srv/bin",
      "/abs",
    ]);
  });

  test("Windows paths are parsed as Windows paths on any host", () => {
    expect(
      serverCodePathsOf(
        [row({ command: "C:\\tools\\srv.exe", args_json: JSON.stringify(["D:\\data\\x.js"]) })], // cross-platform-ok
        "win32",
      ),
    ).toEqual(["C:\\tools", "D:\\data\\x.js"]); // cross-platform-ok
  });
});

describe("registeredWriteDirsOf", () => {
  const rows = [
    row({ write_paths_json: JSON.stringify(["/a/out"]) }),
    row({ service_id: "mcp_b", write_paths_json: JSON.stringify(["/b/out", "/b/more"]) }),
    row({ service_id: "mcp_c", write_paths_json: "broken" }),
  ];

  test("every server's write directories; a malformed list contributes none", () => {
    expect(registeredWriteDirsOf(rows)).toEqual(["/a/out", "/b/out", "/b/more"]);
  });

  test("one server can be left out (a registration is not its own conflict)", () => {
    expect(registeredWriteDirsOf(rows, "mcp_b")).toEqual(["/a/out"]);
  });
});

describe("productionWriteDirDeps", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function deps(
    platform: NodeJS.Platform,
    env: Record<string, string | undefined>,
    rows: UserMcpConnectorRow[] = [],
    workdirs: string[] = [],
  ) {
    return productionWriteDirDeps({
      paths: PATHS,
      platform,
      listRows: () => rows,
      iacWorkdirs: () => workdirs,
      envVar: (name) => env[name],
    });
  }

  test("the protected roots are the iac list plus the log folder, read at each call", () => {
    const d = deps("linux", { XDG_RUNTIME_DIR: "/run/user/1000" });
    const roots = d.protectedRoots();
    for (const r of [PATHS.dataDir, PATHS.configDir, PATHS.sandboxDir, PATHS.extensionsDir]) {
      expect(roots).toContain(r);
    }
    expect(roots).toContain("/elsewhere/logs");
    expect(roots).toContain("/run/user/1000");
    expect(deps("darwin", { XDG_RUNTIME_DIR: "/run/user/1000" }).protectedRoots()).not.toContain(
      "/run/user/1000",
    );
  });

  test("PATH is split with the host delimiter; Windows also reads Path; an unset one is empty", () => {
    expect(deps("linux", { PATH: ["/usr/bin", "/opt/bin"].join(delimiter) }).pathEntries).toEqual([
      "/usr/bin",
      "/opt/bin",
    ]);
    expect(deps("win32", { Path: "C:/a" }).pathEntries).toEqual(["C:/a"]);
    expect(deps("linux", {}).pathEntries).toEqual([""]);
  });

  test("the application-data folders are named on Windows only, and only when set", () => {
    expect(deps("win32", { APPDATA: "C:/r", LOCALAPPDATA: "C:/l" }).appDataDirs).toEqual([
      "C:/r",
      "C:/l",
    ]);
    expect(deps("win32", { APPDATA: "", LOCALAPPDATA: "C:/l" }).appDataDirs).toEqual(["C:/l"]);
    expect(deps("linux", { APPDATA: "C:/r" }).appDataDirs).toEqual([]);
  });

  test("the iac working directories and the servers' code are read live", () => {
    const rows: UserMcpConnectorRow[] = [];
    const workdirs: string[] = [];
    const d = deps("linux", {}, rows, workdirs);
    expect(d.serverCodePaths()).toEqual([]);
    expect(d.iacWorkdirs()).toEqual([]);
    rows.push(row());
    workdirs.push("/infra/prod");
    expect(d.serverCodePaths()).toEqual(["/opt/srv/bin"]);
    expect(d.iacWorkdirs()).toEqual(["/infra/prod"]);
  });

  test("the file-system reads are the real ones: realpath, lstat, exists and the tree scan", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-write-deps-")));
    temps.push(root);
    const dir = join(root, "out");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "x");
    const d = deps(process.platform, {});
    expect(d.realpath(dir)).toBe(dir);
    expect(d.lstat(dir).isDirectory()).toBe(true);
    expect(d.exists(dir)).toBe(true);
    expect(d.exists(join(root, "missing"))).toBe(false);
    expect(d.scan(dir)).toBe("clean");
    mkdirSync(join(dir, ".git"));
    expect(d.scan(dir)).toBe("marker");
    expect(d.homeDir.length).toBeGreaterThan(0);
    expect(d.tmpDir.length).toBeGreaterThan(0);
  });
});

describe("userMcpWriteGrantsReader", () => {
  function open(): Database {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 98);
    return db;
  }
  const base = {
    command: "/opt/srv/bin/notes",
    args_json: "[]",
    read_paths_json: "[]",
    net_hosts_json: "[]",
    model_access: 0,
  };

  test("a registered server: its write directories; one with none: an empty list", () => {
    const db = open();
    try {
      insertUserMcpConnector(db, {
        ...base,
        service_id: "mcp_writer",
        write_paths_json: JSON.stringify(["/out", "/more"]),
      });
      insertUserMcpConnector(db, { ...base, service_id: "mcp_plain" });
      const read = userMcpWriteGrantsReader(() => db);
      expect(read("mcp_writer")).toEqual(["/out", "/more"]);
      expect(read("mcp_plain")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a server that is not registered, a malformed list and an unreadable database cannot be told", () => {
    const db = open();
    try {
      insertUserMcpConnector(db, { ...base, service_id: "mcp_bad", write_paths_json: '{"a":1}' });
      insertUserMcpConnector(db, {
        ...base,
        service_id: "mcp_mixed",
        write_paths_json: '[1,"/x"]',
      });
      insertUserMcpConnector(db, { ...base, service_id: "mcp_broken", write_paths_json: "nope" });
      const read = userMcpWriteGrantsReader(() => db);
      expect(read("mcp_missing")).toBeUndefined();
      expect(read("mcp_bad")).toBeUndefined();
      expect(read("mcp_mixed")).toBeUndefined();
      expect(read("mcp_broken")).toBeUndefined();
    } finally {
      db.close();
    }
    const closed = userMcpWriteGrantsReader(() => {
      throw new Error("database is closed");
    });
    expect(closed("mcp_writer")).toBeUndefined();
  });
});

describe("the registration prompt, through the executor's own prompt builder", () => {
  const payload = {
    serviceId: "mcp_notes",
    command: "/usr/bin/node",
    args: [],
    readPaths: [],
    netHosts: [],
    modelAccess: false,
  };

  test("a registration WITH a write directory gets the purpose-built block and no Details line", () => {
    const prompt = formatConsentPrompt({
      type: "connector.addMcp",
      payload: { ...payload, writePaths: ["/home/me/work/out"], writePlatform: "linux" },
    });
    expect(prompt).toContain("Type: connector.addMcp");
    expect(prompt).toContain("Register a user MCP server: mcp_notes");
    expect(prompt).toContain(USER_MCP_WRITE_HEADER);
    expect(prompt).toContain("  write: /home/me/work/out");
    expect(prompt).not.toContain("Details: ");
  });

  test("a registration with NO write directory keeps the Details line it always had", () => {
    const prompt = formatConsentPrompt({ type: "connector.addMcp", payload });
    expect(prompt).toContain(`Details: ${JSON.stringify(payload)}`);
    expect(prompt).not.toContain("WRITE ACCESS");
  });
});
