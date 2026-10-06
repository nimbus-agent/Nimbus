import { describe, expect, it } from "bun:test";
import { buildRevokeGrantsArgv } from "./win32-argv.ts";
import {
  legacyDataDirGrantIds,
  revokeLegacyDataDirGrants,
  SANDBOX_CWD_MIGRATION_MARKER,
} from "./win32-reap.ts";

const logger = () => {
  const warns: unknown[] = [];
  return {
    warns,
    info: () => {},
    warn: (...a: unknown[]) => {
      warns.push(a);
    },
  };
};

describe("legacyDataDirGrantIds", () => {
  it("covers first-party, bundled-without-table-entry and user ids; excludes filesystem", () => {
    const ids = legacyDataDirGrantIds(["mcp_a"]);
    expect(ids).toContain("com.nimbus.github");
    expect(ids).toContain("com.nimbus.github-actions");
    expect(ids).toContain("com.nimbus.cloud-logging");
    expect(ids).toContain("user.mcp_a");
    expect(ids).not.toContain("com.nimbus.filesystem");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("revokeLegacyDataDirGrants", () => {
  it("marker name is verbatim", () => {
    expect(SANDBOX_CWD_MIGRATION_MARKER).toBe("sandbox-cwd-migration-v1.done");
  });

  it("skips when the marker exists", async () => {
    let calls = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D",
      ids: ["a"],
      run: async () => {
        calls++;
      },
      markerExists: () => true,
      writeMarker: () => {},
      logger: logger(),
    });
    expect(r).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("revokes each id once, writes the marker, returns done", async () => {
    const seen: string[][] = [];
    let marker = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D:data",
      ids: ["a", "b"],
      run: async (argv) => {
        seen.push(argv);
      },
      markerExists: () => false,
      writeMarker: () => {
        marker++;
      },
      logger: logger(),
    });
    expect(r).toBe("done");
    expect(marker).toBe(1);
    expect(seen).toEqual(
      ["a", "b"].map((id) =>
        buildRevokeGrantsArgv(
          { id, permissions: { network: [], filesystem: { read: [], write: [] } } },
          { cwd: "D:data" },
        ),
      ),
    );
  });

  it("a rejecting run still visits every id, writes no marker, warns once", async () => {
    const l = logger();
    let calls = 0;
    let marker = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D",
      ids: ["a", "b", "c"],
      run: async () => {
        calls++;
        if (calls === 2) throw new Error("boom");
      },
      markerExists: () => false,
      writeMarker: () => {
        marker++;
      },
      logger: l,
    });
    expect(r).toBe("partial");
    expect(calls).toBe(3);
    expect(marker).toBe(0);
    expect(l.warns).toHaveLength(1);
  });
});
