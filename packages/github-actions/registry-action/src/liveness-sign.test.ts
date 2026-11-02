/**
 * `liveness-sign` over real git: a bare origin with a signed `gh-pages` whose index names a liveness
 * key and lists one published stable extension, plus a workspace clone. Nothing leaves the temp dir.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LivenessFile,
  MAX_LIVENESS_BYTES,
  parseLivenessFile,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  signIndex,
  signLivenessFile,
  validatePublish,
  verifyLivenessFile,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import {
  MAX_LIVENESS_RESULTS_BYTES,
  readLivenessResults,
  runLivenessSign,
  verifyCommittedBytes,
} from "./liveness-sign.ts";
import type { ActionIo } from "./report.ts";
import { runSign } from "./sign.ts";
import {
  b64,
  copyRegistryRepo,
  makeExtension,
  makeRegistryRepo,
  OTHER_SEED,
  originFile,
  originHead,
  originIndex,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_SEED,
  syncMaintainer,
  write,
  writePublish,
} from "./testing/registry-repo.ts";

setDefaultTimeout(60_000);

const LIVENESS_SEED = new Uint8Array(32).fill(5);
const LIVENESS_INPUT = b64(LIVENESS_SEED);
const LIVENESS_KEY = b64(publicKeyFromSeed(LIVENESS_SEED));
const VERSION = "10.14.1";
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const GOOD = { checkedAt: FRESH, hosts: { declared: 2, answered: 2 } };
const DAY = 86_400_000;

/** Re-sign `gh-pages`' index with `livenessKey` set to `value` (absent when undefined). */
async function setIndexLivenessKey(repo: RegistryRepo, value: unknown): Promise<void> {
  syncMaintainer(repo, "gh-pages");
  const {
    signature: _s,
    livenessKey: _k,
    ...rest
  } = originIndex(repo) as unknown as Record<string, unknown>;
  const next = await signIndex(
    { ...rest, ...(value !== undefined && { livenessKey: value }) } as never,
    ROOT_SEED,
  );
  write(repo.maintainer, "index.json", `${JSON.stringify(next, null, 2)}\n`);
  pushMaintainer(repo, "gh-pages", "set liveness key");
}

let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-liveness-sign-template-"));
  template = await makeRegistryRepo(join(templateDir, "reg"));
  const scratch = join(templateDir, "scratch");
  mkdirSync(scratch);
  writePublish(template.maintainer, await makeExtension(scratch));
  pushMaintainer(template, "main", "publish");
  await runSign(
    { workspace: template.workspace, rootKey: ROOT_KEY_INPUT },
    {
      git: gitTree,
      io: { annotate: () => {}, summary: () => {}, log: () => {} },
      tmpdir: () => scratch,
      sign: signIndex,
      validate: validatePublish,
    },
  );
  await setIndexLivenessKey(template, LIVENESS_KEY);
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

let tmp: string;
let repo: RegistryRepo;
let warnings: string[];
let summaries: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-liveness-sign-"));
  repo = copyRegistryRepo(template, join(tmp, "reg"));
  warnings = [];
  summaries = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: (level, msg) => {
    if (level === "warning") warnings.push(msg);
  },
  summary: (md) => void summaries.push(md),
  log: () => {},
};

