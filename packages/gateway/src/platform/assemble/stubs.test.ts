import { describe, expect, it, spyOn } from "bun:test";
import pino from "pino";
import { createStubAutostart, createUnimplementedNotifications } from "./stubs.ts";

describe("createStubAutostart", () => {
  it("is never enabled, and enable/disable change nothing", async () => {
    const autostart = createStubAutostart();
    expect(await autostart.isEnabled()).toBe(false);
    await autostart.enable();
    expect(await autostart.isEnabled()).toBe(false);
    await autostart.disable();
    expect(await autostart.isEnabled()).toBe(false);
  });
});

describe("createUnimplementedNotifications", () => {
  it("declares that it does not deliver", () => {
    expect(createUnimplementedNotifications(pino({ level: "silent" })).delivers).toBe(false);
  });

  it("logs the title only, never the body, and resolves", async () => {
    const logger = pino({ level: "silent" });
    const info = spyOn(logger, "info");
    const svc = createUnimplementedNotifications(logger);
    await svc.show("Sync failing", "github: Secret indexed item title");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({
      event: "notification.dropped",
      title: "Sync failing",
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("Secret indexed item title");
  });

  it("turns a throwing logger into a rejection, not a synchronous throw", async () => {
    const logger = pino({ level: "silent" });
    spyOn(logger, "info").mockImplementation(() => {
      throw new Error("log sink down");
    });
    const svc = createUnimplementedNotifications(logger);
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = svc.show("t", "b");
    }).not.toThrow();
    await expect(pending).rejects.toThrow("log sink down");
  });
});
