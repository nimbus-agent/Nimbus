import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main, maskSecret, parseMode, scoresPath, signOptions } from "./main.ts";

describe("parseMode", () => {
  test("accepts check and sign", () => {
    expect(parseMode("check")).toBe("check");
    expect(parseMode("sign")).toBe("sign");
    expect(parseMode("score")).toBe("score");
    expect(parseMode("trust-check")).toBe("trust-check");
    expect(parseMode("trust-sign")).toBe("trust-sign");
  });

  test.each(["", "Check", "sign ", "publish"])("refuses %p with a clear message", (raw) => {
    expect(() => parseMode(raw)).toThrow(
      `input "mode" must be "check", "sign", "score", "trust-check" or "trust-sign"; got ${JSON.stringify(raw)}`,
    );
  });
});

describe("maskSecret", () => {
  test("masks the value, trimmed, and each line, with % escaped", () => {
    const out: string[] = [];
    maskSecret(" a%b \nline2\n", (s) => void out.push(s));
    expect(out).toEqual(["::add-mask::a%25b\n", "::add-mask::line2\n"]);
  });

  test("masks a single-line key once", () => {
    const out: string[] = [];
    maskSecret("AAAA=", (s) => void out.push(s));
    expect(out).toEqual(["::add-mask::AAAA=\n"]);
  });
});

describe("signOptions", () => {
  test("passes the default-branch input on", () => {
    expect(signOptions("/ws", "k", "trunk", undefined)).toEqual({
      workspace: "/ws",
      rootKey: "k",
      defaultBranch: "trunk",
    });
  });

  test("an empty input leaves sign to ask origin", () => {
    expect(signOptions("/ws", "k", "", undefined)).toEqual({ workspace: "/ws", rootKey: "k" });
  });

  test("passes the repository on when set, and not when empty", () => {
    expect(signOptions("/ws", "k", "", "acme/registry")).toEqual({
      workspace: "/ws",
      rootKey: "k",
      repository: "acme/registry",
    });
    expect(signOptions("/ws", "k", "", "")).toEqual({ workspace: "/ws", rootKey: "k" });
  });
});

describe("scoresPath", () => {
  test("defaults to scores.json in the workspace", () => {
    expect(scoresPath(join("/ws"), "")).toBe(join("/ws", "scores.json"));
  });

  test("a relative input is under the workspace; an absolute one is kept", () => {
    expect(scoresPath(join("/ws"), "out/s.json")).toBe(join("/ws", "out", "s.json"));
    const abs = join(process.cwd(), "s.json");
    expect(scoresPath(join("/ws"), abs)).toBe(abs);
  });
});

describe("main", () => {
  const KEYS = [
    "INPUT_MODE",
    "INPUT_ROOT-KEY",
    "INPUT_GITHUB-TOKEN",
    "INPUT_NIMBUS-GATEWAY",
    "GITHUB_BASE_REF",
    "GITHUB_WORKSPACE",
  ] as const;
  let saved: Record<string, string | undefined>;
  let out: string[];
  let realWrite: typeof process.stdout.write;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    out = [];
    realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      out.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.stdout.write = realWrite;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.exitCode = 0;
  });

  test("sign masks the root key before anything else and never prints it", async () => {
    const key = "definitely-not-a-key-but-secret";
    process.env["INPUT_MODE"] = "sign";
    process.env["INPUT_ROOT-KEY"] = key;
    await main();
    expect(process.exitCode).toBe(1);
    expect(out[0]).toBe(`::add-mask::${key}\n`);
    const rest = out.slice(1).join("");
    expect(rest).toContain('::error::input "root-key" is not a registry root key');
    expect(rest).not.toContain(key);
  });

  test("sign without a root key fails the step", async () => {
    process.env["INPUT_MODE"] = "sign";
    delete process.env["INPUT_ROOT-KEY"];
    await main();
    expect(process.exitCode).toBe(1);
    expect(out.join("")).toContain('::error::input "root-key" is required');
  });

  test("a refused check fails the step with an error annotation", async () => {
    process.env["INPUT_MODE"] = "check";
    delete process.env["GITHUB_BASE_REF"];
    await main();
    expect(process.exitCode).toBe(1);
    expect(out.join("")).toContain("::error::check runs on pull_request");
  });

  test.each(["root-key", "github-token"])(
    "score refuses a %s input (R8: the job that runs extension code holds no secret)",
    async (name) => {
      const value = "definitely-secret-value";
      process.env["INPUT_MODE"] = "score";
      process.env[`INPUT_${name.toUpperCase()}`] = value;
      await main();
      expect(process.exitCode).toBe(1);
      const all = out.join("");
      expect(all).toContain(`::add-mask::${value}`);
      expect(all).toContain(`::error::input "${name}" must not be set in score mode`);
      expect(all.replace(`::add-mask::${value}`, "")).not.toContain(value);
      expect(process.env[`INPUT_${name.toUpperCase()}`]).toBeUndefined();
    },
  );

  test("score with a relative nimbus-gateway fails the step", async () => {
    process.env["INPUT_MODE"] = "score";
    process.env["INPUT_NIMBUS-GATEWAY"] = "nimbus-gateway";
    await main();
    expect(process.exitCode).toBe(1);
    expect(out.join("")).toContain('::error::input "nimbus-gateway" must be an absolute path');
  });

  test("an unknown mode fails the step", async () => {
    process.env["INPUT_MODE"] = "publish";
    await main();
    expect(process.exitCode).toBe(1);
    expect(out.join("")).toContain(
      '::error::input "mode" must be "check", "sign", "score", "trust-check" or "trust-sign"',
    );
  });
});