function results(body: unknown, name = "results.json"): string {
  const p = join(tmp, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

const envelope = (extensions: unknown, nimbusVersion: unknown = VERSION): unknown => ({
  format: 1,
  nimbusVersion,
  extensions,
});

interface SignOpts {
  key?: string;
  nimbusVersion?: string;
  beforePush?: (n: number) => void | Promise<void>;
}

const sign = (resultsPath: string, o: SignOpts = {}): Promise<void> =>
  runLivenessSign(
    {
      workspace: repo.workspace,
      livenessKey: o.key ?? LIVENESS_INPUT,
      defaultBranch: "main",
      results: resultsPath,
      nimbusVersion: o.nimbusVersion ?? VERSION,
    },
    {
      git: gitTree,
      io,
      now: () => NOW,
      ...(o.beforePush !== undefined && { beforePush: o.beforePush }),
    },
  );

const originLiveness = (): LivenessFile =>
  parseLivenessFile(new Uint8Array(originFile(repo, "gh-pages", "liveness.json")));

const entryKeys = (doc: LivenessFile): string[] => Object.keys(doc.extensions as object);

describe("verifyCommittedBytes", () => {
  test("refuses a document over the client's size cap before anything is committed", async () => {
    const big = new Uint8Array(MAX_LIVENESS_BYTES + 1).fill(0x20);
    await expect(verifyCommittedBytes(big, LIVENESS_KEY)).rejects.toThrow();
  });
});

describe("runLivenessSign", () => {
  test("round trip: the committed file verifies and holds exactly the allowed entries; index untouched", async () => {
    const indexBefore = originFile(repo, "gh-pages", "index.json");
    await sign(
      results(
        envelope({
          "acme/echo@1.0.0": GOOD,
          "acme/echo@0.9.0": GOOD, // not the newest stable
          "acme/ghost@1.0.0": GOOD, // not in the index
        }),
      ),
    );
    const doc = originLiveness();
    await verifyLivenessFile(doc, LIVENESS_KEY);
    expect(doc.sequence).toBe(1);
    expect(doc.nimbusVersion).toBe(VERSION);
    expect(doc.generatedAt).toBe(new Date(NOW).toISOString());
    expect(entryKeys(doc)).toEqual(["acme/echo@1.0.0"]);
    expect(originFile(repo, "gh-pages", "index.json")).toEqual(indexBefore);
    expect(warnings.join("\n")).toContain("acme/echo@0.9.0");
    expect(warnings.join("\n")).toContain("acme/ghost@1.0.0");
  });

  test("sequence is 1 with no previous file, then 2", async () => {
    const p = results(envelope({ "acme/echo@1.0.0": GOOD }));
    await sign(p);
    expect(originLiveness().sequence).toBe(1);
    syncMaintainer(repo, "gh-pages");
    await sign(p);
    expect(originLiveness().sequence).toBe(2);
  });

  test("a previous file signed by another key restarts at prev.sequence + 1 and reuses nothing", async () => {
    syncMaintainer(repo, "gh-pages");
    const prev = await signLivenessFile(
      {
        format: 1,
        livenessKey: b64(publicKeyFromSeed(OTHER_SEED)),
        sequence: 7,
        generatedAt: new Date(NOW - 3_600_000).toISOString(),
        nimbusVersion: VERSION,
        extensions: { "acme/echo@1.0.0": GOOD, "acme/old@1.0.0": GOOD },
      },
      OTHER_SEED,
    );
    write(repo.maintainer, "liveness.json", `${JSON.stringify(prev, null, 2)}\n`);
    pushMaintainer(repo, "gh-pages", "foreign liveness");
    await sign(
      results(
        envelope({ "acme/echo@1.0.0": { checkedAt: FRESH, hosts: { declared: 1, answered: 0 } } }),
      ),
    );
    const doc = originLiveness();
    expect(doc.sequence).toBe(8);
    expect(entryKeys(doc)).toEqual(["acme/echo@1.0.0"]);
    const mine = (doc.extensions as Record<string, { hosts: { answered: number } }>)[
      "acme/echo@1.0.0"
    ];
    expect(mine?.hosts.answered).toBe(0);
  });

  describe("key refusals commit nothing and never name a seed", () => {
    const refuse = async (key: string, pattern: RegExp): Promise<void> => {
      const head = originHead(repo, "gh-pages");
      let message = "";
      try {
        await sign(results(envelope({ "acme/echo@1.0.0": GOOD })), { key });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain(key);
      expect(originHead(repo, "gh-pages")).toBe(head);
    };

    test("an index naming no liveness key", async () => {
      await setIndexLivenessKey(repo, undefined);
      await refuse(LIVENESS_INPUT, /names no liveness key.*set-liveness-key/);
    });

    test("an index naming a malformed liveness key", async () => {
      await setIndexLivenessKey(repo, "junk");
      await refuse(LIVENESS_INPUT, /malformed/);
    });

    test("a key whose public half is not the index's names both fingerprints", async () => {
      const otherFp = publisherKeyFingerprint(b64(publicKeyFromSeed(OTHER_SEED)));
      const indexFp = publisherKeyFingerprint(LIVENESS_KEY);
      await refuse(b64(OTHER_SEED), new RegExp(`${otherFp}.*${indexFp}|${indexFp}.*${otherFp}`));
    });

    test("the root key supplied as the liveness key", async () => {
      await setIndexLivenessKey(repo, b64(publicKeyFromSeed(ROOT_SEED)));
      await refuse(ROOT_KEY_INPUT, /root key/);
    });

    test("a non-canonical alias of the root key in the index is refused", async () => {
      const root = b64(publicKeyFromSeed(ROOT_SEED));
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const alias = `${root.slice(0, 42)}${chars[chars.indexOf(root[42] as string) + 1]}=`;
      await setIndexLivenessKey(repo, alias);
      await refuse(ROOT_KEY_INPUT, /malformed|root key/);
    });

    test("a malformed key", async () => {
      await refuse("not-a-key", /liveness-key/);
    });

    test("a non-canonical root key in the index is refused, not skipped", async () => {
      const root = b64(publicKeyFromSeed(ROOT_SEED));
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const alias = `${root.slice(0, 42)}${chars[chars.indexOf(root[42] as string) + 1]}=`;
      syncMaintainer(repo, "gh-pages");
      const { signature: _s, ...rest } = originIndex(repo) as unknown as Record<string, unknown>;
      const next = await signIndex({ ...rest, rootKey: alias } as never, ROOT_SEED);
      write(
        repo.maintainer,
        "index.json",
        `${JSON.stringify(next, null, 2)}
`,
      );
      pushMaintainer(repo, "gh-pages", "alias root key");
      await refuse(LIVENESS_INPUT, /malformed root key/);
    });
  });

  describe("hostile results files", () => {
    test.each([
      ["extra top-level key", { ...(envelope({ "acme/echo@1.0.0": GOOD }) as object), extra: 1 }],
      ["format 2", { format: 2, nimbusVersion: VERSION, extensions: {} }],
      ["array extensions", envelope([])],
      ["null extensions", envelope(null)],
      ["a different nimbusVersion", envelope({ "acme/echo@1.0.0": GOOD }, "10.14.2")],
      ["a malformed nimbusVersion", envelope({ "acme/echo@1.0.0": GOOD }, "latest")],
      ["a numeric nimbusVersion", envelope({ "acme/echo@1.0.0": GOOD }, 10)],
      ["a JSON array", []],
      ["not JSON", "{nope"],
    ])("refuses %s", async (_name, body) => {
      const before = originHead(repo, "gh-pages");
      await expect(sign(results(body))).rejects.toThrow();
      expect(originHead(repo, "gh-pages")).toBe(before);
    });

    test("refuses a file over the byte cap", async () => {
      const pad = " ".repeat(MAX_LIVENESS_RESULTS_BYTES + 1);
      await expect(sign(results(`${JSON.stringify(envelope({}))}${pad}`))).rejects.toThrow(/bytes/);
    });

    test("refuses invalid UTF-8", async () => {
      const p = join(tmp, "bad.json");
      writeFileSync(p, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
      await expect(sign(p)).rejects.toThrow();
    });

    test("a __proto__ entry, a stale one, a future one and free text are dropped, not signed", () => {
      const entry = (v: unknown): string => JSON.stringify(v);
      const raw = `{"format":1,"nimbusVersion":"${VERSION}","extensions":{"__proto__":${entry(GOOD)},"acme/echo@1.0.0":${entry(GOOD)},"acme/old@1.0.0":${entry({ checkedAt: new Date(NOW - 2 * DAY).toISOString() })},"acme/future@1.0.0":${entry({ checkedAt: new Date(NOW + 3_600_000).toISOString() })},"acme/text@1.0.0":${entry({ checkedAt: FRESH, hosts: { declared: "many", answered: 1 } })}}}`;
      const parsed = readLivenessResults(results(raw), NOW, VERSION, io);
      expect(Object.keys(parsed.extensions)).toEqual(["acme/echo@1.0.0"]);
      expect(Object.getPrototypeOf(parsed.extensions)).toBeNull();
      expect(warnings.length).toBeGreaterThanOrEqual(4);
    });

    test("every entry dropped: nothing to publish, no commit", async () => {
      const before = originHead(repo, "gh-pages");
      await sign(
        results(
          envelope({ "acme/echo@1.0.0": { checkedAt: new Date(NOW - 2 * DAY).toISOString() } }),
        ),
      );
      expect(originHead(repo, "gh-pages")).toBe(before);
      expect(summaries.join("\n")).toContain("nothing to publish");
    });

    test("an empty extensions map: nothing to publish", async () => {
      const before = originHead(repo, "gh-pages");
      await sign(results(envelope({})));
      expect(originHead(repo, "gh-pages")).toBe(before);
    });
  });

  test("an unparsable previous liveness.json restarts at sequence 1, with a warning", async () => {
    syncMaintainer(repo, "gh-pages");
    write(repo.maintainer, "liveness.json", "this is not json\n");
    pushMaintainer(repo, "gh-pages", "garbage liveness");
    await sign(results(envelope({ "acme/echo@1.0.0": GOOD })));
    expect(originLiveness().sequence).toBe(1);
    expect(warnings.join("\n")).toContain("does not parse");
  });

  test("a race that adds a liveness.json with a higher sequence makes the retry use it plus 1", async () => {
    await sign(results(envelope({ "acme/echo@1.0.0": GOOD })), {
      beforePush: async (n) => {
        if (n !== 1) return;
        syncMaintainer(repo, "gh-pages");
        const higher = await signLivenessFile(
          {
            format: 1,
            livenessKey: LIVENESS_KEY,
            sequence: 9,
            generatedAt: new Date(NOW - 1000).toISOString(),
            nimbusVersion: VERSION,
            extensions: { "acme/echo@1.0.0": GOOD },
          },
          LIVENESS_SEED,
        );
        write(repo.maintainer, "liveness.json", `${JSON.stringify(higher, null, 2)}\n`);
        pushMaintainer(repo, "gh-pages", "concurrent liveness run");
      },
    });
    expect(originLiveness().sequence).toBe(10);
  });

  test("a race that makes an entry no longer newest stable drops it on the retry", async () => {
    const before = originHead(repo, "gh-pages");
    await sign(results(envelope({ "acme/echo@1.0.0": GOOD })), {
      beforePush: async (n) => {
        if (n !== 1) return;
        syncMaintainer(repo, "gh-pages");
        const { signature: _s, ...rest } = originIndex(repo);
        const echo = rest.extensions["acme/echo"];
        const v = echo?.versions["1.0.0"];
        if (echo === undefined || v === undefined) throw new Error("fixture changed");
        const demoted = {
          ...rest,
          extensions: {
            ...rest.extensions,
            "acme/echo": { ...echo, versions: { "1.0.0": { ...v, channel: "beta" } } },
          },
        };
        const next = await signIndex(demoted as never, ROOT_SEED);
        write(repo.maintainer, "index.json", `${JSON.stringify(next, null, 2)}\n`);
        pushMaintainer(repo, "gh-pages", "demote to beta");
      },
    });
    expect(originHead(repo, "gh-pages")).not.toBe(before);
    expect(() => originFile(repo, "gh-pages", "liveness.json")).toThrow();
    expect(warnings.join("\n")).toContain("published nothing");
  });

  test("a push error that is not a non-fast-forward is thrown, not retried", async () => {
    const hook = join(repo.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho declined by policy >&2\nexit 1\n", { mode: 0o755 });
    let attempts = 0;
    await expect(
      sign(results(envelope({ "acme/echo@1.0.0": GOOD })), {
        beforePush: () => {
          attempts++;
        },
      }),
    ).rejects.toThrow(/git push to gh-pages failed/);
    expect(attempts).toBe(1);
  });

  test("every entry dropped emits a warning with counts, so a broken check job is not silent", async () => {
    await sign(results(envelope({ "acme/ghost@1.0.0": GOOD })));
    const w = warnings.join("\n");
    expect(w).toContain("liveness-sign published nothing");
    expect(w).toContain("1 results entries passed validation and 0 were");
  });

  test("a push that loses a race retries from a fresh fetch and succeeds", async () => {
    let raced = 0;
    await sign(results(envelope({ "acme/echo@1.0.0": GOOD })), {
      beforePush: (n) => {
        if (n !== 1) return;
        raced++;
        syncMaintainer(repo, "gh-pages");
        write(repo.maintainer, "race.txt", "x\n");
        pushMaintainer(repo, "gh-pages", "race");
      },
    });
    expect(raced).toBe(1);
    expect(originLiveness().sequence).toBe(1);
    expect(originFile(repo, "gh-pages", "race.txt").toString()).toBe("x\n");
  });

  test("after 3 lost races it throws", async () => {
    await expect(
      sign(results(envelope({ "acme/echo@1.0.0": GOOD })), {
        beforePush: (n) => {
          syncMaintainer(repo, "gh-pages");
          write(repo.maintainer, `race-${String(n)}.txt`, "x\n");
          pushMaintainer(repo, "gh-pages", `race ${String(n)}`);
        },
      }),
    ).rejects.toThrow(/3 times/);
  });
});
