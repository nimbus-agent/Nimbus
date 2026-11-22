import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I13 — HTTP write routes go through allowlist + bearer auth", () => {
  test("http-server.ts imports dispatchWriteRoute from ./http-write-routes.ts", async () => {
    const src = await read("packages/gateway/src/ipc/http-server.ts");
    // The named-import block may span multiple lines and carry sibling imports
    // (e.g. `type PolicyAuthorResult`, `WRITE_ROUTE_ALLOWLIST`); assert the
    // braced block both contains `dispatchWriteRoute` and resolves to the
    // `./http-write-routes.ts` module.
    expect(src).toMatch(
      /import\s*\{[\s\S]*?\bdispatchWriteRoute\b[\s\S]*?\}\s*from\s*['"]\.\/http-write-routes\.ts['"]/,
    );
  });

  test("http-server.ts opens at most one writable Database handle (and only inside the server-context wiring)", async () => {
    const src = await read("packages/gateway/src/ipc/http-server.ts");
    const readonlyOpens = (src.match(/new Database\([^)]*readonly:\s*true/g) ?? []).length;
    const allOpens = (src.match(/new Database\(/g) ?? []).length;
    const writableOpens = allOpens - readonlyOpens;
    expect(writableOpens).toBeLessThanOrEqual(1);
  });

  test("WRITE_ROUTE_ALLOWLIST is exactly the deployment + SCIM provisioning + admin-policy + teams-events + clip + brief + agent + items-fetch routes", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("../ipc/http-write-routes.ts");
    // The count IS the integrity check (see nimbus-http-write-surface). Adding a write route
    // requires bumping this assertion in the same commit. 1 deploy route + 3 SCIM routes +
    // 1 admin-console anchor-policy route (PUT /v1/admin/policy, Task 18b) +
    // 1 ChatOps Teams inbound route (POST /v1/messaging/teams/events, Slice 5 — Bot Framework JWT) +
    // 2 web-clipper routes (POST /v1/clips + POST /v1/clips/pair/confirm, I30) +
    // 4 research-brief routes (POST /v1/briefs + .../sources + .../run + .../save) +
    // 1 agent-invocation route (POST /v1/agents/{agent}, agents-scoped) +
    // 1 targeted-fetch route (POST /v1/items/fetch, fetch-scoped).
    //
    // The agent route is a WRITE by CLASSIFICATION, not because it mutates the index — it does not.
    // Listing it here is what subjects it to the bearer gate, the per-route body cap and the
    // per-token rate limiter; reclassifying it as a read to slip past this allowlist would be the
    // exact evasion the allowlist exists to prevent. The items-fetch route IS a write for the
    // ordinary reason too — it causes an outbound provider request and an index write — so it is
    // never modeled as a read that happens to have side effects.
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(14);
    expect([...WRITE_ROUTE_ALLOWLIST]).toEqual([
      "POST /v1/deployments",
      "POST /scim/v2/Users",
      "PATCH /scim/v2/Users/{id}",
      "DELETE /scim/v2/Users/{id}",
      "PUT /v1/admin/policy",
      "POST /v1/messaging/teams/events",
      "POST /v1/clips",
      "POST /v1/clips/pair/confirm",
      "POST /v1/briefs",
      "POST /v1/briefs/{id}/sources",
      "POST /v1/briefs/{id}/run",
      "POST /v1/briefs/{id}/save",
      "POST /v1/agents/{agent}",
      "POST /v1/items/fetch",
    ]);
  });
});
