import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";
import type { SandboxPolicy } from "../../../src/platform/sandbox/sandbox-policy.ts";
import {
  createSandboxRunner,
  type SandboxRunner,
} from "../../../src/platform/sandbox/sandbox-runner.ts";

/**
 * D3a Task A0: does a REAL `kubectl` run inside the gateway's sandbox with the grants the `kube`
 * profile would hand it, against a throwaway TLS stub API server on 127.0.0.1?
 *
 * Probe items, through the gateway's real sandbox runner (the one `wrapServerSpec` uses):
 *   1. `kubectl version --client` starts. On Linux it starts WITHOUT the iac flag too: Go probes
 *      `pidfd_send_signal` only when it starts a child, and kubectl starts none (an exec credential
 *      plugin would, and the gateway's kubeconfig refuses one). The kube profile keeps the flag
 *      anyway (OR-D2-5 extended), so a future kubectl that does start a child is not killed.
 *   2. `kubectl get --raw /version` reaches the owner-configured loopback `host:port` (Linux through
 *      the forwarder, macOS by port, Windows all-or-nothing).
 *   3. A host NOT in the policy is refused (asserted on Linux, where the forwarder enforces it;
 *      recorded as an observation elsewhere: macOS is ports-only and Windows is all-or-nothing).
 *      On a Linux box with no sandbox helper the runner's `canConfine` refuses every policy that
 *      declares a network, so the production child never starts; that refusal is what is asserted
 *      there (this file's direct `spawn` would take the degraded fallback production never reaches).
 *   4. `kubectl apply --server-side --dry-run=server -o json` and `kubectl get ... -o json
 *      --ignore-not-found` return parseable JSON (the connector's built-in diff reads both). The
 *      stub serves no OpenAPI document, so the apply passes `--validate=false`: the stub cannot
 *      exercise client-side schema validation, which is a stub limit and not a sandbox one.
 *   5. kubectl's cache lands in the write-granted scratch directory (`KUBECACHEDIR`).
 *   6. A kubeconfig outside the granted directories is NOT readable.
 *   7. Windows: no AppContainer ACE is left on the grants after the child exits.
 *   8. Timing of a no-op round trip is printed for the budgets.
 *
 * Skipped, with the reason in the test name, when `kubectl` or `openssl` is not on PATH or this OS
 * cannot confine. No real cluster is involved: an apply against a real cluster is NOT probed.
 */

const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
if (IS_WIN && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined && existsSync(WIN_HELPER)) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_HELPER;
}

const KUBECTL = Bun.which("kubectl");

/**
 * The real kubectl behind a Chocolatey shim (`<choco>\\bin\\kubectl.exe`, a launcher that starts
 * the real exe from `<choco>\\lib\\kubernetes-cli\\tools\\...` and waits for it), else `null`.
 * The windows-2025 runner installs kubectl through Chocolatey, and a shim spawned inside the
 * AppContainer never returned there (every run hit the time limit), so the probe runs the real exe.
 */
function realBehindChocolateyShim(path: string): string | null {
  const bin = dirname(path);
  if (!IS_WIN || !/[\\/]chocolatey[\\/]bin$/i.test(bin)) return null;
  const tools = join(dirname(bin), "lib", "kubernetes-cli", "tools");
  const stack = [tools];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      if (e.toLowerCase() === "kubectl.exe") return realpathSync(full);
      if (!e.includes(".")) stack.push(full);
    }
  }
  return null;
}

const KUBECTL_REAL =
  KUBECTL === null ? null : (realBehindChocolateyShim(KUBECTL) ?? realpathSync(KUBECTL));
console.log(`[probe] kubectl: ${String(KUBECTL)} -> ${String(KUBECTL_REAL)}`);
const OPENSSL = Bun.which("openssl");
/** The address the stub listens on and the kubeconfig names; set NIMBUS_KUBE_PROBE_HOST to a LAN address to compare with loopback. */
const PROBE_HOST = process.env["NIMBUS_KUBE_PROBE_HOST"] ?? "127.0.0.1";

const PROBE_POLICY: SandboxPolicy = {
  id: "kube-probe-capability",
  permissions: { network: [], filesystem: { read: [], write: [] } },
};

async function skipReason(): Promise<{ reason: string | null; runner: SandboxRunner | null }> {
  if (KUBECTL_REAL === null) return { reason: "kubectl is not on PATH", runner: null };
  if (OPENSSL === null) {
    return { reason: "openssl is not on PATH (needed for the stub certificate)", runner: null };
  }
  if (IS_WIN && !existsSync(WIN_HELPER)) {
    return { reason: `Windows sandbox helper not found at ${WIN_HELPER}`, runner: null };
  }
  try {
    const runner = await createSandboxRunner();
    const why = runner.canConfine(PROBE_POLICY);
    return why === null ? { reason: null, runner } : { reason: `cannot confine: ${why}`, runner };
  } catch (e) {
    return { reason: `no sandbox runner: ${String(e)}`, runner: null };
  }
}

