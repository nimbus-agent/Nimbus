import { describe, expect, test } from "bun:test";

import {
  ec2InstanceReadArgs,
  ecsServiceReadArgs,
  lambdaListReadArgs,
  selectEc2Instance,
  selectEcsService,
  selectLambdaFunction,
} from "./cloud-readers.ts";
import {
  hasFacet,
  onedriveParent,
  selectAppleEventDelete,
  selectOnedriveItemDelete,
  selectOutlookEventDelete,
  singleIdArgs,
} from "./delete-readers.ts";

function get(fields: readonly { label: string; value: string }[], label: string): string {
  return fields.find((f) => f.label === label)?.value ?? "<absent>";
}

describe("cloud readers: read arguments", () => {
  test("the Lambda list needs a function name but sends nothing", () => {
    expect(lambdaListReadArgs({ functionName: "fn" })).toEqual({});
    expect(lambdaListReadArgs({ functionName: "" })).toBeUndefined();
    expect(lambdaListReadArgs({})).toBeUndefined();
  });

  test("EC2 maps the write's instanceIds to the read's instanceId", () => {
    expect(ec2InstanceReadArgs({ instanceIds: "i-1" })).toEqual({ instanceId: "i-1" });
    expect(ec2InstanceReadArgs({ instanceIds: "" })).toBeUndefined();
  });

  test("ECS needs both the cluster and the service", () => {
    expect(ecsServiceReadArgs({ cluster: "c", service: "s" })).toEqual({
      cluster: "c",
      service: "s",
    });
    expect(ecsServiceReadArgs({ cluster: "c" })).toBeUndefined();
    expect(ecsServiceReadArgs({ service: "s" })).toBeUndefined();
  });
});

describe("selectLambdaFunction", () => {
  test("matches the exact name in the first page and shows its configuration", () => {
    const f = selectLambdaFunction(
      {
        Functions: [
          { FunctionName: "other", Runtime: "x" },
          { FunctionName: "fn", Runtime: "nodejs22.x", MemorySize: 256, Timeout: 30 },
        ],
      },
      { functionName: "fn" },
    );
    expect(get(f, "Function")).toBe("fn");
    expect(get(f, "Runtime")).toBe("nodejs22.x");
    expect(get(f, "Memory")).toBe("256 MB");
    expect(get(f, "Timeout")).toBe("30 s");
    expect(get(f, "Handler")).toBe("<absent>");
  });

  test("a function that is not listed, a non-string name or a missing list refuses the write", () => {
    const reply = { Functions: [{ FunctionName: "other" }] };
    expect(() => selectLambdaFunction(reply, { functionName: "fn" })).toThrow("not in the list");
    expect(() => selectLambdaFunction(reply, { functionName: 7 })).toThrow("not in the list");
    expect(() => selectLambdaFunction({}, { functionName: "fn" })).toThrow("no Functions");
  });
});

describe("selectEc2Instance", () => {
  const base = { instanceId: "i-1", instanceType: "t3.micro", launchTime: "2026-01-01" };

  test("says so when the instance is already in the requested state", () => {
    expect(get(selectEc2Instance("stop")({ ...base, state: "stopped" }), "State")).toBe(
      "stopped: it is already stopped, so stopping it does nothing",
    );
    expect(get(selectEc2Instance("start")({ ...base, state: "running" }), "State")).toBe(
      "running: it is already running, so starting it does nothing",
    );
    expect(get(selectEc2Instance("stop")({ ...base, state: "running" }), "State")).toBe("running");
  });

  test("lists tags as key=value, tolerating a missing value and a tag without a key", () => {
    const f = selectEc2Instance("stop")({
      ...base,
      state: "running",
      iamProfileArn: "arn:aws:iam::1:instance-profile/p",
      tags: [{ key: "env", value: "prod" }, { key: "bare" }, { value: "orphan" }],
    });
    expect(get(f, "Tags")).toContain("env=prod");
    expect(get(f, "Tags")).toContain("bare=");
    expect(get(f, "Tags")).not.toContain("orphan");
    expect(get(f, "IAM profile")).toBe("arn:aws:iam::1:instance-profile/p");
    expect(get(selectEc2Instance("stop")({ ...base, state: "running" }), "Tags")).toBe("<absent>");
  });

  test("a reply without an instance id is refused", () => {
    expect(() => selectEc2Instance("stop")({ state: "running" })).toThrow();
  });
});

