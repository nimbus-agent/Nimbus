import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSingleContextKubeconfig,
  inspectKubeconfig,
  KUBECONFIG_REFUSALS,
  type KubeFs,
  kubeconfigMatchesGrant,
  nodeKubeFs,
} from "./kubeconfig-facts.ts";

const CFG = "/home/me/.kube/config";
const CA = Buffer.from("CA-PEM").toString("base64");
const CERT = Buffer.from("CERT-PEM").toString("base64");
const KEY = Buffer.from("KEY-PEM").toString("base64");

interface Entry {
  readonly bytes: Uint8Array;
  readonly link?: boolean;
}

function memFs(files: Record<string, string | Entry>): KubeFs {
  const get = (p: string): Entry | undefined => {
    const v = files[p];
    if (v === undefined) return undefined;
    return typeof v === "string" ? { bytes: new TextEncoder().encode(v) } : v;
  };
  return {
    lstat(p) {
      const e = get(p);
      return e === undefined
        ? undefined
        : { isFile: e.link !== true, isSymbolicLink: e.link === true, size: e.bytes.length };
    },
    readFile(p) {
      const e = get(p);
      if (e === undefined) throw new Error("ENOENT");
      return e.bytes;
    },
  };
}

interface Opts {
  readonly cluster?: string;
  readonly user?: string;
  readonly context?: string;
  readonly extra?: string;
}

/** A multi-cluster kubeconfig: `prod` is the one inspected, `other` carries a credential that must not leak. */
function config(o: Opts = {}): string {
  return [
    "apiVersion: v1",
    "kind: Config",
    "current-context: other",
    "preferences: {}",
    "clusters:",
    "- name: prod-cluster",
    "  cluster:",
    o.cluster ?? `    server: https://prod.example.com:6443\n    certificate-authority-data: ${CA}`,
    "- name: other-cluster",
    "  cluster:",
    "    server: https://other.example.com",
    "    certificate-authority-data: T1RIRVItQ0E=",
    "users:",
    "- name: prod-user",
    "  user:",
    o.user ?? "    token: prod-token-123",
    "- name: other-user",
    "  user:",
    "    token: OTHER-SECRET-TOKEN",
    "contexts:",
    "- name: prod",
    "  context:",
    o.context ?? "    cluster: prod-cluster\n    user: prod-user",
    "- name: other",
    "  context:",
    "    cluster: other-cluster",
    "    user: other-user",
    o.extra ?? "",
    "",
  ].join("\n");
}

const inspect = (text: string, files: Record<string, string | Entry> = {}, ctx = "prod") =>
  inspectKubeconfig(memFs({ [CFG]: text, ...files }), CFG, ctx, ":");
const build = (text: string, files: Record<string, string | Entry> = {}, ctx = "prod") =>
  buildSingleContextKubeconfig(memFs({ [CFG]: text, ...files }), CFG, ctx, ":");

function reason(r: { ok: boolean; reason?: string }): string | undefined {
  return r.ok ? undefined : r.reason;
}

describe("a token context", () => {
  test("inspect gives the host:port and the credential form", () => {
    expect(inspect(config())).toEqual({
      ok: true,
      server: "prod.example.com:6443",
      credentialForm: "token",
    });
  });

  test("the port defaults to 443", () => {
    const r = inspect(
      config({
        cluster: `    server: https://prod.example.com/\n    certificate-authority-data: ${CA}`,
      }),
    );
    expect(r).toMatchObject({ ok: true, server: "prod.example.com:443" });
  });

  test("the copy holds exactly one cluster, one user and one context, and no other credential", () => {
    const r = build(config());
    if (!r.ok) throw new Error(r.reason);
    const parsed = JSON.parse(r.text) as {
      clusters: unknown[];
      users: unknown[];
      contexts: { name: string }[];
      "current-context": string;
    };
    expect(parsed.clusters).toHaveLength(1);
    expect(parsed.users).toHaveLength(1);
    expect(parsed.contexts.map((c) => c.name)).toEqual(["prod"]);
    expect(parsed["current-context"]).toBe("prod");
    expect(r.text).toContain("prod-token-123");
    expect(r.text).not.toContain("OTHER-SECRET-TOKEN");
    expect(r.text).not.toContain("other.example.com");
    expect(r.text).toContain(`"certificate-authority-data": "${CA}"`);
    expect(r.text).toContain('"server": "https://prod.example.com:6443"');
  });

  test("a token file is read and inlined as a token", () => {
    const r = build(config({ user: "    tokenFile: /secrets/tok" }), {
      "/secrets/tok": "file-token\n",
    });
    if (!r.ok) throw new Error(r.reason);
    expect(JSON.parse(r.text).users[0].user).toEqual({ token: "file-token" });
  });
});