const { reason: SKIP, runner: RUNNER } = await skipReason();
const READY = SKIP === null && RUNNER !== null && KUBECTL_REAL !== null && OPENSSL !== null;
const SKIP_NOTE = SKIP === null ? "" : ` [skipped: ${SKIP}]`;

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-kube-probe-")));
const kubeDir = join(root, "kube");
const scratch = join(root, "scratch");
const sbcwd = join(root, "sbcwd");
const outside = join(root, "outside");

interface Run {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

// A sandboxed kubectl answers a no-op in well under a second (probe 8); a hang is a finding, and
// at 90 s each the Windows leg would spend six minutes per attempt on it.
const RUN_TIMEOUT_MS = 30_000;

function configBody(server: string, caB64: string): string {
  return [
    "apiVersion: v1",
    "kind: Config",
    "current-context: probe",
    "clusters:",
    "- name: probe",
    "  cluster:",
    `    server: ${server}`,
    `    certificate-authority-data: ${caB64}`,
    "users:",
    "- name: probe",
    "  user:",
    "    token: probe-token",
    "contexts:",
    "- name: probe",
    "  context:",
    "    cluster: probe",
    "    user: probe",
    "",
  ].join("\n");
}

let port = 0;
let otherPort = 0;
let stop: (() => void) | undefined;
let stubHits: string[] = [];
let configPath = "";
let outsideConfig = "";

function stubHandler(req: Request): Response {
  const u = new URL(req.url);
  stubHits.push(`${req.method} ${u.pathname}`);
  const j = (o: unknown, status = 200): Response =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (u.pathname === "/version") return j({ major: "1", minor: "30", gitVersion: "v1.30.0" });
  if (u.pathname === "/api") return j({ kind: "APIVersions", versions: ["v1"] });
  if (u.pathname === "/apis") return j({ kind: "APIGroupList", apiVersion: "v1", groups: [] });
  if (u.pathname === "/api/v1") {
    return j({
      kind: "APIResourceList",
      groupVersion: "v1",
      resources: [
        {
          name: "configmaps",
          singularName: "configmap",
          namespaced: true,
          kind: "ConfigMap",
          verbs: ["get", "patch", "list"],
        },
      ],
    });
  }
  const m = /^\/api\/v1\/namespaces\/([^/]+)\/configmaps\/([^/]+)$/.exec(u.pathname);
  if (m !== null && req.method === "PATCH") {
    return j({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: m[2], namespace: m[1], uid: "u1", resourceVersion: "1" },
      data: { k: "v" },
    });
  }
  return j(
    { kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404 },
    404,
  );
}

beforeAll(() => {
  if (!READY) return;
  for (const d of [kubeDir, scratch, sbcwd, outside]) mkdirSync(d, { recursive: true });
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  const gen = spawnSync(
    OPENSSL as string,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      `subjectAltName=IP:127.0.0.1${PROBE_HOST === "127.0.0.1" ? "" : `,IP:${PROBE_HOST}`}`,
    ],
    { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  if (gen.status !== 0) throw new Error("openssl could not make the stub certificate");
  const tls = { cert: Bun.file(cert), key: Bun.file(key) };
  const a = Bun.serve({
    port: 0,
    hostname: PROBE_HOST === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
    tls,
    fetch: stubHandler,
  });
  const b = Bun.serve({
    port: 0,
    hostname: PROBE_HOST === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
    tls,
    fetch: stubHandler,
  });
  port = a.port ?? 0;
  otherPort = b.port ?? 0;
  stop = () => {
    void a.stop(true);
    void b.stop(true);
  };
  const caB64 = readFileSync(cert).toString("base64");
  const body = configBody(`https://${PROBE_HOST}:${String(port)}`, caB64);
  configPath = join(kubeDir, "config");
  writeFileSync(configPath, body, { mode: 0o600 });
  outsideConfig = join(outside, "config");
  writeFileSync(outsideConfig, body, { mode: 0o600 });
});

afterAll(() => {
  stop?.();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows handle race; harmless */
  }
});

/** kubectl's install tree is granted read on POSIX only (a tree under C:\Program Files cannot be granted on Windows). */
function treeGrants(): string[] {
  return IS_WIN || KUBECTL_REAL === null ? [] : [dirname(KUBECTL_REAL)];
}

