/**
 * `LinuxSecretToolVault` driven through a STAND-IN `secret-tool` (a small script run by the bun
 * binary) rather than the real libsecret keyring, so the vault's own spawn / stdin / exit-code
 * handling runs on every OS — the real-keyring round trip in `vault.test.ts` runs on Linux only.
 * Nothing here touches an OS credential store: the stand-in keeps its "keyring" in a JSON file
 * inside a per-test `mkdtemp` directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractNimbusVaultKeysFromSecretToolSearchOutput,
  LinuxSecretToolVault,
  resolveSecretToolExecutable,
  SECRET_TOOL_FALLBACK_PATH,
  type SecretToolCommand,
} from "./linux.ts";

/**
 * argv: <stateDir> <mode> <secret-tool args...>. Every invocation's secret-tool argv is appended to
 * `argv.log`; `mode = "fail"` exits 3 without touching the store. `store` reads the secret from
 * STDIN, exactly as the real `secret-tool store` does.
 */
const FAKE_SECRET_TOOL = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [stateDir, mode, cmd, ...args] = process.argv.slice(2);
appendFileSync(join(stateDir, "argv.log"), JSON.stringify([cmd, ...args]) + "\\n");
const storePath = join(stateDir, "store.json");
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
const attr = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
if (mode === "fail") {
  process.stderr.write("secret-tool: simulated failure\\n");
  process.exitCode = 3;
} else if (cmd === "store") {
  const value = await Bun.stdin.text();
  store[attr("nimbus-key")] = { label: attr("--label"), value };
  writeFileSync(storePath, JSON.stringify(store));
} else if (cmd === "lookup") {
  const entry = store[attr("nimbus-key")];
  if (entry === undefined) process.exitCode = 1;
  else process.stdout.write(entry.value + "\\n");
} else if (cmd === "clear") {
  delete store[attr("nimbus-key")];
  writeFileSync(storePath, JSON.stringify(store));
} else if (cmd === "search") {
  for (const [key, entry] of Object.entries(store)) {
    process.stdout.write("[/org/freedesktop/secrets/collection/login/" + key + "]\\n");
    process.stdout.write("label = " + entry.label + "\\nsecret = " + entry.value + "\\n");
    process.stderr.write("attribute.application = nimbus\\nattribute.nimbus-key = " + key + "\\n");
  }
} else {
  process.exitCode = 2;
}
`;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type FakeStore = Record<string, { label: string; value: string }>;

function fakeSecretTool(mode: "ok" | "fail" = "ok"): {
  command: SecretToolCommand;
  argvLog: () => string[][];
  store: () => FakeStore;
  /** Pre-populates the stand-in's keyring, as items another writer left there would. */
  seed: (entries: FakeStore) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-linux-vault-"));
  dirs.push(dir);
  const script = join(dir, "fake-secret-tool.mjs");
  writeFileSync(script, FAKE_SECRET_TOOL);
  return {
    command: () => [process.execPath, script, dir, mode],
    argvLog: () => {
      try {
        return readFileSync(join(dir, "argv.log"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string[]);
      } catch {
        return [];
      }
    },
    store: () => JSON.parse(readFileSync(join(dir, "store.json"), "utf8")),
    seed: (entries) => writeFileSync(join(dir, "store.json"), JSON.stringify(entries)),
  };
}

describe("LinuxSecretToolVault through a stand-in secret-tool", () => {
  test("set/get/listKeys/delete round-trip; the secret travels on stdin, never argv", async () => {
    const fake = fakeSecretTool();
    const vault = new LinuxSecretToolVault(fake.command);

    await vault.set("ci.alpha", "s3cr3t-alpha-value");
    await vault.set("github.pat", "ghp_beta_value");

    // The stand-in recorded the value it read from STDIN, under the Nimbus label.
    expect(fake.store()["ci.alpha"]).toEqual({
      label: "Nimbus: ci.alpha",
      value: "s3cr3t-alpha-value",
    });
    // ...and no argv the vault ever passed carries a secret (a process listing would show it).
    const argvText = JSON.stringify(fake.argvLog());
    expect(argvText).not.toContain("s3cr3t-alpha-value");
    expect(argvText).not.toContain("ghp_beta_value");
    expect(fake.argvLog()[0]).toEqual([
      "store",
      "--label",
      "Nimbus: ci.alpha",
      "application",
      "nimbus",
      "nimbus-key",
      "ci.alpha",
    ]);

    // `lookup` output ends in a newline; the vault strips exactly that one.
    expect(await vault.get("ci.alpha")).toBe("s3cr3t-alpha-value");

    // No prefix and an EMPTY prefix both return every key, sorted; a prefix filters.
    expect(await vault.listKeys()).toEqual(["ci.alpha", "github.pat"]);
    expect(await vault.listKeys("")).toEqual(["ci.alpha", "github.pat"]);
    expect(await vault.listKeys("github.")).toEqual(["github.pat"]);
    expect(await vault.listKeys("slack.")).toEqual([]);

    await vault.delete("ci.alpha");
    expect(await vault.get("ci.alpha")).toBeNull();
    expect(await vault.listKeys()).toEqual(["github.pat"]);
    expect(fake.argvLog().map((argv) => argv[0])).toEqual([
      "store",
      "store",
      "lookup",
      "search",
      "search",
      "search",
      "search",
      "clear",
      "lookup",
      "search",
    ]);
  });

  test("a key that was never stored reads as null (lookup exits non-zero)", async () => {
    const fake = fakeSecretTool();
    const vault = new LinuxSecretToolVault(fake.command);
    expect(await vault.get("never.stored")).toBeNull();
    // The null came from a real lookup that missed, not from a get that never asked.
    expect(fake.argvLog()).toEqual([
      ["lookup", "application", "nimbus", "nimbus-key", "never.stored"],
    ]);
  });

  test("an item whose LABEL is not Nimbus's own is still listed, through its nimbus-key attribute", async () => {
    // The stand-in, like `secret-tool search`, prints the label on stdout and the attributes on
    // stderr. An item labelled by some other writer (or an older label format) is visible ONLY
    // through the attribute, which is why `listKeys` captures stderr at all.
    const fake = fakeSecretTool();
    fake.seed({ "legacy.key": { label: "Some other label", value: "legacy-value" } });
    const vault = new LinuxSecretToolVault(fake.command);
    expect(await vault.listKeys()).toEqual(["legacy.key"]);
    expect(await vault.listKeys("other.")).toEqual([]);
  });

  test("a failing secret-tool: set rejects without echoing the secret; reads degrade", async () => {
    const fake = fakeSecretTool("fail");
    const vault = new LinuxSecretToolVault(fake.command);

    const err = await vault.set("ci.gamma", "gamma-secret-value").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Vault operation failed");
    expect((err as Error).message).not.toContain("gamma-secret-value");

    expect(await vault.get("ci.gamma")).toBeNull();
    // A non-zero `search` exit is "no keys", not an exception.
    expect(await vault.listKeys()).toEqual([]);
    // `clear` failing (e.g. the key is absent) is a no-op, not an error.
    await expect(vault.delete("ci.gamma")).resolves.toBeUndefined();
    expect(fake.argvLog().map((argv) => argv[0])).toEqual(["store", "lookup", "search", "clear"]);
  });

  test("an executable that cannot be spawned at all: set rejects, the rest degrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-linux-vault-missing-"));
    dirs.push(dir);
    const missing = join(dir, "no-such-secret-tool");
    const vault = new LinuxSecretToolVault(() => [missing]);

    const err = await vault.set("ci.delta", "delta-secret-value").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // The spawn failure itself surfaces — it is not mislabelled as a secret-tool exit code.
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((err as Error).message).not.toBe("Vault operation failed");
    expect((err as Error).message).not.toContain("delta-secret-value");

    expect(await vault.get("ci.delta")).toBeNull();
    expect(await vault.listKeys("ci.")).toEqual([]);
    await expect(vault.delete("ci.delta")).resolves.toBeUndefined();
  });

  test("an invalid key is refused before anything is spawned", async () => {
    const fake = fakeSecretTool();
    const vault = new LinuxSecretToolVault(fake.command);
    await expect(vault.set("Not A Key", "v")).rejects.toThrow("Invalid vault key format");
    await expect(vault.get("Not A Key")).rejects.toThrow("Invalid vault key format");
    await expect(vault.delete("Not A Key")).rejects.toThrow("Invalid vault key format");
    expect(fake.argvLog()).toEqual([]);
  });
});

describe("resolveSecretToolExecutable", () => {
  test("prefers the PATH hit", () => {
    const probed: string[] = [];
    const got = resolveSecretToolExecutable(
      (bin) => {
        probed.push(bin);
        return "/opt/libsecret/bin/secret-tool";
      },
      () => {
        throw new Error("the fallback path must not be probed when PATH resolves");
      },
    );
    expect(got).toBe("/opt/libsecret/bin/secret-tool");
    expect(probed).toEqual(["secret-tool"]);
  });

  test("falls back to the fixed path when PATH has no hit but the file exists", () => {
    const probedPaths: string[] = [];
    const got = resolveSecretToolExecutable(
      () => null,
      (p) => {
        probedPaths.push(p);
        return true;
      },
    );
    expect(got).toBe(SECRET_TOOL_FALLBACK_PATH);
    expect(probedPaths).toEqual([SECRET_TOOL_FALLBACK_PATH]);
  });

  test("an EMPTY PATH hit counts as no hit; with no fallback file the answer is null", () => {
    expect(
      resolveSecretToolExecutable(
        () => "",
        () => false,
      ),
    ).toBeNull();
  });
});

describe("extractNimbusVaultKeysFromSecretToolSearchOutput (blank keys)", () => {
  test("a label or attribute whose key is only whitespace is skipped, not recorded as ''", () => {
    const out = "label = Nimbus:   \nlabel = Nimbus: real.key\n";
    const err = "attribute.nimbus-key =  \nattribute.nimbus-key = other.key\n";
    expect(extractNimbusVaultKeysFromSecretToolSearchOutput(out, err)).toEqual([
      "other.key",
      "real.key",
    ]);
  });
});