describe("a client-certificate context", () => {
  const userData = `    client-certificate-data: ${CERT}\n    client-key-data: ${KEY}`;

  test("embedded data", () => {
    expect(inspect(config({ user: userData }))).toMatchObject({
      ok: true,
      credentialForm: "client-certificate",
    });
    const r = build(config({ user: userData }));
    if (!r.ok) throw new Error(r.reason);
    expect(JSON.parse(r.text).users[0].user).toEqual({
      "client-certificate-data": CERT,
      "client-key-data": KEY,
    });
  });

  test("certificate and key FILES are inlined as data, and a CA file too", () => {
    const files = {
      "/pki/c.crt": "CERT-PEM",
      "/pki/c.key": "KEY-PEM",
      "/pki/ca.crt": "CA-PEM",
    };
    const r = build(
      config({
        cluster: "    server: https://prod.example.com\n    certificate-authority: /pki/ca.crt",
        user: "    client-certificate: /pki/c.crt\n    client-key: /pki/c.key",
      }),
      files,
    );
    if (!r.ok) throw new Error(r.reason);
    const out = JSON.parse(r.text) as {
      users: { user: Record<string, string> }[];
      clusters: { cluster: Record<string, string> }[];
    };
    expect(out.users[0]?.user).toEqual({ "client-certificate-data": CERT, "client-key-data": KEY });
    expect(out.clusters[0]?.cluster["certificate-authority-data"]).toBe(CA);
    expect(r.text).not.toContain("/pki/");
  });
});

