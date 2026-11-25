import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_LAN_TOML, parseNimbusLanToml } from "./nimbus-toml.ts";

describe("parseNimbusLanToml", () => {
  test("returns defaults when [lan] absent", () => {
    expect(parseNimbusLanToml("")).toEqual(DEFAULT_NIMBUS_LAN_TOML);
  });

  test("parses overrides", () => {
    const toml = `
[lan]
enabled = true
port = 9999
bind = "127.0.0.1"
pairing_window_seconds = 10
max_failed_attempts = 2
lockout_seconds = 5
`;
    const out = parseNimbusLanToml(toml);
    expect(out.enabled).toBe(true);
    expect(out.port).toBe(9999);
    expect(out.bind).toBe("127.0.0.1");
    expect(out.pairingWindowSeconds).toBe(10);
  });

  test("NIMBUS_LAN_PORT env overrides port", () => {
    const prev = process.env["NIMBUS_LAN_PORT"];
    process.env["NIMBUS_LAN_PORT"] = "12345";
    try {
      const out = parseNimbusLanToml("[lan]\nport = 7475\n");
      expect(out.port).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_LAN_PORT"];
      else process.env["NIMBUS_LAN_PORT"] = prev;
    }
  });

  test("DEFAULT_NIMBUS_LAN_TOML bind is loopback, not all-interfaces", () => {
    expect(DEFAULT_NIMBUS_LAN_TOML.bind).toBe("127.0.0.1");
  });

  // FS3: the v1 wire is gone and so is the key. A config that still sets it must neither fail nor
  // change behaviour (a gateway that refuses to boot over it would take every v2 peer down too);
  // only `= 1`, which asked for the removed wire, is named at boot.
  describe("[lan] min_protocol (removed in FS3)", () => {
    test("is not part of the parsed config and the default says nothing was ignored", () => {
      expect("minProtocol" in DEFAULT_NIMBUS_LAN_TOML).toBe(false);
      expect(DEFAULT_NIMBUS_LAN_TOML.minProtocolIgnored).toBe(false);
      expect(parseNimbusLanToml("[lan]\nenabled = true\n").minProtocolIgnored).toBe(false);
    });

    test("= 1 is ignored and flagged so the boot can say so", () => {
      const out = parseNimbusLanToml("[lan]\nenabled = true\nmin_protocol = 1\n");
      expect(out.minProtocolIgnored).toBe(true);
      expect(out.enabled).toBe(true);
    });

    test("= 2 (the only wire left) and any other value are silent no-ops", () => {
      for (const v of ["2", "3", "0", "-1", '"two"', "1.5", "", "true"]) {
        const out = parseNimbusLanToml(`[lan]\nmin_protocol = ${v}\n`);
        expect(out).toEqual(DEFAULT_NIMBUS_LAN_TOML);
      }
    });
  });
});
