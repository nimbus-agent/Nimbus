import { describe, expect, test } from "bun:test";
import { CliExit } from "./cli-exit.ts";
import {
  runTour,
  type TourRunners,
  type TourStep,
  type TourStepKind,
  tourHeader,
} from "./run-tour.ts";

const step = (kind: TourStepKind): TourStep => ({
  kind,
  title: `T-${kind}`,
  command: `nimbus ${kind}`,
  args: ["x"],
  reason: "r",
});

const noop = async (): Promise<void> => {};

const runners = (over: Partial<TourRunners>): TourRunners => ({
  why: noop,
  owners: noop,
  oncall: noop,
  standup: noop,
  decisions: noop,
  glossary: noop,
  ...over,
});

describe("runTour", () => {
  test("a CliExit from one step does not stop the next", async () => {
    const ran: string[] = [];
    const errs: string[] = [];
    const res = await runTour(
      [step("oncall"), step("why")],
      runners({
        oncall: async () => {
          throw new CliExit(2);
        },
        why: async (a) => {
          ran.push(a.join(","));
        },
      }),
      () => {},
      (s) => errs.push(s),
      3,
    );
    expect(res).toEqual([
      { kind: "oncall", ok: false },
      { kind: "why", ok: true },
    ]);
    expect(ran).toEqual(["x"]);
    expect(errs).toEqual([]); // CliExit: the site already printed
  });

  test("an ordinary Error is printed under its header, and the tour continues", async () => {
    const errs: string[] = [];
    const res = await runTour(
      [step("why")],
      runners({
        why: async () => {
          throw new Error("boom");
        },
      }),
      () => {},
      (s) => errs.push(s),
      1,
    );
    expect(res[0]?.ok).toBe(false);
    expect(errs.join("")).toContain("boom");
  });

  test("process.exitCode set by a runner does not leak out", async () => {
    const before = process.exitCode;
    await runTour(
      [step("why")],
      runners({
        why: async () => {
          process.exitCode = 2;
        },
      }),
      () => {},
      () => {},
      1,
    );
    expect(process.exitCode).toBe(before);
  });

  test("header shows i/total and the literal command", () => {
    expect(tourHeader(2, 4, "Why", "nimbus why a")).toContain("[2/4] Why");
    expect(tourHeader(2, 4, "Why", "nimbus why a")).toContain("$ nimbus why a");
  });
});
