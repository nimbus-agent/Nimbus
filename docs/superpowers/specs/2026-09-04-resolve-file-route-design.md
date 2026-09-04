# Resolving a Forge File Coordinate to a Path in the Reader's Checkout

**Date:** 2026-09-04
**Status:** designed, not implemented
**Slot:** Track 2 → Client surfaces, the browser row (`nimbus-web-clipper`)
**Roadmap:** [`docs/roadmap.md` § Track 2 → Client surfaces](../../roadmap.md#client-surfaces)
**Delivers as:** one PR — the route is additive and deprecates nothing
**Consumers:** the browser client, which has **already shipped** the caller
(`nimbus-web-clipper` → `docs/superpowers/specs/2026-09-04-the-file-you-are-looking-at-design.md` §3).
That document proposed this wire; this one owns and implements it.

---

## 1. Problem

`nimbus-web-clipper` shipped Phase C7.1: a GitHub, GitLab or Bitbucket **file** page
(`.../blob/<ref>/<path>`, and Bitbucket's `/src/` equivalent) is a recognised surface, and it offers
three agent lanes about the file — *what breaks if this changes*, *who knows this file*, *who owns
this*.

Those lanes are gated on a probe the client makes once per page:

```text
GET /v1/items/resolve-file?service=&repo=&refAndPath=
```

**No gateway serves that route.** It is absent from `main` and from every release, and no commit in
this repository has ever mentioned it. The client treats a 404 as "gateway too old", withholds the
lanes and says nothing — so the feature is not broken, it is silently inert on every gateway that
exists. C7.1's own roadmap
entry records this honestly: client-complete, gateway-blocked.

The gap is narrow. Everything the route needs is already here:

| Piece | Where | Since |
| --- | --- | --- |
| The resolution itself | `packages/gateway/src/index/resolve-file-by-remote.ts` | on `main` |
| The agents' forge file arm (`{ service, repo, refAndPath }`) | `packages/gateway/src/ipc/agents-rpc.ts`, `requireFileParam` | v7.6.0 (Nimbus#1424) |
| The `resolve` scope | `packages/gateway/src/clips/api-scopes.ts` | shipped |
| A bearer-read precedent to copy | `handleItemsResolve`, `packages/gateway/src/ipc/http-server.ts` | shipped |
| A real-server test harness for this route family | `packages/gateway/src/ipc/http-api-test-server.ts` | shipped |

What is missing is an HTTP read in front of `resolveFileByRemote`. That is this document.

### 1.1 Why the browser cannot do this itself

`resolveFileByRemote`'s own header states the bind: the graph keys files by the **local** path they
live at (`source_file` external ids are `file:<repoRoot>:<path>`), and `agents/ownership.ts` refuses
a path "outside every configured root". A browser knows `github.com/acme/web/blob/main/src/foo.ts`
and nothing about the reader's filesystem.

It cannot even split that URL. A branch name may contain slashes, so `feat/auth-v2/src/foo.ts` is
ambiguous without the repository's branch list — which a browser could only learn by calling the
forge, an outbound request the client exists to avoid. This side holds the file list, so it simply
tries the splits. The coordinate crosses the wire **unsplit**, deliberately.

---

## 2. The contract is already pinned

This is not a wire being designed. It is a wire being **met**: the client shipped its parser first,
so the shape is fixed by code already in users' browsers.

From `nimbus-web-clipper` → `src/background/gateway-client.ts` (`resolveFile`, `parseFileResolution`):

| Response | Client behaviour |
| --- | --- |
| `200 { ok: true, path: string }` | the file resolved; the three lanes are offered |
| `200 { ok: false, reason: "remote_not_tracked", repo: string }` | one sentence: no local checkout of this repo |
| `200 { ok: false, reason: "file_not_indexed", repo: string }` | one sentence: repo known, file not in it |
| `404` | **"gateway too old"** — lanes withheld, nothing said, no banner |
| `401` | unauthorized |
| `403 { error, required, granted }` | scope gap; the panel names `nimbus clip scopes` |
| anything else | `server_error` |

Three consequences bind the implementation:

1. **`path` is the only field read on a hit.** Extra keys are tolerated by the parser but must not
   be sent — see §4.2.
2. **`reason` is a closed set of two, and `repo` is required on a miss.** A miss missing `repo`, or
   carrying a third reason, fails the parser and degrades to `server_error`. The two reasons are
   different facts with different remediations and must never be collapsed.
3. **404 must keep meaning "this gateway does not serve the route."** The existing
   `clipsVault === undefined` → `404 { error: "resolve_disabled" }` shape satisfies this exactly:
   a gateway with the clips surface unmounted genuinely cannot answer, and fail-quiet is the right
   client behaviour there.

---

## 3. Why the route is the capability signal, and there is no version floor

The obvious move, following C6.1's precedent, is a `FILE_ARM_FLOOR = "7.6.0"` mirroring
`ITEM_ARM_FLOOR`. **There is deliberately none.**

`ITEM_ARM_FLOOR` exists because `GET /v1/agents` lists agent *names*, not their *arms*, so a roster
cannot say whether `why` accepts an item URL. That reasoning does not transfer. This route ships in
a release strictly after 7.6.0, so **its presence proves the forge arm exists**, and the client has
to call it anyway. A direct capability probe beats a version string and cannot drift the way a floor
constant needs raising.

The client has already implemented it this way. Adding a floor here would be a second, weaker gate
in front of a stronger one.

---

## 4. The route

Two files in `packages/gateway/src/ipc/`, four changes between them.

### 4.1 Auth table

In `http-route-auth.ts`:

```ts
export const ROUTE_KEY_ITEMS_RESOLVE_FILE = "GET /v1/items/resolve-file";
```

with its row beside its neighbour in `HTTP_ROUTE_AUTH`:

```ts
[ROUTE_KEY_ITEMS_RESOLVE_FILE]: { kind: "clip", scope: "resolve" },
```

and the constant added to the `ClipReadRouteKey` union. That last edit is not optional bookkeeping:
without it `requireScopedClipToken` refuses the key at compile time, which is precisely the
fail-open guard that union was introduced for.

**`resolve`, not `agents`.** The route resolves; it runs nothing. A browser paired without the
`agents` scope then gets an honest hit or miss rather than a 403 from a route that only reads, and
it sits under the same gate as `GET /v1/items/resolve` next door.

The `HTTP_ROUTE_AUTH` completeness test is **source-scanning** (`http-route-auth.test.ts` reads the
route literals out of `http-server.ts`), so a new literal with no auth decision fails the suite on
its own. No hand-maintained second list needs updating.

### 4.2 The handler

`handleItemsResolveFile` goes directly below `handleItemsResolve` in `http-server.ts`, with the same
four-step shape: surface gate, auth gate, parameters, answer.

```ts
async function handleItemsResolveFile(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined) {
    // Same "surface not mounted" shape as handleItemsResolve, and the client reads this
    // exact 404 as "gateway older than this route" — see §2, consequence 3.
    return json({ error: "resolve_disabled" }, 404);
  }
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_ITEMS_RESOLVE_FILE);
  if (!auth.ok) return auth.response;

  const service = coordinate(url, "service");
  const repo = coordinate(url, "repo");
  const refAndPath = coordinate(url, "refAndPath");
  if (service === null || repo === null || refAndPath === null) {
    return json({ error: "missing_coordinate" }, 400);
  }

  const result = resolveFileByRemote(db, { service, repo, refAndPath });
  return json(
    result.ok
      // Field by field, naming `path` alone. NOT a spread and NOT a destructured rest:
      // `ResolveFileResult` also carries `repoRoot` — the reader's local filesystem path —
      // and `fileEntityId`, and this route is reachable by any holder of a clip token over
      // HTTP. A field added to that type later cannot leak here unnamed.
      ? { ok: true, path: result.path }
      : { ok: false, reason: result.reason, repo: result.repo },
  );
}
```

`coordinate` is a two-line local returning `null` for absent-or-blank, mirroring the
`raw === null || raw.trim() === ""` test `handleItemsResolve` already applies to `?url=`.

### 4.3 Validate all three coordinates, or 400

**A blank coordinate must not reach `resolveFileByRemote`.** With an empty `service`, that function
builds `wantedRepo = ":acme/web"`, matches no workspace row, and returns
`{ ok: false, reason: "remote_not_tracked" }` — telling the caller "you have no local checkout of
this repository" in answer to a request that never named one. A confident wrong answer is worse than
a refusal, and this one would send the panel's most permanent-sounding miss sentence.

The 400 is unreachable from the shipped client, which always sends all three. It exists for the next
consumer.

### 4.4 Routing

One line in `tryBearerAuthedGet`, beside the existing resolve line:

```ts
if (url.pathname === "/v1/items/resolve-file") return await handleItemsResolveFile(req, url, db, opts);
```

Placement matters and the surrounding doc comment already says why: these bearer reads **must** be
matched before the unauthenticated GET table in `handleGet`, whose `/v1/items/*` entry is public
with no bearer gate at all. A `resolve-file` that fell through to it would serve the reader's
indexed-file set to any local process on the machine.

---

## 5. What the route deliberately does not do

**It never returns `repoRoot`.** `ResolveFileResult` carries it; this route drops it. It is the
reader's local filesystem path, and the route is reachable by any holder of a clip token. `path` is
repo-relative — safe, and the genuinely useful half, since it is exactly the ref/path split the
browser could not perform. A local root is a disclosure with no client use.

**It never returns `fileEntityId`.** Same reasoning, weaker stakes: the lanes send
`{ service, repo, refAndPath }` to the forge arm, not an entity id, so it would be an unused field
widening the response for nothing.

**It appends no egress row**, matching `GET /v1/items/resolve`. Nothing leaves the machine: it reads
the local graph and answers. A row here would inflate the very ledger that exists to report what
actually went out.

**It deprecates nothing.** `agents-rpc.ts` keeps its `-32602` for the terminal surface and for any
client that skips the probe. This route is purely additive.

**It adds no version floor** — §3.

**It does not enter `HTTP_ROUTES` or `openapi/v1.yaml`.** Verified, not assumed: `http-routes.ts` is
documented as "the routes the OpenAPI schema is checked against — NOT every route the server
serves", and it contains none of the clip-scoped bearer reads (`/v1/items/resolve`, the four
`/v1/egress` reads, `/v1/agents`, the brief routes). `resolve-file` follows that established line.

---

## 6. Tests

`startServerWithClipToken` (`ipc/http-api-test-server.ts`) exists for exactly this family — a real
`startReadOnlyHttpServer` on port 0, a real temp-dir SQLite DB migrated to latest, and an in-memory
vault holding one token with the caller's chosen scopes. Seed
`workspace --tracks_remote--> repo` relations plus `source_file` entities, then assert:

1. **Hit** — `{ ok: true, path: "src/foo.ts" }`, and the body has **no `repoRoot` and no
   `fileEntityId` key**. Asserted as key absence, not by comparing `path`: this is the disclosure
   guard, and it has to fail if someone later widens the projection.
2. **`remote_not_tracked`** — a repo with no tracking workspace, carrying `repo`.
3. **`file_not_indexed`** — a tracked repo, a path that is not in it, carrying `repo`. Distinct from
   the previous case and asserted separately; collapsing the two is the one thing the client's two
   miss sentences cannot survive.
4. **A ref containing slashes** — `feat/auth-v2/src/foo.ts` resolves to `src/foo.ts`, proving the
   unsplit coordinate is the point of the route rather than an accident of its signature.
5. **403** — a token with `clip` but not `resolve`, body `{ error, required, granted }`.
6. **401** — an unknown token.
7. **400** — each of the three coordinates blank in turn.
8. **404** — `clipsVault: undefined`. Worth naming explicitly: this is the branch the shipped
   browser client reads as "gateway too old", and a future refactor that turned it into a 500 would
   turn a silent, correct degradation into a visible error on every unmounted gateway.

---

## 7. Prose that moves with the code

`egress/egress-coverage.ts`'s `http` narrowing names `GET /v1/items/resolve` **by name**, as "the
newest of them and the one most likely to be mistaken for egress: it takes a URL from an external
caller and answers from the LOCAL index without any outbound request." After this PR that sentence
is wrong about which read is newest, and `resolve-file` is the better example of the same point —
it takes a *forge coordinate* from an external caller and answers from the local graph. That comment
is the machine-readable claim's own justification and has to stay true.

Also: `docs/CHANGELOG.md`, and the HTTP surface description in `docs/architecture.md`.

---

## 8. The other half, in the client repo

`nimbus-web-clipper` needs no code change for this route — that is the point of C7.1 shipping the
caller first. It needs three things, on its own branch, not blocked by this one:

- **An e2e spec.** `scripts/screenshots/mock-gateway.ts` **already serves** `resolve-file` with a hit
  fixture and both miss fixtures, and `test/e2e/` has never exercised the file surface. A
  `file-lanes.e2e.ts` registers the mock's loopback origin as a **self-hosted GitHub** (`github.ts`
  is `selfHostable: true`, so the host is user-declared and `gotoRecognisedPage` can push a
  `/acme/web/blob/main/src/foo.ts` path onto it) and asserts the file header, the three lanes on a
  hit, and the two distinct miss sentences.
