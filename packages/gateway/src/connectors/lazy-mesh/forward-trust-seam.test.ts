import { describe, expect, test } from "bun:test";
import { parseExtensionManifestJson } from "../../extensions/manifest.ts";
import { planForwardEntries } from "../../platform/sandbox/net-forward-host.ts";
import {
  parseSandboxPolicy,
  policyFromManifest,
  type SandboxPolicy,
} from "../../platform/sandbox/sandbox-policy.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { manifestForFirstParty, manifestWithExtraNetworkHosts } from "./first-party-manifests.ts";
import { userMcpManifestFromRow } from "./user-mcp.ts";

/**
 * The trust a forwarder entry gets is decided across three modules that never meet in one test:
 * a manifest builder sets the labels, `policyFromManifest` carries them, the wrapper serialises the
 * policy and the runner parses it back, and `planForwardEntries` reads them. A label dropped at any
 * hop turns an owner's loopback host into a refusal (or, the other way, a package's into a grant).
 * This runs the whole chain, with the real JSON hop the wrapper makes. Pure, so every OS runs it.
 */
function overTheWire(policy: SandboxPolicy): SandboxPolicy {
  return parseSandboxPolicy(JSON.stringify(policy));
}

function userMcpRow(netHosts: readonly string[]): UserMcpConnectorRow {
  return {
    service_id: "mcp_trust_seam",
    command: "/usr/bin/true",
    args_json: "[]",
    created_at: 0,
    read_paths_json: "[]",
    net_hosts_json: JSON.stringify(netHosts),
    model_access: 0,
  };
}

describe("the trust a forwarder entry gets survives the manifest, the policy and the wire", () => {
  test("an owner-configured extra host on a first-party manifest is trust owner", () => {
    const manifest = manifestWithExtraNetworkHosts("jenkins", ["Jenkins.Corp.:8080"], {
      ownerConfigured: ["Jenkins.Corp.:8080"],
    });
    const entries = planForwardEntries(overTheWire(policyFromManifest(manifest)));
    expect(entries.map((e) => [e.host, e.port, e.trust])).toEqual([
      ["jenkins.corp", 8080, "owner"],
    ]);
  });

  test("a protonmail-shaped call with 127.0.0.1:1143 is trust owner, loopback included", () => {
    const manifest = manifestWithExtraNetworkHosts("protonmail", ["127.0.0.1:1143"], {
      ownerConfigured: ["127.0.0.1:1143"],
    });
    const entries = planForwardEntries(overTheWire(policyFromManifest(manifest)));
    const bridge = entries.find((e) => e.host === "127.0.0.1" && e.port === 1143);
    expect(bridge?.trust).toBe("owner");
  });

  test("a real user MCP row's --net entries are trust owner", () => {
    const built = userMcpManifestFromRow(userMcpRow(["127.0.0.1:1143", "mail.example.com:993"]));
    if (!built.ok) throw new Error(built.reason);
    const entries = planForwardEntries(overTheWire(policyFromManifest(built.manifest)));
    expect(entries.map((e) => [e.host, e.port, e.trust])).toEqual([
      ["127.0.0.1", 1143, "owner"],
      ["mail.example.com", 993, "owner"],
    ]);
  });

  test("a first-party manifest's fixed hosts are trust first-party", () => {
    const entries = planForwardEntries(
      overTheWire(policyFromManifest(manifestForFirstParty("github"))),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.trust === "first-party")).toBe(true);
    expect(entries.map((e) => e.host)).toContain("api.github.com");
  });

  test("a parsed extension manifest's hosts are trust package, whatever the file claims", () => {
    const parsed = parseExtensionManifestJson(
      JSON.stringify({
        id: "ext.trust-seam",
        version: "1.0.0",
        permissions: { network: ["api.example.com:8443"], filesystem: { read: [], write: [] } },
        ownerConfiguredNetwork: ["api.example.com:8443"],
        firstPartyPolicy: true,
      }),
    );
    const entries = planForwardEntries(overTheWire(policyFromManifest(parsed)));
    expect(entries.map((e) => [e.host, e.port, e.trust])).toEqual([
      ["api.example.com", 8443, "package"],
    ]);
  });
});
