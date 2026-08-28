import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * `packages/cli` keeps a PRIVATE copy of the gateway's route-status type — a shared type is
 * forbidden by the IPC-only dependency rule — and until now nothing pinned the copy to the
 * payload. That has already broken `nimbus llm status` once with the whole suite green, because
 * the CLI tests mock the IPC client wholesale and never see a real payload.
 *
 * This closes the drift without introducing a shared type. It does NOT make the CLI tests
 * exercise a real payload; that bound survives, and is stated here so nobody reads this test as
 * more than it is.
 */
describe("CLI RouteStatus is field-for-field the gateway's LlmRouteStatus", () => {
  function fieldsOf(src: string, typeName: string): string[] {
    const at = src.search(new RegExp(`(export )?type ${typeName} = \\{`));
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("};", at));
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] as string).sort();
  }

  test("field names match one-for-one", async () => {
    const repo = resolve(import.meta.dir, "../../../..");
    const cli = await readFile(resolve(repo, "packages/cli/src/commands/llm.ts"), "utf8");
    const gw = await readFile(resolve(repo, "packages/gateway/src/ipc/llm-rpc.ts"), "utf8");

    const cliFields = fieldsOf(cli, "RouteStatus");
    // Guard against the scan silently matching nothing and comparing [] to []: a structural test
    // that reads no fields would pass for any pair of files.
    expect(cliFields.length).toBeGreaterThan(3);
    expect(cliFields).toEqual(fieldsOf(gw, "LlmRouteStatus"));
  });
});