- **`docs/development.md`.** Its C7 manual step currently reads "only one side can be run today" and
  says the positive half must wait. Both sides run once this ships. Its new `COVERS` ids must pair
  with `<!-- e2e:<id> -->` markers or `e2e-coverage.test.ts` fails.
- **`ROADMAP.md`** — C7.1 flips 🟡 → 🟢, gated on the gateway release actually shipping, with no
  client change and no re-pairing.

A browser paired before scopes existed holds `LEGACY_SCOPES = ["clip", "briefs"]` and will get a 403
here. That is the documented, already-handled path: the owner runs `nimbus clip scopes` to add
`resolve` in place. No re-pairing, and no change needed on either side.

---

## 9. Risks

**Cognitive complexity.** `tryBearerAuthedGet` was split out of the `fetch` handler because Sonar
scored it S3776 = 17. One more `if` adds one branch. Watch the gate; do not pre-emptively
restructure a function that was only just restructured.

**The temptation to generalise the gate.** `handleItemsResolve`, this handler and `requireEgressRead`
all repeat *surface gate → `requireScopedClipToken`*. Extracting a shared helper is explicitly **out
of scope**: the 404 bodies differ (`resolve_disabled` vs `egress_disabled`), so the helper would need
a parameter for its only interesting line, and it would drag three shipped routes into a diff that
should be purely additive.

---

## 10. Non-goals

- Any change to `agents-rpc.ts`, its `requireFileParam`, or the `-32602` it returns.
- A `POST` variant, or a `?url=` variant that parses the whole forge URL gateway-side. The client
  ships the coordinate triple today; `?url=` would be a second way to say the same thing and would
  break "no client change".
- Federation-only lanes. `ghost` and `conflicts` answer nothing on a forge coordinate on every
  gateway, forever — a permanent exclusion, not a deferral. See the client spec's §4.7.
- Exposing `repoRoot` under any flag, scope or query parameter.
