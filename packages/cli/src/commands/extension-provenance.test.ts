import { describe, expect, test } from "bun:test";
import type { IPCClient } from "@nimbus-dev/client";

import { installedProvenanceLines, runExtensionVerifyProvenance } from "./extension-provenance.ts";

const NOTE =
  "Provenance verified by main: built from cli/cli at e1219499a578 by .github/workflows/deployment.yml@refs/heads/trunk";

function client(reply: unknown): { client: IPCClient; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const c = {
    call: (method: string, params: unknown) => {
      calls.push([method, params]);
      return Promise.resolve(reply);
    },
  } as unknown as IPCClient;
  return { client: c, calls };
}

async function run(reply: unknown, args: string[]) {
  const { client: c, calls } = client(reply);
  let out = "";
  const code = await runExtensionVerifyProvenance(args, {
    client: c,
    out: (s) => {
      out += s;
    },
  });
  return { code, out, calls };
}

describe("installedProvenanceLines", () => {
  test("prints the note, and says when the attestation was kept", () => {
    expect(installedProvenanceLines({ note: NOTE, bundleStored: false })).toEqual([
      `Provenance: ${NOTE}`,
    ]);
    expect(installedProvenanceLines({ note: NOTE, bundleStored: true })[0]).toContain(
      "attestation kept: nimbus extension verify-provenance",
    );
  });

  test("nothing for a missing or off-shape field; control characters are stripped", () => {
    expect(installedProvenanceLines(undefined)).toEqual([]);
    expect(installedProvenanceLines({ note: 3 })).toEqual([]);
    expect(installedProvenanceLines({ note: "a\u001b[31mb" })[0]).not.toContain("\u001b");
  });
});

describe("nimbus extension verify-provenance", () => {
  test("verified: one line, exit 0, and the id goes to the gateway", async () => {
    const r = await run(
      {
        id: "com.x",
        version: "1.0.0",
        status: "verified",
        instance: "public-good",
        note: `${NOTE}; re-verified offline`,
      },
      ["com.x"],
    );
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([["extension.verifyProvenance", { id: "com.x" }]]);
    expect(r.out).toBe(`com.x@1.0.0: ${NOTE}; re-verified offline\n`);
  });

  test("unverified, no bundle and none each exit 1 with their own words", async () => {
    const unverified = await run(
      {
        id: "com.x",
        version: "1.0.0",
        status: "unverified",
        reason: "subject_mismatch",
        note: `${NOTE}; not re-verified offline: it does not name this package`,
      },
      ["com.x"],
    );
    expect(unverified.code).toBe(1);
    expect(unverified.out).toContain("not re-verified offline");
    const noBundle = await run({ id: "com.x", version: "1.0.0", status: "no_bundle", note: NOTE }, [
      "com.x",
    ]);
    expect(noBundle.code).toBe(1);
    expect(noBundle.out).toContain("cannot be re-checked");
    const none = await run({ id: "com.x", version: "1.0.0", status: "none" }, ["com.x"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("no build provenance was recorded");
  });

  test("--json prints the reply; the exit code still follows the status", async () => {
    const r = await run({ id: "com.x", version: "1.0.0", status: "verified", note: NOTE }, [
      "com.x",
      "--json",
    ]);
    expect(JSON.parse(r.out)).toMatchObject({ status: "verified" });
    expect(r.code).toBe(0);
  });

  test("no id is a usage error, before any call", async () => {
    await expect(run({}, ["--json"])).rejects.toThrow("Usage: nimbus extension verify-provenance");
  });
});
