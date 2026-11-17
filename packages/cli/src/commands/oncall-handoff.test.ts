import { describe, expect, test } from "bun:test";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { runOncallCommand } from "./oncall.ts";
import {
  ONCALL_HANDOFF_USAGE,
  type OncallHandoffIpc,
  parseOncallHandoffArgs,
  renderHandoff,
  runOncallHandoff,
  runOncallHandoffWith,
  toTimeParam,
} from "./oncall-handoff.ts";

function fake(r: unknown): OncallHandoffIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}

const NOW = Date.UTC(2026, 10, 16, 18, 0);
const H = 3_600_000;

function result(over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    asOfMs: NOW,
    window: {
      fromMs: NOW - 5 * H,
      toMs: NOW,
      basis: "own_shift",
      reason:
        "Your current on-call shift began 2026-11-16 13:00 UTC; the window runs from there to now.",
    },
    service: null,
    known: [],
    shift: {
      status: "ok",
      mine: [
        {
          source: "pagerduty",
          userName: "Alice Ng",
          scheduleName: "Payments primary",
          policyName: null,
          level: 1,
          startMs: NOW - 5 * H,
          endMs: NOW + 3 * H,
          isMe: true,
        },
      ],
      onCallNow: [
        {
          source: "pagerduty",
          userName: "Alice Ng",
          scheduleName: "Payments primary",
          policyName: "Payments policy",
          level: 1,
          startMs: null,
          endMs: null,
          isMe: true,
        },
      ],
      next: [
        {
          source: "jsm",
          userName: "Bob\u001b[31m Roy",
          scheduleName: null,
          policyName: null,
          level: null,
          startMs: null,
          endMs: null,
          isMe: false,
        },
      ],
      sources: [
        { source: "pagerduty", oldestFetchedMs: NOW - 3 * 60_000, stale: false },
        { source: "jsm", oldestFetchedMs: null, stale: true },
      ],
    },
    events: {
      items: [
        {
          kind: "opened",
          source: "pagerduty",
          itemId: "pagerduty:A",
          title: "Checkout 500s",
          url: null,
          atMs: NOW - 3 * H,
          atBasis: "provider",
          key: null,
          from: null,
          to: null,
        },
        {
          kind: "state_changed",
          source: "pagerduty",
          itemId: "pagerduty:A",
          title: "Checkout 500s",
          url: null,
          atMs: NOW - 2 * H,
          atBasis: "observed",
          key: "status",
          from: "triggered",
          to: "acknowledged",
        },
        {
          kind: "resolved",
          source: "jsm",
          itemId: "jira:AL1",
          title: "Alert",
          url: null,
          atMs: NOW - H,
          atBasis: "provider",
          key: "status",
          from: null,
          to: null,
        },
      ],
      total: 4,
    },
    deployments: {
      items: [
        {
          id: "d1",
          title: "Deploy d1",
          serviceId: "checkout",
          environment: "prod",
          conclusion: "success",
          startedAtMs: NOW - 3 * H,
        },
      ],
      total: 1,
    },
    stillOpen: {
      items: [
        {
          source: "pagerduty",
          itemId: "pagerduty:B",
          title: "Slow search",
          status: "triggered",
          severity: "P2",
          openedAtMs: NOW - 9 * H,
          acknowledged: null,
        },
        {
          source: "jsm",
          itemId: "jira:AL2",
          title: "Disk",
          status: "open",
          severity: null,
          openedAtMs: null,
          acknowledged: true,
        },
      ],
      total: 2,
    },
    watch: {
      flagged: {
        items: [
          {
            reason: "reopened",
            source: "pagerduty",
            itemId: "pagerduty:RE",
            title: "Again",
            detail: "status went resolved -> triggered",
          },
          {
            reason: "changed_state_repeatedly",
            source: "pagerduty",
            itemId: "pagerduty:A",
            title: "Checkout 500s",
            detail: "status changed 2 times",
          },
        ],
        total: 2,
      },
      deploysWithIncidents: {
        items: [
          {
            deployment: {
              id: "d1",
              title: "Deploy d1",
              serviceId: "checkout",
              environment: "prod",
              conclusion: "success",
              startedAtMs: NOW - 3 * H,
            },
            items: [
              {
                source: "pagerduty",
                itemId: "pagerduty:A",
                title: "Checkout 500s",
                openedAtMs: NOW - 3 * H + 60_000,
                stillOpen: false,
              },
            ],
          },
        ],
        total: 1,
      },
      due: {
        items: [
          { service: "jira", itemId: "jira:T-1", title: "T1", dueMs: NOW + H, overdue: false },
          { service: "github", itemId: "github:9", title: "T9", dueMs: NOW - H, overdue: true },
        ],
        total: 2,
      },
    },
    freshness: [
      { source: "pagerduty", lastSyncMs: NOW - 120_000 },
      { source: "jira", lastSyncMs: null },
    ],
    historyStartsMs: NOW - 3 * H,
    gaps: [{ code: "observation_time", detail: "Observed times can be late." }],
    ...over,
  };
}

