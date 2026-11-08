import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSandboxPolicy, policyFromManifest } from "./sandbox-policy.ts";
import {
  buildDefaultSeccompFilter,
  buildIacSeccompFilter,
  IAC_ENOSYS_SYSCALLS,
  SYS_KILL_ALWAYS,
  SYSCALL_NR,
} from "./seccomp-filter.ts";

/** Walks the BPF program for syscall `nr` on x86-64 and returns the verdict it reaches. */
function verdict(program: Buffer, nr: number): "allow" | "eperm" | "enosys" | "kill" {
  const n = program.length / 8;
  let acc = 0;
  let pc = 0;
  while (pc < n) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) {
      acc = k === 4 ? 0xc000003e : nr;
      pc += 1;
    } else if (code === 0x15) {
      pc += 1 + (acc === k ? jt : jf);
    } else if (code === 0x06) {
      if (k === 0x7fff0000) return "allow";
      if (k === 0x00050001) return "eperm";
      if (k === 0x00050000 + 38) return "enosys";
      return "kill";
    } else {
      throw new Error(`unexpected opcode ${code.toString(16)}`);
    }
  }
  throw new Error("fell off the end");
}

describe("the iac seccomp program (OR-D2-5)", () => {
  const iac = buildIacSeccompFilter();
  const def = buildDefaultSeccompFilter();
  const pidfdSend = SYSCALL_NR["pidfd_send_signal"] as number;

  it("answers pidfd_send_signal with ENOSYS", () => {
    expect(verdict(iac, pidfdSend)).toBe("enosys");
  });

  it("the default program still kills it", () => {
    expect(verdict(def, pidfdSend)).toBe("kill");
  });

  it("changes nothing else: every other kill entry still kills", () => {
    for (const name of SYS_KILL_ALWAYS) {
      if (IAC_ENOSYS_SYSCALLS.includes(name)) continue;
      expect(verdict(iac, SYSCALL_NR[name] as number)).toBe("kill");
    }
    expect(verdict(iac, SYSCALL_NR["pidfd_getfd"] as number)).toBe("kill");
    expect(verdict(iac, SYSCALL_NR["pidfd_open"] as number)).toBe("allow");
  });

  it("the exception is exactly one call", () => {
    expect([...IAC_ENOSYS_SYSCALLS]).toEqual(["pidfd_send_signal"]);
  });
});

describe("the iacProfile flag", () => {
  it("is never derived from a manifest", () => {
    const p = policyFromManifest({
      id: "com.example.x",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      updateChannel: "stable",
      // a hostile manifest object carrying the field is not read
      ...({ iacProfile: true } as object),
    } as never);
    expect(p.iacProfile).toBeUndefined();
  });

  it("round-trips through the wire only as a boolean", () => {
    const base = { id: "a", permissions: { network: [], filesystem: { read: [], write: [] } } };
    expect(parseSandboxPolicy(JSON.stringify({ ...base, iacProfile: true })).iacProfile).toBe(true);
    expect(parseSandboxPolicy(JSON.stringify(base)).iacProfile).toBeUndefined();
    expect(() => parseSandboxPolicy(JSON.stringify({ ...base, iacProfile: "yes" }))).toThrow();
  });

  it("is set by wrapIacServerSpec and by no other wrapper", async () => {
    const { wrapIacServerSpec, wrapServerSpec, wrapServerSpecInCwd } = await import(
      "../../connectors/lazy-mesh/wrap-server-spec.ts"
    );
    const { SANDBOX_POLICY_ENV } = await import("./sandbox-policy.ts");
    const manifest = {
      id: "com.nimbus.iac-plan.abc",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      updateChannel: "stable" as const,
    };
    const spec = { command: "x", args: [], env: {} };
    const flag = (s: { env: Record<string, string> }): boolean | undefined =>
      parseSandboxPolicy(s.env[SANDBOX_POLICY_ENV] ?? "").iacProfile;
    expect(flag(wrapIacServerSpec(spec, manifest, join("/", "tmp", "c")))).toBe(true);
    expect(flag(wrapServerSpecInCwd(spec, manifest, join("/", "tmp", "c")))).toBeUndefined();
    expect(flag(wrapServerSpec(spec, manifest, join("/", "tmp")))).toBeUndefined();
    // A ServerSpec cannot smuggle the flag in: the wrapper writes the policy after the spec's env.
    const smuggled = { ...spec, env: { [SANDBOX_POLICY_ENV]: '{"iacProfile":true}' } };
    expect(flag(wrapServerSpecInCwd(smuggled, manifest, join("/", "tmp", "c")))).toBeUndefined();
  });

  it("the Linux runner reads it in one place only", () => {
    const src = readFileSync(join(import.meta.dir, "linux.ts"), "utf8");
    expect(src.match(/\.iacProfile\s*===/g)?.length).toBe(1);
  });
});
