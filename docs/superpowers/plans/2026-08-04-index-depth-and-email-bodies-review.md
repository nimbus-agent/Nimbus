# Review & Suggestions: Enforced Index Depth + Gmail/Outlook Full Bodies Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-08-04-index-depth-and-email-bodies.md](./2026-08-04-index-depth-and-email-bodies.md).

---

## 1. Wrapped / Multi-line Email Attributions in Quoted-Tail Trimmer

### Issue

In Task 3, `ATTRIBUTION_RE` is defined as:

```ts
const ATTRIBUTION_RE =
  /^\s*(on\s+.+\bwrote:\s*$|am\s+.+\bschrieb\s+.+:\s*$|le\s+.+\ba\s+écrit\s*:\s*$)/i;

```

Because the body is split line-by-line using `const lines = body.split(/\r?\n/)`, the trimmer tests `ATTRIBUTION_RE` against each single line.

However, email clients (such as mobile apps or desktop clients with narrow viewport settings) often wrap the attribution line to the next line:

```text
On Mon, Aug 3, 2026 at 4:32 PM User
<user@example.com> wrote:

```

In this scenario:

1. The first line (`On Mon, Aug 3, 2026 at 4:32 PM User`) does not end with `wrote:`, so it fails the regex.
2. The second line (`<user@example.com> wrote:`) does not start with `on`, so it also fails.

As a result, wrapped attribution headers will not be detected as quotation boundaries.

### Recommendation

Provide a mechanism or heuristic in the trimmer to handle multi-line attributions, or relax the regex boundary to match just the prefix `on` or `am` (each followed by a space) if it is immediately followed by a quotation block, or at least document this known limitation. For example:

- Check if the current line starts with `on` followed by a space and a subsequent adjacent line ends with `wrote:`.

### Resolution

Implemented. `stripQuotedTail` in [`packages/gateway/src/string/email-quoted-text.ts`](../../../packages/gateway/src/string/email-quoted-text.ts) calls a normalisation pre-pass, `joinWrappedAttributions(original)`, before any marker matching — it joins an opener line to a following line that closes it (bounded to two continuation lines), so a wrapped `On ... User` / `<user@example.com> wrote:` pair is analysed as one attribution line.

---

## 2. Gmail MIME Walker: Sequential `text/plain` Parts

### Issue

In Task 4, the MIME walker (`walk` function in `message-body.ts`) terminates its text accumulation for a mime type once it finds the first match:

```ts
if (mime.startsWith("text/plain") && out.plain === "") {
  out.plain = decodeBase64Url(data);
}

```

If an email is structured with sequential `text/plain` parts (for example, a message interspersed with inline non-text parts where the parts are ordered sequentially in a `multipart/mixed` or `multipart/related` container, rather than as alternatives in a `multipart/alternative`), only the very first text part will be extracted. The remaining text parts will be discarded.

### Recommendation

Instead of overwriting `out.plain` only if it is empty, accumulate/concatenate all sequential `text/plain` parts when walking a non-alternative multipart container (like `multipart/mixed` or `multipart/related`). If the container is `multipart/alternative`, we should still select only one (the preferred alternative).

Alternatively, document this behavior as an accepted limitation for standard message body extraction, as the vast majority of emails encapsulate the main body within a single text part under a `multipart/alternative` structure.

### Resolution

Implemented, and there is no `walk` function or `out.plain === ""` overwrite guard in the shipped code. `collect()` in [`packages/gateway/src/connectors/_lib/gmail/message-body.ts`](../../../packages/gateway/src/connectors/_lib/gmail/message-body.ts) concatenates sequential text parts in order for `multipart/mixed` / `multipart/related` containers, and for `multipart/alternative` picks one representation by type (first `text/plain` child in document order, else first `text/html` child) rather than by position. Pinned by `message-body.test.ts`.

---

## 3. Outlook Delta Link Migration: Transition Grace Period or Automatic Reset

### Issue

Task 6 Step 4 includes adding a note to the CHANGELOG explaining that existing Outlook installs must run `nimbus index rebody --service outlook` to receive full bodies due to stored delta links omitting `$select`.

Relying on users reading the CHANGELOG and manually running a command on their CLI is highly error-prone. Most users will upgrade the Gateway and simply notice that their Outlook connector is not syncing full bodies for new emails.

### Recommendation

Consider implementing an automatic transition/reset check in the Outlook sync code.

- If a stored cursor exists, but we detect that we are running the V49 version and the database shows the sync state cursor was created prior to V49 (or we can store a migration flag/metadata), we can force-clear the delta cursor once to trigger a clean full-body sync.
- If clearing the cursor causes too much rate-limiting or quota cost for large mailboxes, then the manual `rebody` requirement is the only safe option, but the design should justify this trade-off explicitly.

### Resolution

Implemented — this recommendation's first bullet is exactly what shipped. `outlook-sync.ts` bumps the cursor-prefix constant `CURSOR_PREFIX` from `"nimbus-outl1:"` to `"nimbus-outl2:"`; `decodeMicrosoftGraphDeltaCursor` returns `undefined` on a prefix mismatch, so every stored pre-upgrade delta link fails to decode and the sync falls through to the initial request URL (where `$select` lives), forcing exactly one fresh full delta with `body` on every page on the next scheduled sync. No stored migration flag/metadata is needed — the prefix mismatch itself is the one-time detector. No user action is required; the accepted cost is that one full delta re-walk, called out in the design doc's Risks table rather than as a CHANGELOG instruction.