describe("parseOncallHandoffArgs", () => {
  test("accepts the flags in both spellings and turns a duration into a past time", () => {
    expect(parseOncallHandoffArgs([])).toEqual({ json: false });
    expect(
      parseOncallHandoffArgs(["--since", "12h", "--until=-1h", "--service", "checkout", "--json"]),
    ).toEqual({ json: true, since: "-12h", until: "-1h", service: "checkout" });
    expect(parseOncallHandoffArgs(["--since=2026-11-16T08:00Z"])?.since).toBe("2026-11-16T08:00Z");
    expect(toTimeParam("2D")).toBe("-2d");
    expect(toTimeParam("yesterday-18:00")).toBe("yesterday-18:00");
  });

  test("rejects unknown flags, repeats, missing values and a flag as a service name", () => {
    for (const bad of [
      ["--bogus"],
      ["now"],
      ["--since"],
      ["--since", ""],
      ["--since=12h", "--since", "1h"],
      ["--service", "--json"],
      ["--service="],
    ]) {
      expect(parseOncallHandoffArgs(bad)).toBeUndefined();
    }
  });
});

function ref(over: Record<string, unknown> = {}) {
  return {
    recordId: "inc_0123456789abcdef",
    triggerItemId: "pagerduty:A",
    triggerService: "pagerduty",
    service: "checkout",
    title: "Checkout 500s",
    severity: "p1",
    status: "open",
    openedAtMs: NOW - 3 * H,
    closedAtMs: null,
    ...over,
  };
}

function records(over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    opened: { items: [ref()], total: 1 },
    resolved: {
      items: [ref({ recordId: "inc_r", status: "closed", closedAtMs: NOW - H })],
      total: 1,
    },
    stillOpen: { items: [ref()], total: 3 },
    smouldering: { items: [ref({ reason: "retriggered" })], total: 1 },
    freshness: [
      { service: "pagerduty", connected: true, lastSyncMs: NOW },
      { service: "sentry", connected: true, lastSyncMs: NOW - 60_000 },
      { service: "bigeye", connected: false, lastSyncMs: null },
    ],
    gaps: [{ code: "proposals_runbook_findings", detail: "Proposals are not read." }],
    ...over,
  };
}

