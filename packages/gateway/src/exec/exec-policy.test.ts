import { describe, expect, test } from "bun:test";
import { buildExecPolicy, ExecPolicyError } from "./exec-policy.ts";

const ABS = process.platform === "win32" ? "C:\\tmp\\work" : "/tmp/work";
const ABS2 = process.platform === "win32" ? "C:\\tmp\\other" : "/tmp/other";

describe("buildExecPolicy", () => {
  test("network is always empty", () => {
    const p = buildExecPolicy("e1", { fsRead: [ABS], fsWrite: [] });
    expect(p.permissions.network).toEqual([]);
  });

  test("a REQUESTED network grant is rejected, never silently dropped", () => {
    try {
      buildExecPolicy("e1", { fsRead: [], fsWrite: [], network: ["example.com"] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecPolicyError);
      expect((e as ExecPolicyError).code).toBe("ERR_EXEC_NETWORK_UNSUPPORTED");
    }
  });

  test("an empty requested network array is fine (nothing was asked for)", () => {
    expect(() => buildExecPolicy("e1", { fsRead: [], fsWrite: [], network: [] })).not.toThrow();
  });

  test("a RELATIVE path is rejected, not resolved gateway-side", () => {
    try {
      buildExecPolicy("e1", { fsRead: ["./src"], fsWrite: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ExecPolicyError).code).toBe("ERR_EXEC_RELATIVE_PATH");
    }
  });

  test("rejects a relative WRITE path too", () => {
    expect(() => buildExecPolicy("e1", { fsRead: [], fsWrite: ["out"] })).toThrow(ExecPolicyError);
  });

  test("rejects a bare filename, which is the easiest relative path to miss", () => {
    expect(() => buildExecPolicy("e1", { fsRead: ["notes.txt"], fsWrite: [] })).toThrow(
      ExecPolicyError,
    );
  });

  test("carries absolute grants through and names the policy by execution id", () => {
    const p = buildExecPolicy("exec-42", { fsRead: [ABS], fsWrite: [ABS2] });
    expect(p.id).toBe("exec-exec-42");
    expect(p.permissions.filesystem.read).toEqual([ABS]);
    expect(p.permissions.filesystem.write).toEqual([ABS2]);
  });

  test("copies the grant arrays rather than aliasing the caller's", () => {
    // The policy crosses into the sandbox runners; a caller mutating its own array afterwards
    // must not be able to widen a policy that was already approved.
    const caller = [ABS];
    const p = buildExecPolicy("e1", { fsRead: caller, fsWrite: [] });
    caller.push(ABS2);
    expect(p.permissions.filesystem.read).toEqual([ABS]);
  });
});