describe("refused forms (fixed texts, nothing echoed)", () => {
  const R = KUBECONFIG_REFUSALS;
  const cases: readonly [string, Opts, string][] = [
    [
      "an exec plugin",
      { user: "    exec:\n      command: aws\n      apiVersion: client.authentication.k8s.io/v1" },
      R.userKey,
    ],
    ["an auth provider", { user: "    auth-provider:\n      name: gcp" }, R.userKey],
    ["basic auth", { user: "    username: me\n    password: hunter2" }, R.userKey],
    ["impersonation", { user: "    token: t\n    as: admin" }, R.userKey],
    [
      "impersonated groups",
      { user: "    token: t\n    as-groups:\n    - system:masters" },
      R.userKey,
    ],
    [
      "a user extension",
      { user: "    token: t\n    extensions:\n    - name: x\n      extension: {}" },
      R.userKey,
    ],
    [
      "insecure TLS",
      { cluster: `    server: https://prod.example.com\n    insecure-skip-tls-verify: true` },
      R.clusterKey,
    ],
    [
      "a proxy url",
      { cluster: `    server: https://prod.example.com\n    proxy-url: http://evil:3128` },
      R.clusterKey,
    ],
    [
      "tls-server-name",
      { cluster: `    server: https://prod.example.com\n    tls-server-name: evil` },
      R.clusterKey,
    ],
    [
      "a cluster extension",
      {
        cluster: `    server: https://prod.example.com\n    extensions:\n    - name: x\n      extension: {}`,
      },
      R.clusterKey,
    ],
    [
      "a context extension",
      {
        context:
          "    cluster: prod-cluster\n    user: prod-user\n    extensions:\n    - name: x\n      extension: {}",
      },
      R.contextKey,
    ],
    ["an http server", { cluster: "    server: http://prod.example.com" }, R.badServer],
    ["an IPv6 server", { cluster: "    server: https://[::1]:6443" }, R.badServer],
    [
      "a server with a path",
      { cluster: "    server: https://prod.example.com/proxy/x" },
      R.badServer,
    ],
    [
      "a server with a login",
      { cluster: "    server: https://me:pw@prod.example.com" },
      R.badServer,
    ],
    [
      "a server with a query",
      { cluster: "    server: https://prod.example.com/?a=b" },
      R.badServer,
    ],
    ["no server", { cluster: `    certificate-authority-data: ${CA}` }, R.badServer],
    [
      "a CA given twice",
      {
        cluster: `    server: https://prod.example.com\n    certificate-authority-data: ${CA}\n    certificate-authority: /pki/ca.crt`,
      },
      R.badCa,
    ],
    [
      "a CA that is not base64",
      { cluster: "    server: https://prod.example.com\n    certificate-authority-data: '!!!'" },
      R.badCa,
    ],
    [
      "a relative CA file",
      { cluster: "    server: https://prod.example.com\n    certificate-authority: ca.crt" },
      R.fileRef,
    ],
    [
      "a certificate without a key",
      { user: `    client-certificate-data: ${CERT}` },
      R.badCredential,
    ],
    ["a key without a certificate", { user: `    client-key-data: ${KEY}` }, R.badCredential],
    [
      "a token and a certificate",
      { user: `    token: t\n    client-certificate-data: ${CERT}\n    client-key-data: ${KEY}` },
      R.mixedCredential,
    ],
    ["no credential at all", { user: "    {}" }, R.noCredential],
    ["a token with a space", { user: "    token: 'a b'" }, R.badCredential],
    ["a token and a token file", { user: "    token: t\n    tokenFile: /t" }, R.badCredential],
    [
      "a relative cert file",
      { user: "    client-certificate: c.crt\n    client-key: c.key" },
      R.fileRef,
    ],
  ];
  for (const [label, opts, expected] of cases) {
    test(label, () => {
      expect(reason(inspect(config(opts)))).toBe(expected);
      expect(reason(build(config(opts)))).toBe(expected);
    });
  }

  test("a referenced file that is missing, a link, or over 64 KiB", () => {
    const user = "    client-certificate: /pki/c.crt\n    client-key: /pki/c.key";
    expect(reason(inspect(config({ user })))).toBe(R.fileRef);
    const linked = { "/pki/c.crt": { bytes: new Uint8Array(3), link: true }, "/pki/c.key": "K" };
    expect(reason(inspect(config({ user }), linked))).toBe(R.fileRef);
    const big = { "/pki/c.crt": "x".repeat(64 * 1024 + 1), "/pki/c.key": "K" };
    expect(reason(inspect(config({ user }), big))).toBe(R.fileRef);
  });

  test("a missing context, a duplicated context, an unknown cluster or user", () => {
    expect(reason(inspect(config(), {}, "nope"))).toBe(R.noContext);
    const dup = `${config()}- name: prod\n  context:\n    cluster: other-cluster\n    user: other-user\n`;
    expect(reason(inspect(dup))).toBe(R.noContext);
    expect(reason(inspect(config({ context: "    cluster: ghost\n    user: prod-user" })))).toBe(
      R.badEntry,
    );
    expect(reason(inspect(config({ context: "    cluster: prod-cluster\n    user: ghost" })))).toBe(
      R.badEntry,
    );
    expect(reason(inspect(config({ context: "    user: prod-user" })))).toBe(R.badEntry);
  });

  test("a context name that cannot be typed is not found", () => {
    expect(reason(inspect(config(), {}, "has space"))).toBe(R.noContext);
  });

  test("a duplicate key, an alias, bad YAML and non-UTF-8 are unreadable", () => {
    expect(reason(inspect(`${config()}kind: Config\n`))).toBe(R.unreadable);
    expect(reason(inspect(config({ user: "    token: &a t\n    tokenFile: *a" })))).toBe(
      R.unreadable,
    );
    expect(reason(inspect("a: [\n"))).toBe(R.unreadable);
    expect(reason(inspect("- a\n- b\n"))).toBe(R.unreadable);
    const fs = memFs({ [CFG]: { bytes: new Uint8Array([0xff, 0xfe, 0xfd]) } });
    expect(reason(inspectKubeconfig(fs, CFG, "prod", ":"))).toBe(R.unreadable);
  });

  test("CRLF line endings read the same", () => {
    expect(inspect(config().replaceAll("\n", "\r\n"))).toMatchObject({
      ok: true,
      credentialForm: "token",
    });
  });

  test("the file: missing, a link, over 1 MiB, a path list, relative, absent", () => {
    const fs = (files: Record<string, string | Entry>) => memFs(files);
    expect(reason(inspectKubeconfig(fs({}), CFG, "prod", ":"))).toBe(R.notRegular);
    expect(
      reason(
        inspectKubeconfig(
          fs({ [CFG]: { bytes: new Uint8Array(3), link: true } }),
          CFG,
          "prod",
          ":",
        ),
      ),
    ).toBe(R.notRegular);
    expect(
      reason(inspectKubeconfig(fs({ [CFG]: "x".repeat(1024 * 1024 + 1) }), CFG, "prod", ":")),
    ).toBe(R.tooLarge);
    expect(reason(inspectKubeconfig(fs({}), `${CFG}:/other`, "prod", ":"))).toBe(R.pathList);
    expect(reason(inspectKubeconfig(fs({}), "kube/config", "prod", ":"))).toBe(R.notAbsolute);
    expect(reason(inspectKubeconfig(fs({}), undefined, "prod", ":"))).toBe(R.noPath);
    expect(reason(inspectKubeconfig(fs({}), "  ", "prod", ":"))).toBe(R.noPath);
  });

  test("a trailing separator still names one file", () => {
    expect(inspectKubeconfig(memFs({ [CFG]: config() }), `${CFG}:`, "prod", ":").ok).toBe(true);
  });

  test("no refusal text echoes a path, a name or a value", () => {
    for (const text of Object.values(R)) {
      expect(text).not.toMatch(/prod|hunter2|\/home|\/pki/);
    }
  });
});