describe("renderHandoff incident records (IC9a)", () => {
  test("an absent records key leaves the output unchanged", () => {
    const text = renderHandoff(result() as never);
    expect(text).not.toContain("## Incident records");
    expect(text).toBe(renderHandoff(result({ records: undefined }) as never));
  });

  test("renders the four lists between Still open and Watch-list, its gaps and freshness", () => {
    const text = renderHandoff(result({ records: records() }) as never);
    const order = [
      "## Still open",
      "## Incident records",
      "## Watch-list",
      "## Gaps",
      "## Data freshness",
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Opened in the window:");
    expect(text).toContain("Resolved in the window:");
    expect(text).toContain("Smouldering (open over 4 hours, or re-triggered):");
    expect(text).toContain("(p1, open, re-triggered)");
    expect(text).toContain("... and 2 more (total 3)");
    expect(text).toContain("- Proposals are not read.");
    expect(text).toContain("Sentry last synced:");
    expect(text).toContain("Bigeye last synced: not connected");
  });

  test("no records assembled says so and points at the gaps", () => {
    const text = renderHandoff(
      result({
        records: records({
          status: "no_records",
          opened: { items: [], total: 0 },
          resolved: { items: [], total: 0 },
          stillOpen: { items: [], total: 0 },
          smouldering: { items: [], total: 0 },
        }),
      }) as never,
    );
    expect(text).toContain("No incident record has been assembled yet; see Gaps.");
  });

  test("empty lists say none, and control and bidi characters in a record title are stripped", () => {
    const bidi = String.fromCharCode(0x202e);
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(7);
    const evil = ref({ title: `Pay${esc}[31mments${bidi}evil`, service: `svc${bel}` });
    const text = renderHandoff(
      result({
        records: records({
          opened: { items: [evil], total: 1 },
          resolved: { items: [], total: 0 },
        }),
      }) as never,
    );
    expect(text).toContain("Resolved in the window:\n- none\n");
    expect(text).not.toContain(esc);
    expect(text).not.toContain(bel);
    expect(text).not.toContain(bidi);
  });
});

describe("renderHandoff", () => {
  test("renders every section, the window reason, and the reserved sections last", () => {
    const text = renderHandoff(result() as never);
    const order = [
      "# On-call handoff",
      "## Shift",
      "## Events during the shift",
      "## Still open",
      "## Watch-list",
      "## Gaps",
      "## Data freshness",
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Your current on-call shift began");
    expect(text).toContain("Your shift:");
    expect(text).toContain("<- you");
    expect(text).toContain("Next on call:");
    expect(text).toContain("changed status: triggered -> acknowledged");
    expect(text).toContain("(observed)");
    expect(text).toContain("resolved status: Alert");
    expect(text).toContain("... and 1 more (total 4)");
    expect(text).toContain("Reopened: Again");
    expect(text).toContain("Changed state repeatedly");
    expect(text).toContain("(closed): Checkout 500s");
    expect(text).toContain("OVERDUE");
    expect(text).toContain("opened time unknown");
    expect(text).toContain("acknowledged");
    expect(text).toContain("Jira last synced: never recorded");
    expect(text).toContain("older than 1 h");
    expect(text).toContain("shifts: age unknown");
    expect(text).toContain("State-change history begins");
    // Provider text is stripped of control characters before it reaches a terminal.
    expect(text).not.toContain("\u001b");
  });

  test("empty lists say what they cover, never a bare 'nothing happened'", () => {
    const empty = result({
      shift: { status: "no_data", mine: [], onCallNow: [], next: [], sources: [] },
      events: { items: [], total: 0 },
      deployments: { items: [], total: 0 },
      stillOpen: { items: [], total: 0 },
      watch: {
        flagged: { items: [], total: 0 },
        deploysWithIncidents: { items: [], total: 0 },
        due: { items: [], total: 0 },
      },
      historyStartsMs: null,
      service: "checkout",
    });
    const text = renderHandoff(empty as never);
    expect(text).toContain("# On-call handoff for checkout");
    expect(text).toContain("No on-call shifts are indexed; see Gaps.");
    expect(text).toContain("No incident or alert events are recorded in this window.");
    expect(text).toContain("No open incident or alert is recorded at the end of the window.");
    expect(text).toContain("State-change history: none recorded yet");
    expect(text).toContain("## Gaps");
  });

  test("a shift section with nobody on call says so", () => {
    const text = renderHandoff(
      result({
        shift: { status: "none_on_call", mine: [], onCallNow: [], next: [], sources: [] },
      }) as never,
    );
    expect(text).toContain("No indexed shift covers now.");
  });
});

describe("runOncallHandoffWith", () => {
  test("sends only the given params, prints the brief, exits 0", async () => {
    const ipc = fake(result());
    const { s, sink: k } = sink();
    const code = await runOncallHandoffWith(
      ipc,
      { json: false, since: "-12h", until: "-1h", service: "checkout" },
      k,
    );
    expect(code).toBe(0);
    expect(ipc.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["oncall.handoff", { since: "-12h", until: "-1h", service: "checkout" }],
    ]);
    expect(s.out).toContain("## Gaps");
    const bare = fake(result());
    await runOncallHandoffWith(bare, { json: false }, sink().sink);
    expect(bare.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["oncall.handoff", {}],
    ]);
  });

  test("--json prints the result verbatim; no_match exits 1 in both modes", async () => {
    const r = result();
    const j = sink();
    expect(await runOncallHandoffWith(fake(r), { json: true }, j.sink)).toBe(0);
    expect(j.s.out).toBe(`${JSON.stringify(r)}\n`);

    const nm = result({ status: "no_match", service: "zzz", known: ["checkout", "billing"] });
    const jn = sink();
    expect(await runOncallHandoffWith(fake(nm), { json: true, service: "zzz" }, jn.sink)).toBe(1);
    const tn = sink();
    expect(await runOncallHandoffWith(fake(nm), { json: false, service: "zzz" }, tn.sink)).toBe(1);
    expect(tn.s.err).toContain('No configured service matches "zzz"');
    expect(tn.s.err).toContain("checkout, billing");
    const none = result({ status: "no_match", service: "zzz", known: [] });
    const tk = sink();
    await runOncallHandoffWith(fake(none), { json: false }, tk.sink);
    expect(tk.s.err).not.toContain("Configured services");
  });

  test("an IPC error prints {error} in json and the message otherwise, exit 1", async () => {
    const j = sink();
    expect(await runOncallHandoffWith(fake(new Error("boom")), { json: true }, j.sink)).toBe(1);
    expect(j.s.out).toBe('{"error":"boom"}\n');
    const t = sink();
    expect(await runOncallHandoffWith(fake(new Error("boom")), { json: false }, t.sink)).toBe(1);
    expect(t.s.err).toBe("boom\n");
    const n = sink();
    expect(await runOncallHandoffWith(fake("x" as never), { json: false }, n.sink)).toBe(1);
  });
});

describe("runOncallHandoff", () => {
  test("a bad argument prints the usage and exits 1 before touching the gateway", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let seen = "";
    process.stderr.write = ((c: string | Uint8Array) => {
      seen += String(c);
      return true;
    }) as typeof process.stderr.write;
    try {
      const err = await runOncallHandoff(["--bogus"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
    expect(seen).toContain(ONCALL_HANDOFF_USAGE);
  });

  test("--help prints the help and does not touch the gateway", async () => {
    const orig = process.stdout.write.bind(process.stdout);
    let seen = "";
    process.stdout.write = ((c: string | Uint8Array) => {
      seen += String(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runOncallHandoff(["--help"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(seen).toContain("Reads the local index only");
  });
});

describe("runOncallCommand handoff dispatch", () => {
  test("`handoff --bogus` never reaches the incident flag parser", async () => {
    const cap = createStreamCapture();
    cap.install();
    let thrown: unknown;
    try {
      await runOncallCommand(["handoff", "--bogus"]);
    } catch (e) {
      thrown = e;
    } finally {
      cap.restore();
    }
    expect(thrown).toBeInstanceOf(CliExit);
    expect(cap.stderrChunks.join("")).toContain("Usage: nimbus oncall handoff");
  });
});