function runConfined(
  profile: string,
  args: string[],
  opts: {
    read: string[];
    write: string[];
    network: string[];
    iacFlag?: boolean;
    env?: Record<string, string>;
  },
): Promise<Run> {
  const read = [...new Set([...opts.read, ...opts.write])];
  const policy: SandboxPolicy = {
    id: `kube-probe-${profile}-${Math.random().toString(36).slice(2, 10)}`,
    ...(opts.iacFlag === false ? {} : { iacProfile: true }),
    ownerConfiguredNetwork: opts.network,
    permissions: { network: opts.network, filesystem: { read, write: opts.write } },
  };
  const env = extensionProcessEnv({
    KUBECONFIG: configPath,
    KUBECACHEDIR: join(scratch, "cache"),
    NIMBUS_CONNECTOR_SCRATCH_DIR: scratch,
    ...opts.env,
  });
  const t0 = Date.now();
  return new Promise((resolveRun) => {
    const child = (RUNNER as SandboxRunner).spawn(KUBECTL_REAL as string, args, {
      policy,
      env,
      cwd: sbcwd,
      stdio: ["ignore", "pipe", "pipe"],
      releaseGrantsOnExit: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: unknown) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d: unknown) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolveRun({ exit: code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

const server = (): string => `${PROBE_HOST}:${String(port)}`;
const kubeRead = (): string[] => [kubeDir, ...treeGrants()];

describe.skipIf(!READY)(
  `kubectl in the gateway sandbox, against a stub API server${SKIP_NOTE}`,
  () => {
    it("1. kubectl version --client starts", async () => {
      const r = await runConfined("version", ["version", "--client"], {
        read: kubeRead(),
        write: [scratch],
        network: [],
      });
      expect({ exit: r.exit, stderr: r.stderr.slice(0, 300) }).toEqual({ exit: 0, stderr: "" });
      expect(r.stdout).toContain("Client Version");
    }, 120_000);

    it.skipIf(!IS_LINUX)(
      "1b. Linux: kubectl starts no child, so it also runs without the iac flag",
      async () => {
        const r = await runConfined("noflag", ["version", "--client"], {
          read: kubeRead(),
          write: [scratch],
          network: [],
          iacFlag: false,
        });
        // Exit 159 (SIGSYS) here would mean kubectl now starts a child and NEEDS the kube profile's
        // iac flag, which it has; the file comment then needs revising.
        expect({ exit: r.exit, stderr: r.stderr.slice(0, 300) }).toEqual({ exit: 0, stderr: "" });
      },
      120_000,
    );

    it.skipIf(IS_WIN)(
      "2. get --raw /version reaches the owner-configured loopback host:port",
      async () => {
        stubHits = [];
        const r = await runConfined("raw", ["--context", "probe", "get", "--raw", "/version"], {
          read: kubeRead(),
          write: [scratch],
          network: [server()],
        });
        expect({ exit: r.exit, stderr: r.stderr.slice(0, 300) }).toEqual({ exit: 0, stderr: "" });
        expect(JSON.parse(r.stdout)).toMatchObject({ gitVersion: "v1.30.0" });
        expect(stubHits).toContain("GET /version");
      },
      120_000,
    );

    it.skipIf(IS_WIN)(
      "3. a host and port NOT in the policy is refused (asserted on Linux; observed elsewhere)",
      async () => {
        stubHits = [];
        // The config names `port`; the policy allows only `otherPort`.
        const network = [`${PROBE_HOST}:${String(otherPort)}`];
        if (IS_LINUX) {
          const why = (RUNNER as SandboxRunner).canConfine({
            id: "kube-probe-confine",
            iacProfile: true,
            ownerConfiguredNetwork: network,
            permissions: { network, filesystem: { read: kubeRead(), write: [scratch] } },
          });
          if (why !== null) {
            // No helper: production refuses to start any network-bearing child at all.
            console.log(`[probe 3] linux: canConfine refuses (${why})`);
            expect(why).toContain("helper");
            return;
          }
        }
        const r = await runConfined(
          "unlisted",
          ["--context", "probe", "get", "--raw", "/version"],
          {
            read: kubeRead(),
            write: [scratch],
            network,
          },
        );
        console.log(
          `[probe 3] ${process.platform}: exit=${String(r.exit)} reachedStub=${String(stubHits.includes("GET /version"))}`,
        );
        if (IS_LINUX) {
          expect(r.exit).not.toBe(0);
          expect(stubHits).not.toContain("GET /version");
        }
      },
      120_000,
    );

    it.skipIf(IS_WIN)(
      "4. apply --dry-run=server -o json and get -o json --ignore-not-found return parseable JSON",
      async () => {
        const manifest = join(scratch, "m.yaml");
        writeFileSync(
          manifest,
          "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  k: v\n",
        );
        const apply = await runConfined(
          "dry",
          [
            "--context",
            "probe",
            "apply",
            "--server-side",
            "--dry-run=server",
            "--validate=false",
            "--field-manager=nimbus",
            "-n",
            "shop",
            "-f",
            manifest,
            "-o",
            "json",
          ],
          { read: kubeRead(), write: [scratch], network: [server()] },
        );
        expect({ exit: apply.exit, stderr: apply.stderr.slice(0, 300) }).toEqual({
          exit: 0,
          stderr: "",
        });
        expect(JSON.parse(apply.stdout)).toMatchObject({
          kind: "ConfigMap",
          metadata: { name: "x" },
        });

        const get = await runConfined(
          "get",
          [
            "--context",
            "probe",
            "get",
            "configmap/x",
            "-n",
            "shop",
            "-o",
            "json",
            "--ignore-not-found",
          ],
          { read: kubeRead(), write: [scratch], network: [server()] },
        );
        expect({ exit: get.exit, stderr: get.stderr.slice(0, 300) }).toEqual({
          exit: 0,
          stderr: "",
        });
        expect(get.stdout.trim()).toBe("");
      },
      120_000,
    );

    it.skipIf(IS_WIN)(
      "5. the cache lands in the write-granted scratch directory",
      async () => {
        const r = await runConfined("cache", ["--context", "probe", "get", "--raw", "/version"], {
          read: kubeRead(),
          write: [scratch],
          network: [server()],
        });
        expect(r.exit).toBe(0);
        expect(existsSync(join(scratch, "cache"))).toBe(true);
        console.log(`[probe 5] scratch now holds: ${readdirSync(scratch).join(", ")}`);
      },
      120_000,
    );

    it("6. a kubeconfig outside the granted directories is NOT readable", async () => {
      const r = await runConfined("outside", ["--context", "probe", "get", "--raw", "/version"], {
        read: kubeRead(),
        write: [scratch],
        network: [server()],
        env: { KUBECONFIG: outsideConfig },
      });
      expect(r.exit).not.toBe(0);
    }, 120_000);

    // FINDING (probed 2026-11-10, Windows 11): the AppContainer's `internetClient` capability reaches
    // a REMOTE host (a kubeconfig naming https://example.com:443 answered in ~0.3 s) but never an
    // address of this machine: a loopback or local-NIC API server (docker-desktop, kind, minikube)
    // times out. Windows loopback isolation applies to every AppContainer; a loopback exemption is
    // an owner-level machine change this runner does not make. The test pins the finding.
    it.skipIf(!IS_WIN)(
      "2w. Windows: an API server on this machine is NOT reachable from the sandbox",
      async () => {
        stubHits = [];
        const r = await runConfined(
          "rawwin",
          ["--context", "probe", "--request-timeout=4s", "get", "--raw", "/version"],
          { read: kubeRead(), write: [scratch], network: [server()] },
        );
        expect(r.exit).not.toBe(0);
        expect(stubHits).not.toContain("GET /version");
      },
      120_000,
    );

    it.skipIf(!IS_WIN)(
      "7. Windows: no AppContainer ACE is left on the grants after exit",
      async () => {
        await runConfined("ace", ["--context", "probe", "get", "--raw", "/version"], {
          read: kubeRead(),
          write: [scratch],
          network: [server()],
        });
        // The release runs from the child's `exit` event through the helper, so it lands a moment
        // after the spawn settles: poll rather than read once.
        const left = (): string[] =>
          [kubeDir, scratch].filter((dir) =>
            (spawnSync("icacls", [dir], { encoding: "utf8" }).stdout ?? "").includes("S-1-15-2-"),
          );
        const deadline = Date.now() + 15_000;
        while (left().length > 0 && Date.now() < deadline) await Bun.sleep(250);
        expect(left()).toEqual([]);
      },
      120_000,
    );

    it.skipIf(IS_WIN)(
      "8. timing of a no-op round trip",
      async () => {
        const r = await runConfined("time", ["--context", "probe", "get", "--raw", "/version"], {
          read: kubeRead(),
          write: [scratch],
          network: [server()],
        });
        console.log(
          `[probe 8] ${process.platform}: get --raw took ${String(r.ms)} ms (exit ${String(r.exit)})`,
        );
        expect(r.exit).toBe(0);
      },
      120_000,
    );
  },
);