describe("drift against the approved facts", () => {
  const facts = { server: "prod.example.com:6443", credentialForm: "token" } as const;
  test("equal facts match; a moved server or a changed form does not", () => {
    expect(
      kubeconfigMatchesGrant(facts, { server: "prod.example.com:6443", credentialForm: "token" }),
    ).toBe(true);
    expect(
      kubeconfigMatchesGrant(facts, { server: "evil.example.com:6443", credentialForm: "token" }),
    ).toBe(false);
    expect(
      kubeconfigMatchesGrant(facts, { server: "prod.example.com:443", credentialForm: "token" }),
    ).toBe(false);
    expect(
      kubeconfigMatchesGrant(facts, {
        server: "prod.example.com:6443",
        credentialForm: "client-certificate",
      }),
    ).toBe(false);
  });
});

describe("nodeKubeFs (the real filesystem)", () => {
  test("lstat reports a regular file and its size, a missing path as undefined, and reads bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-kubefs-"));
    try {
      const file = join(dir, "config");
      writeFileSync(file, "abc");
      expect(nodeKubeFs.lstat(file)).toEqual({ isFile: true, isSymbolicLink: false, size: 3 });
      expect(nodeKubeFs.lstat(join(dir, "missing"))).toBeUndefined();
      expect(nodeKubeFs.lstat(dir)?.isFile).toBe(false);
      expect(new TextDecoder().decode(nodeKubeFs.readFile(file))).toBe("abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
