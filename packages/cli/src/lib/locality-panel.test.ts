import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES, type CommandName } from "../commands/registry.ts";
import {
  type ListenerReport,
  type LocalityReport,
  PANEL_COMMANDS,
  renderLocalityPanel,
} from "./locality-panel.ts";

function locWith(overrides: Partial<LocalityReport> = {}): LocalityReport {
  return {
    listeners: [{ name: "ipc", address: "npipe:\\\\.\\pipe\\nimbus-gw", loopback: true }],
    inventory: [{ service: "github", items: 10 }],
    db: { path: "/tmp/nimbus/nimbus.db", bytes: 1024 },
    t1: 0,
    ...overrides,
  };
}

describe("renderLocalityPanel — listeners", () => {
  test("ipc has no loopback suffix even though it is always loopback", () => {
    const text = renderLocalityPanel(
      locWith({ listeners: [{ name: "ipc", address: "npipe:...", loopback: true }] }),
      "P",
    );
    expect(text).toContain("local socket");
    expect(text).not.toContain("loopback");
  });

  test("http shows loopback when true", () => {
    const text = renderLocalityPanel(
      locWith({ listeners: [{ name: "http", address: "127.0.0.1:8787", loopback: true }] }),
      "P",
    );
    expect(text).toContain("HTTP API");
    expect(text).toContain("loopback");
    expect(text).not.toContain("NOT loopback");
  });

  // Brief-mandated test, verbatim.
  test("a non-loopback listener is rendered with NOT loopback", () => {
    expect(
      renderLocalityPanel(
        locWith({
          listeners: [{ name: "lan", address: "192.168.1.20:7443", loopback: false }],
        }),
        "P",
      ),
    ).toContain("NOT loopback");
  });

  test("metrics and oauth_callback render their own labels", () => {
    const text = renderLocalityPanel(
      locWith({
        listeners: [
          { name: "metrics", address: "127.0.0.1:9090", loopback: true },
          { name: "oauth_callback", address: "127.0.0.1:53123", loopback: true },
        ],
      }),
      "P",
    );
    expect(text).toContain("metrics");
    expect(text).toContain("OAuth callback");
  });

  // Context ruling: a sixth listener, mdns, is a real production case (federation mDNS
  // discovery) — not a hypothetical version-skew case like the "quic" test below.
  test("mdns renders its label and NOT loopback (multicast is never loopback)", () => {
    const text = renderLocalityPanel(
      locWith({
        listeners: [{ name: "mdns", address: "udp *:5353 (mDNS multicast)", loopback: false }],
      }),
      "P",
    );
    expect(text).toContain("mDNS discovery");
    expect(text).toContain("NOT loopback");
  });

  // `ListenerName` crosses IPC and is a compile-time claim only — a version-skewed gateway can
  // report a name this union does not know about. The panel must still render it (raw name as
  // label) rather than silently dropping an open listener, the one failure it cannot have.
  test("a listener name outside the known map still renders, using its raw name as the label", () => {
    const oddListener = {
      name: "quic",
      address: "udp 1.2.3.4:443",
      loopback: false,
    } as unknown as ListenerReport;
    const text = renderLocalityPanel(locWith({ listeners: [oddListener] }), "P");
    expect(text).toContain("quic");
    expect(text).toContain("NOT loopback");
  });

  test("every listener the gateway reports gets a row — none are silently dropped", () => {
    const text = renderLocalityPanel(
      locWith({
        listeners: [
          { name: "ipc", address: "npipe:...", loopback: true },
          { name: "http", address: "127.0.0.1:8787", loopback: true },
          { name: "lan", address: "0.0.0.0:7474", loopback: false },
        ],
      }),
      "P",
    );
    expect(text).toContain("local socket");
    expect(text).toContain("HTTP API");
    expect(text).toContain("LAN");
  });
});

describe("renderLocalityPanel — local index inventory", () => {
  test("zero services prints the header with no trailing colon or list", () => {
    const text = renderLocalityPanel(locWith({ inventory: [] }), "P");
    expect(text).toContain("0 items across 0 services");
    expect(text).not.toContain("services:");
  });

  test("item and service counts are grouped with locale-independent commas", () => {
    const text = renderLocalityPanel(
      locWith({ inventory: [{ service: "github", items: 2150 }] }),
      "P",
    );
    expect(text).toContain("github 2,150");
  });

  test("more than six services caps the printed list at the top six, then '+N more'", () => {
    const inventory = Array.from({ length: 8 }, (_, i) => ({
      service: `svc${String(i)}`,
      items: 8 - i,
    }));
    const text = renderLocalityPanel(locWith({ inventory }), "P");
    for (let i = 0; i < 6; i++) expect(text).toContain(`svc${String(i)}`);
    expect(text).not.toContain("svc6");
    expect(text).not.toContain("svc7");
    expect(text).toContain("· +2 more");
  });

  test("six or fewer services never print a '+N more' tail", () => {
    const inventory = Array.from({ length: 6 }, (_, i) => ({
      service: `svc${String(i)}`,
      items: 1,
    }));
    const text = renderLocalityPanel(locWith({ inventory }), "P");
    expect(text).not.toContain("more");
  });
});

describe("renderLocalityPanel — db, proof and next sections", () => {
  test("renders the db path and a human-readable size", () => {
    const text = renderLocalityPanel(
      locWith({ db: { path: "/tmp/x/nimbus.db", bytes: 3_900_000_000 } }),
      "P",
    );
    expect(text).toContain("/tmp/x/nimbus.db");
    expect(text).toContain("3.9 GB");
  });

  test("embeds proofText verbatim under the outbound-activity heading", () => {
    const text = renderLocalityPanel(locWith({}), "PROOFTEXT_MARKER_XYZ");
    expect(text).toContain(
      "Outbound activity during this tour (gateway-wide):\nPROOFTEXT_MARKER_XYZ",
    );
  });

  test("the Next section names all three panel commands with their descriptions", () => {
    const text = renderLocalityPanel(locWith({}), "P");
    for (const c of PANEL_COMMANDS) expect(text).toContain(c);
    expect(text).toContain("a signed receipt for any window");
    expect(text).toContain("the full ledger");
    expect(text).toContain("check the chain");
  });
});

// Brief-mandated test, verbatim (adapted to use COMMAND_NAMES rather than the brief's stand-in
// REGISTERED_COMMANDS name — COMMAND_NAMES is the real export from commands/registry.ts).
describe("PANEL_COMMANDS", () => {
  test("every command the panel names is a registered CLI command", () => {
    for (const c of PANEL_COMMANDS) {
      expect(COMMAND_NAMES).toContain(c.split(" ")[1] as CommandName); // NOSONAR S4325: raw string from a split; toContain expects CommandName
    }
  });
});
