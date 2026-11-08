import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enableWritesPromptLines } from "../connectors/connector-writes/enable-prompt.ts";
import { getModelWriteEnablement } from "../connectors/connector-writes/enablement-store.ts";
import {
  EMPTY_IAC_GRANTS,
  getIacGrants,
  type IacPathDeps,
} from "../connectors/connector-writes/iac-grants.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  handleConnectorWritesDisable,
  handleConnectorWritesEnable,
  handleConnectorWritesStatus,
  type ModelWritesDeps,
} from "./connector-rpc-handlers/model-writes.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-enable-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const work = join(root, "infra");
mkdirSync(work, { recursive: true });
mkdirSync(join(root, "nimbus"), { recursive: true });

const pathDeps: IacPathDeps = {
  platform: process.platform,
  realpath: (p) => realpathSync.native(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  homeDir: join(root, "home"),
  tmpDir: join(root, "tmp"),
  protectedRoots: [join(root, "nimbus")],
  gitScan: () => "clean" as const,
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => db.close());

function deps(approve: boolean, prompts: unknown[] = []): ModelWritesDeps {
  const exec = new ToolExecutor(
    {
      requestApproval: async (_prompt: string, details?: unknown) => {
        prompts.push(details);
        return approve;
      },
    },
    new LocalIndex(db),
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  return {
    db,
    toolExecutor: exec,
    getEnforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }),
    now: () => 1234,
    iacPathDeps: pathDeps,
  };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("connector.writesEnable iac (V85)", () => {
  test("an approved enable stores the canonical directories, clouds, regions and hosts, and approves the rows by name", async () => {
    const res = await handleConnectorWritesEnable(
      {
        service: "iac",
        wave: 4,
        workdirs: [work],
        clouds: ["aws", "gcp"],
        regions: ["eu-west-1"],
        net: ["App.Terraform.io"],
      },
      deps(true),
    );
    expect(res.service).toBe("iac");
    expect(getIacGrants(db)).toEqual({
      workdirs: [work],
      clouds: ["aws", "gcp"],
      regions: ["eu-west-1"],
      net: ["app.terraform.io"],
    });
    const e = getModelWriteEnablement(db, "iac");
    expect(e?.approvedToolIds.has("iac_terraform_apply")).toBe(true);
    expect(e?.approvedToolIds.has("iac_terraform_destroy")).toBe(false);
  });

  test("a declined enable stores nothing", async () => {
    expect(
      await refusal(
        handleConnectorWritesEnable({ service: "iac", wave: 4, workdirs: [work] }, deps(false)),
      ),
    ).toContain("ERR_CONNECTOR_WRITES_DECLINED");
    expect(getIacGrants(db)).toEqual(EMPTY_IAC_GRANTS);
    expect(getModelWriteEnablement(db, "iac")).toBeUndefined();
  });

  test.each([
    ["a missing directory", { workdirs: [join(root, "missing")] }, "IAC_WORKDIR"],
    ["a Nimbus folder", { workdirs: [join(root, "nimbus")] }, "IAC_WORKDIR"],
    ["a relative path", { workdirs: ["infra"] }, "IAC_WORKDIR"],
    ["an unknown cloud", { workdirs: [work], clouds: ["oracle"] }, "IAC_BAD_ARGS"],
    ["a bad region", { workdirs: [work], regions: ["../x"] }, "IAC_BAD_ARGS"],
    ["a wildcard host", { workdirs: [work], net: ["*.example.com"] }, "IAC_BAD_ARGS"],
    ["a host with a path", { workdirs: [work], net: ["example.com/x"] }, "IAC_BAD_ARGS"],
    ["nothing at all", {}, "IAC_BAD_ARGS"],
    ["non-list workdirs", { workdirs: work }, "IAC_BAD_ARGS"],
  ])("refuses %s before any prompt", async (_n, extra, code) => {
    const prompts: unknown[] = [];
    const msg = await refusal(
      handleConnectorWritesEnable({ service: "iac", wave: 4, ...extra }, deps(true, prompts)),
    );
    expect(msg).toContain(`ERR_CONNECTOR_WRITES_${code}`);
    expect(prompts).toEqual([]);
    expect(getIacGrants(db)).toEqual(EMPTY_IAC_GRANTS);
  });

  test("a gateway that cannot see directories refuses (fail closed)", async () => {
    const { iacPathDeps: _unused, ...d } = deps(true);
    expect(
      await refusal(handleConnectorWritesEnable({ service: "iac", wave: 4, workdirs: [work] }, d)),
    ).toContain("ERR_CONNECTOR_WRITES_IAC_UNAVAILABLE");
  });

  test("the prompt names the directories, the environment variable names and the hosts, never a value", async () => {
    const prompts: unknown[] = [];
    await handleConnectorWritesEnable(
      { service: "iac", wave: 4, workdirs: [work], clouds: ["aws"], regions: ["us-east-1"] },
      deps(true, prompts),
    );
    const details =
      (prompts[0] as { payload?: Record<string, unknown> } | undefined)?.payload ?? prompts[0];
    const lines = enableWritesPromptLines(details as Record<string, unknown>) ?? [];
    const text = lines.join("\n");
    expect(text).toContain(work);
    expect(text).toContain("AWS_ACCESS_KEY_ID");
    expect(text).toContain("ec2.*.amazonaws.com");
    expect(text).toContain("Provider and module downloads are not allowed");
    expect(text).toContain("Each apply will still show the plan");
    expect(text).toContain("write access to them");
  });

  describe("the host-enforcement line follows the sandbox's real posture (review 4)", () => {
    type Runner = NonNullable<ModelWritesDeps["sandboxRunner"]>;
    const runner = (o: {
      platform: NodeJS.Platform;
      active: boolean;
      refused?: boolean;
      scope?: "per_port" | "all_or_nothing";
    }): Runner =>
      ({
        platform: o.platform,
        isFullyActive: () => o.active,
        degradedReason: () => (o.active ? null : "no helper"),
        networkRefused: () => o.refused === true,
        ...(o.scope === undefined ? {} : { networkScope: () => o.scope }),
        canConfine: () => null,
      }) as unknown as Runner;

    async function promptText(r: Runner | undefined): Promise<string> {
      const prompts: unknown[] = [];
      await handleConnectorWritesEnable(
        { service: "iac", wave: 4, workdirs: [work] },
        { ...deps(true, prompts), ...(r === undefined ? {} : { sandboxRunner: r }) },
      );
      const details =
        (prompts[0] as { payload?: Record<string, unknown> } | undefined)?.payload ?? prompts[0];
      return (enableWritesPromptLines(details as Record<string, unknown>) ?? []).join("\n");
    }
    const PER_HOST = "Hosts are enforced one by one on this system.";

    test("Linux with the helper claims per-host enforcement", async () => {
      expect(await promptText(runner({ platform: "linux", active: true }))).toContain(PER_HOST);
    });

    test("Linux without the helper (the fallback) does NOT claim it", async () => {
      const text = await promptText(runner({ platform: "linux", active: false }));
      expect(text).not.toContain(PER_HOST);
      expect(text).toContain("limits the port, not the host");
    });

    test("a system that cannot confine a network says Terraform will not start", async () => {
      const text = await promptText(runner({ platform: "linux", active: false, refused: true }));
      expect(text).not.toContain(PER_HOST);
      expect(text).toContain("will not start");
    });

    test("macOS and Windows runners and an absent runner never claim it", async () => {
      for (const r of [
        runner({ platform: "darwin", active: true, scope: "per_port" }),
        runner({ platform: "win32", active: true, scope: "all_or_nothing" }),
        undefined,
      ]) {
        expect(await promptText(r)).not.toContain(PER_HOST);
      }
    });
  });

  test("a payload for iac with no scope is malformed and the prompt is refused", () => {
    expect(enableWritesPromptLines({ service: "iac", maxWave: 4, writes: [] })).toBeUndefined();
  });

  test("status lists the grants; disable drops them and the opt-in", async () => {
    await handleConnectorWritesEnable(
      { service: "iac", wave: 4, workdirs: [work], clouds: ["aws"] },
      deps(true),
    );
    const s = handleConnectorWritesStatus(deps(true)).services.find((x) => x.service === "iac");
    expect(s?.iacGrants?.workdirs).toEqual([work]);
    expect(await handleConnectorWritesDisable({ service: "iac" }, deps(true))).toEqual({
      removed: true,
    });
    expect(getIacGrants(db)).toEqual(EMPTY_IAC_GRANTS);
    expect(getModelWriteEnablement(db, "iac")).toBeUndefined();
    expect(await handleConnectorWritesDisable({ service: "iac" }, deps(true))).toEqual({
      removed: false,
    });
  });

  test("re-enabling replaces the grants, it does not merge", async () => {
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    await handleConnectorWritesEnable(
      { service: "iac", wave: 4, workdirs: [work], clouds: ["aws"] },
      deps(true),
    );
    await handleConnectorWritesEnable({ service: "iac", wave: 4, workdirs: [other] }, deps(true));
    expect(getIacGrants(db)).toEqual({ ...EMPTY_IAC_GRANTS, workdirs: [other] });
  });
});