describe("selectEcsService", () => {
  test("shows the task definition change when the write names one, else the current one", () => {
    const reply = {
      serviceName: "web",
      status: "ACTIVE",
      desiredCount: 3,
      runningCount: 2,
      taskDefinition: "web:1",
      launchType: "FARGATE",
    };
    const changed = selectEcsService(reply, { taskDefinition: "web:2" });
    expect(get(changed, "Task definition")).toBe("web:1 -> web:2");
    expect(get(changed, "Desired count")).toBe("3");
    expect(get(selectEcsService(reply, {}), "Task definition")).toBe("web:1");
    const unknown = selectEcsService({ serviceName: "web" }, { taskDefinition: "web:2" });
    expect(get(unknown, "Task definition")).toBe("<absent>");
  });
});

describe("delete readers", () => {
  test("hasFacet and onedriveParent read own properties only", () => {
    expect(hasFacet({ folder: {} }, "folder")).toBe(true);
    expect(hasFacet({ folder: null }, "folder")).toBe(false);
    expect(hasFacet({ folder: 1 }, "folder")).toBe(false);
    expect(hasFacet(null, "folder")).toBe(false);
    expect(hasFacet(Object.create({ folder: {} }), "folder")).toBe(false);
    expect(onedriveParent({ parentReference: { path: "/drive/root:/a", id: "p" } })).toBe(
      "/drive/root:/a",
    );
    expect(onedriveParent({ parentReference: { id: "p" } })).toBe("p");
    expect(onedriveParent({})).toBeUndefined();
  });

  test("singleIdArgs renames one non-empty input", () => {
    const args = singleIdArgs("itemId", "id");
    expect(args({ id: "x" })).toEqual({ itemId: "x" });
    expect(args({ id: "" })).toBeUndefined();
    expect(args({})).toBeUndefined();
  });

  test("OneDrive: a folder says it takes everything inside; a file, an item and sharing", () => {
    const folder = selectOnedriveItemDelete({
      name: "Docs",
      folder: { childCount: 4 },
      parentReference: { path: "/drive/root:" },
      shared: {},
      size: 10,
    });
    expect(get(folder, "Type")).toBe("folder with 4 items: deleting it deletes everything inside");
    expect(get(folder, "Shared")).toBe("yes: others can open it");
    expect(get(folder, "Size")).toBe("10 bytes");
    expect(get(selectOnedriveItemDelete({ name: "D", folder: {} }), "Type")).toBe(
      "folder: deleting it deletes everything inside",
    );
    expect(get(selectOnedriveItemDelete({ name: "f", file: {} }), "Type")).toBe("file");
    expect(get(selectOnedriveItemDelete({ name: "x" }), "Type")).toBe("item");
    expect(get(selectOnedriveItemDelete({ name: "x" }), "Shared")).toBe("no");
  });

  test("Outlook: time zone, organiser and attendees, with each fallback", () => {
    const full = selectOutlookEventDelete({
      subject: "Sync",
      start: { dateTime: "2026-01-01T10:00", timeZone: "UTC" },
      end: { dateTime: "2026-01-01T11:00" },
      organizer: { emailAddress: { name: "Ada" } },
      isOrganizer: true,
      isCancelled: false,
      attendees: [{ emailAddress: { address: "a@x.io" } }, { emailAddress: {} }],
    });
    expect(get(full, "Start")).toBe("2026-01-01T10:00 (UTC)");
    expect(get(full, "End")).toBe("2026-01-01T11:00");
    expect(get(full, "Organizer")).toBe("Ada");
    expect(get(full, "Attendees")).toStartWith("2: ");
    const none = selectOutlookEventDelete({ subject: "S", attendees: [] });
    expect(get(none, "Attendees")).toBe("(none)");
    const unreadable = selectOutlookEventDelete({ subject: "S", attendees: [{}] });
    expect(get(unreadable, "Attendees")).toBe("1: (unreadable)");
    const byAddress = selectOutlookEventDelete({
      subject: "S",
      organizer: { emailAddress: { address: "o@x.io", name: "O" } },
    });
    expect(get(byAddress, "Organizer")).toBe("o@x.io");
    expect(() => selectOutlookEventDelete({})).toThrow();
  });

  test("iCloud: a recurring event says the whole series goes; attendee fallbacks", () => {
    const f = selectAppleEventDelete({
      uid: "u1",
      summary: "Standup",
      rrule: "FREQ=DAILY",
      attendees: ["a@x.io", 5],
    });
    expect(get(f, "Recurrence")).toContain("this deletes the whole series (FREQ=DAILY)");
    expect(get(f, "Attendees")).toStartWith("2: ");
    const bare = selectAppleEventDelete({ uid: "u2", attendees: [] });
    expect(get(bare, "Summary")).toBe("(no title)");
    expect(get(bare, "Attendees")).toBe("(none)");
    expect(get(bare, "Recurrence")).toBe("<absent>");
    expect(get(selectAppleEventDelete({ uid: "u3", attendees: [7] }), "Attendees")).toBe(
      "1: (unreadable)",
    );
    expect(() => selectAppleEventDelete({ summary: "no uid" })).toThrow();
  });
});
