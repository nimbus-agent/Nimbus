# Implementation Plan Review Response: Credential Health

Response to [`2026-07-28-credential-health-review.md`](./2026-07-28-credential-health-review.md).

**Four points accepted as suggested, one accepted in substance but rejected as
written.** Two accepted points gained more than was asked for, because the
suggested fix left a false-green path open. Nothing deferred.

---

## 1.1 — `parse_error` classification · **FIXED, and widened**

**Correct, and the plan had a genuine hole**: Task 8 mapped `ok` and
`http_error` but never said what happens to `parse_error`, so it would have
fallen through to whatever the implementer guessed.

The suggestion — map it to `{ kind: "ok" }` because HTTP 2xx means the
credential authenticated — is right for the dominant case. **But taken
literally it opens a false green.** A well-known anti-pattern is answering an
expired session with **200 plus an HTML login page** instead of 401. Under an
unconditional `parse_error → ok`, a dead credential would report healthy — the
exact defect class this whole feature exists to catch, and the same shape as the
400-reads-`ok` bug the *design* review caught.

Applied instead:

1. `parse_error` now carries `body` (Task 2), like `http_error` does.
2. It maps to `{ kind: "http", status: 200, body }`.
3. `classifyAuthOutcome` checks auth-rejection markers **before** the 2xx
   short-circuit, so a benign unparseable body stays `ok` while a login page is
   caught.

Two tests added to Task 4's table:

```ts
["200 with a login page", http(200, "<html><title>Sign in</title>Unauthorized</html>"), "auth-failure"],
["200 with unparseable but benign body", http(200, "not json at all"), "ok"],
```

Net effect: the suggested behaviour for the common case, without the hole.

## 1.2 — XML / SOAP error bodies · **FIXED**

Accepted as written, and it matters more than it first appears: the connectors
most likely to sit behind enterprise middleware are exactly the self-hosted ones
(Jenkins, on-prem Jira/GitLab, ArgoCD), and those are also the ones with no
OAuth path, so they are over-represented among the opaque credentials this
feature is built for.

`looksLikeHtml` → `looksLikeMarkup`, now matching `<?xml`, namespaced roots
(`<soap:Envelope`, `<ns:Error`), and `<error` / `<response`. Extraction gained a
SOAP/XML fault-string pass between the `<title>` check and the strip-everything
fallback, so a `<faultstring>Invalid credentials supplied</faultstring>` yields
the message rather than a tag salad. Fallback text changed from
`"HTML error page"` to `"markup error page"`.

Two tests added — a full SOAP envelope, and an XML body asserting no raw tags
survive.

## 2.1 — `suffixOf` splitting · **ACCEPTED IN SUBSTANCE, REJECTED AS WRITTEN**

The review hedged this correctly: *"If all vault keys follow a strict
`<connector_id>.<key_name>` pattern (exactly one dot), this is fine."*

Verified rather than assumed — **all 174 keys in the manifest have exactly one
dot; there are no multi-dot keys.** So the premise holds and `indexOf` is safe
today.

More importantly, switching to `lastIndexOf` would be **wrong**, not merely
unnecessary. Keys are `<connector_id>.<name>`. If a name ever contained a dot —
`a.b.c` meaning connector `a`, name `b.c` — then:

- `indexOf` yields `b.c` — the whole name, correct
- `lastIndexOf` yields `c` — a *fragment* of the name, silently mis-classified

So the suggested change would introduce the bug it was guarding against, for
precisely the case that motivated it.

The real risk is not the split, it is that the one-dot invariant is undocumented
and unenforced. Applied instead: `suffixOf` gained a comment explaining why the
first dot is correct and warning against `lastIndexOf`, plus a **guard test**
asserting every manifest key is exactly `<connector>.<name>`. A future multi-dot
key now fails loudly and forces a deliberate decision.

## 2.2 — Cursor atomicity comment · **FIXED**

Accepted exactly as suggested. The review's own analysis is right — the code is
already safe because read-and-increment completes synchronously before the first
`await` — and the value is entirely in stopping a future refactor from moving
the increment after an await, which would produce duplicate probes visible only
under concurrency. Comment added saying precisely that.

## 2.3 — Concurrency test · **FIXED, using the supplied snippet**

Accepted, and the review was right to flag it: "add a test asserting no more
than N in flight" without showing how is a placeholder by the plan skill's own
standard, and I should not have left it.

The supplied counter snippet is used verbatim as the basis. Two additions:

- `expect(maxActive).toBeGreaterThan(1)` — without it the test still passes if
  the worker pool collapses to serial execution, a performance regression the
  cap alone cannot detect.
- A second test asserting **every connector is probed exactly once** — none
  skipped, none doubled. That is the actual behavioural guarantee the atomic
  claim in 2.2 provides, and it deserves a test rather than only a comment.

---

## Summary

| Point | Verdict | Note |
| --- | --- | --- |
| 1.1 `parse_error` | **Fixed, widened** | Straight `→ ok` would have let a 200+login-page read healthy |
| 1.2 XML / SOAP | **Fixed** | + SOAP faultstring extraction |
| 2.1 `suffixOf` | **Substance accepted, code change rejected** | `lastIndexOf` would introduce the bug it guards against; guard test added instead |
| 2.2 Atomicity comment | **Fixed** | As suggested |
| 2.3 Concurrency test | **Fixed** | Snippet used + serial-collapse and exactly-once assertions |

The through-line matches the design review: three of five changes close paths
where the system could have reported health it had not observed. The plan's
centre of gravity is now firmly on refusing to assert what it has not seen.
