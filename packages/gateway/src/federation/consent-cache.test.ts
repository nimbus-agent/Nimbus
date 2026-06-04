import { expect, test } from "bun:test";
import { SessionConsentCache } from "./consent-cache.ts";

test("remembers an approval for the (peer, namespace) pair", () => {
  const c = new SessionConsentCache();
  expect(c.get("peerA", "ns1")).toBeUndefined();
  c.set("peerA", "ns1", true);
  expect(c.get("peerA", "ns1")).toBe(true);
  c.set("peerA", "ns2", false);
  expect(c.get("peerA", "ns2")).toBe(false);
});

test("invalidate clears a single (peer, namespace) decision", () => {
  const c = new SessionConsentCache();
  c.set("peerA", "ns1", true);
  c.invalidate("peerA", "ns1");
  expect(c.get("peerA", "ns1")).toBeUndefined();
});

test("invalidateNamespace clears every peer's decision for a namespace", () => {
  const c = new SessionConsentCache();
  c.set("peerA", "ns1", true);
  c.set("peerB", "ns1", true);
  c.set("peerA", "ns2", true);
  c.invalidateNamespace("ns1");
  expect(c.get("peerA", "ns1")).toBeUndefined();
  expect(c.get("peerB", "ns1")).toBeUndefined();
  expect(c.get("peerA", "ns2")).toBe(true);
});
