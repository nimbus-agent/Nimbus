import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "../config/profiles.ts";
import { dispatchProfileRpc } from "./profile-rpc.ts";

function makeMgr(): ProfileManager {
  return new ProfileManager(mkdtempSync(join(tmpdir(), "nimbus-prof-")));
}

describe("profile.list", () => {
  test("returns empty list + active=null before any create", async () => {
    const r = await dispatchProfileRpc("profile.list", null, { manager: makeMgr() });
    expect(r.kind).toBe("hit");
    const v = (r as { kind: "hit"; value: { profiles: unknown[]; active: string | null } }).value;
    expect(v.profiles).toEqual([]);
    expect(v.active).toBeNull();
  });

  test("returns created profiles + current active", async () => {
    const mgr = makeMgr();
    mgr.create("work");
    mgr.switchTo("work");
    const r = await dispatchProfileRpc("profile.list", null, { manager: mgr });
    const v = (
      r as { kind: "hit"; value: { profiles: Array<{ name: string }>; active: string | null } }
    ).value;
    expect(v.profiles.map((p) => p.name)).toEqual(["work"]);
    expect(v.active).toBe("work");
  });
});

describe("profile.create", () => {
  test("creates a new profile and returns it", async () => {
    const mgr = makeMgr();
    const r = await dispatchProfileRpc("profile.create", { name: "work" }, { manager: mgr });
    expect(r.kind).toBe("hit");
    const profiles = mgr.list();
    expect(profiles.map((p) => p.name)).toEqual(["work"]);
  });

  test("rejects duplicate names", async () => {
    const mgr = makeMgr();
    mgr.create("work");
    await expect(
      dispatchProfileRpc("profile.create", { name: "work" }, { manager: mgr }),
    ).rejects.toThrow();
  });

  test("rejects invalid names", async () => {
    await expect(
      dispatchProfileRpc("profile.create", { name: "bad name!" }, { manager: makeMgr() }),
    ).rejects.toThrow();
  });

  test("rejects missing name param", async () => {
    await expect(
      dispatchProfileRpc("profile.create", null, { manager: makeMgr() }),
    ).rejects.toThrow();
  });
});

describe("profile.switch", () => {
  test("switches active profile and emits profile.switched", async () => {
    const mgr = makeMgr();
    mgr.create("work");
    const notifications: { method: string; params: unknown }[] = [];
    const r = await dispatchProfileRpc(
      "profile.switch",
      { name: "work" },
      { manager: mgr, notify: (m, p) => notifications.push({ method: m, params: p }) },
    );
    expect(r.kind).toBe("hit");
    expect(mgr.getActive()).toBe("work");
    expect(notifications.some((n) => n.method === "profile.switched")).toBe(true);
  });

  test("rejects unknown profile", async () => {
    await expect(
      dispatchProfileRpc("profile.switch", { name: "ghost" }, { manager: makeMgr() }),
    ).rejects.toThrow();
  });
});

describe("profile.delete", () => {
  test("deletes a non-active profile", async () => {
    const mgr = makeMgr();
    mgr.create("work");
    mgr.create("personal");
    mgr.switchTo("work");
    const r = await dispatchProfileRpc("profile.delete", { name: "personal" }, { manager: mgr });
    expect(r.kind).toBe("hit");
    expect(mgr.list().map((p) => p.name)).toEqual(["work"]);
  });

  test("refuses to delete the active profile", async () => {
    const mgr = makeMgr();
    mgr.create("work");
    mgr.switchTo("work");
    await expect(
      dispatchProfileRpc("profile.delete", { name: "work" }, { manager: mgr }),
    ).rejects.toThrow();
  });
});

describe("dispatchProfileRpc", () => {
  test("returns miss for unknown method", async () => {
    const r = await dispatchProfileRpc("profile.unknown", null, { manager: makeMgr() });
    expect(r.kind).toBe("miss");
  });
});
