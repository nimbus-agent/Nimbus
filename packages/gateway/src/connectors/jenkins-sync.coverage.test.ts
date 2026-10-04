/**
 * Jenkins paths the existing suites leave dark:
 *  - `jenkinsFetchOneUrlIsSupported`, the targeted-fetch pre-check (`platform/assemble.ts` wires it;
 *    nothing tested it directly), which must agree with `fetchOne` about which URLs it serves;
 *  - builds listed NEWEST-first (Jenkins' real order) — the cursor must keep the highest number,
 *    not the last one seen;
 *  - a build with no `timestamp`, which is dated at the sync time instead of being dropped;
 *  - a job whose full name has no non-blank segment.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createJenkinsSyncable, jenkinsFetchOneUrlIsSupported } from "./jenkins-sync.ts";
import { decodeNimbusJsonCursorObject } from "./nimbus-json-cursor.ts";

const BASE = "https://ci.example.test";
const JOBS_RE = /^https:\/\/ci\.example\.test\/api\/json\?tree=/;
const ENSURE = { ensureJenkinsMcpRunning: async (): Promise<void> => {} };

describe("jenkinsFetchOneUrlIsSupported", () => {
  test("accepts top-level and nested-folder build URLs, with or without a trailing slash", () => {
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/build/12`)).toBe(true);
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/team/job/svc/5/`)).toBe(true);
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/a%20b/7`)).toBe(true);
  });

  test("rejects URLs that are not a single build", () => {
    // A job page, no build number.
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/build/`)).toBe(false);
    // A build sub-page.
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/build/12/console`)).toBe(false);
    // Not a /job/ path at all.
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/view/all/12`)).toBe(false);
  });

  test("rejects segments that decode to traversal, a smuggled slash, untrimmed space, or bad escapes", () => {
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/%2E%2E/3`)).toBe(false);
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/a%2Fb/3`)).toBe(false);
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/%20name/3`)).toBe(false);
    expect(jenkinsFetchOneUrlIsSupported(`${BASE}/job/%E0%A4%A/3`)).toBe(false);
  });
});

describe("jenkins-sync — periodic walk edge cases", () => {
  let fetchStub: StubFetch;
  let db: Database;

  beforeEach(() => {
    fetchStub = new StubFetch();
    fetchStub.install();
    db = createMemoryIndexDb();
  });

  afterEach(() => {
    fetchStub.restore();
    db.close();
  });

  function ctx() {
    return syncTestContext(
      db,
      createStubVault({
        "jenkins.base_url": BASE,
        "jenkins.username": "u",
        "jenkins.api_token": "t",
      }),
      "jenkins",
    );
  }

  function cursorJobs(cursor: string | null): unknown {
    return decodeNimbusJsonCursorObject(cursor, "nimbus-jnk1:")?.["jobs"];
  }

  test("newest-first builds are all indexed and the cursor keeps the HIGHEST number", async () => {
    const now = Date.now();
    fetchStub.respond("GET", JOBS_RE, { jobs: [{ name: "svc", url: `${BASE}/job/svc/` }] });
    fetchStub.respond("GET", /\/job\/svc\/api\/json\?tree=/, {
      builds: [
        { number: 12, result: "SUCCESS", timestamp: now - 1_000 },
        { number: 11, result: "FAILURE", timestamp: now - 2_000 },
        { number: 10, result: "SUCCESS", timestamp: now - 3_000 },
      ],
    });

    const res = await createJenkinsSyncable(ENSURE).sync(ctx(), null);

    expect(res.itemsUpserted).toBe(3);
    expect(cursorJobs(res.cursor)).toEqual({ svc: 12 });
    const ids = (
      db
        .query("SELECT external_id FROM item WHERE service = 'jenkins' ORDER BY external_id")
        .all() as { external_id: string }[]
    ).map((r) => r.external_id);
    expect(ids).toEqual(["svc#10", "svc#11", "svc#12"]);
  });

  test("a build with no timestamp is dated at the sync time, not dropped", async () => {
    fetchStub.respond("GET", JOBS_RE, { jobs: [{ name: "nightly" }] });
    fetchStub.respond("GET", /\/job\/nightly\/api\/json\?tree=/, {
      builds: [{ number: 3, building: true }],
    });

    const before = Date.now();
    const res = await createJenkinsSyncable(ENSURE).sync(ctx(), null);
    const after = Date.now();

    expect(res.itemsUpserted).toBe(1);
    const row = db.query("SELECT title, modified_at FROM item WHERE service = 'jenkins'").get() as {
      title: string;
      modified_at: number;
    };
    expect(row.title).toBe("nightly #3 (running)");
    expect(row.modified_at).toBeGreaterThanOrEqual(before);
    expect(row.modified_at).toBeLessThanOrEqual(after);
  });

  // Pins CURRENT behaviour, not a requirement: this is the only way to reach the empty-path branch
  // of `jobPathFromFullName`. Jenkins never lists a blank job name, and if one ever arrived,
  // skipping it would arguably beat requesting `/job//api/json` — update this test if that changes.
  test("a job whose full name has no non-blank segment is requested at the bare /job/ root", async () => {
    fetchStub.respond("GET", JOBS_RE, { jobs: [{ fullName: " / " }] });
    fetchStub.respond("GET", /^https:\/\/ci\.example\.test\/job\/\/api\/json\?tree=/, {
      builds: [],
    });

    const res = await createJenkinsSyncable(ENSURE).sync(ctx(), null);

    expect(res.itemsUpserted).toBe(0);
    expect(fetchStub.calls.map((c) => c.url.split("?")[0])).toEqual([
      `${BASE}/api/json`,
      `${BASE}/job//api/json`,
    ]);
  });
});
