import { describe, expect, test } from "bun:test";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";

describe("checkLanMethodAllowed", () => {
  test("federation.consentRespond / ask / askExpertise are forbidden over LAN; query+expertise allowed", () => {
    const peer = { peerId: "p", writeAllowed: false };
    expect(() => checkLanMethodAllowed("federation.consentRespond", peer)).toThrow(LanError);
    expect(() => checkLanMethodAllowed("federation.ask", peer)).toThrow(LanError);
    expect(() => checkLanMethodAllowed("federation.askExpertise", peer)).toThrow(LanError);
    expect(() => checkLanMethodAllowed("federation.query", peer)).not.toThrow();
    expect(() => checkLanMethodAllowed("federation.expertise", peer)).not.toThrow();
  });
});
