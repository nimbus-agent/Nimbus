# Review & Feedback: Enforced index depth + Gmail/Outlook full bodies Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of enforced index depth and email body sync specified in [2026-08-04-index-depth-and-email-bodies-design.md](./2026-08-04-index-depth-and-email-bodies-design.md).

---

## 1. Quoted-Tail Trimmer: False Positives in Developer Workspaces (Fenced Code Blocks & Blockquotes)

### Issue

The design specifies cutting at:
- A run of lines beginning `>` (any nesting depth).

In a developer-focused local AI framework like Nimbus, users frequently exchange email messages discussing code, design specs, or error logs containing:
1. Markdown blockquotes (which start with `>`).
2. Email threads where a code block or config is quoted using `>`.
3. Standard markdown documentation snippets shared in communication.

If the trimmer unconditionally cuts the email body at the first line starting with `>`, any message containing a markdown blockquote followed by additional user reply text will have its reply truncated. Furthermore, if a user starts their email by quoting a design spec line using `>`, the *entire* email body content after that first line will be lost.

### Recommendation

Refine the `>` matching logic:
- Only treat `>` as a quotation marker if it is accompanied by other common threaded-email headers (e.g. `On <date>... wrote:` preceding it), OR
- Avoid trimming `>` lines if they appear inside or adjacent to markdown structures (like backticks/code blocks), OR
- Only trim `>` lines if they appear in a block at the absolute end of the message (trailing quotes), rather than the first occurrence.
- Consider making the `>` line trimmer conservative, or document the limitation clearly in the code to allow for a future parser that differentiates blockquotes from reply threads.

---

## 2. Outlook Delta Link Migration and Transition

### Issue

The design notes that `$select` on a delta query must be set on the **initial** request, and that the Microsoft Graph API carries it forward in the `@odata.nextLink` and `@odata.deltaLink`.

However, active Nimbus installations already have stored `@odata.deltaLink` tokens in their sync states from prior sync cycles. These existing tokens were generated *without* the `$select` parameter including the `body` field. 
When the system upgrades to this new version:
1. The next scheduled sync will load the existing delta token from the database.
2. The connector will fetch updates using this token.
3. Microsoft Graph will respond *without* the message body because the original delta token did not request it.
4. Any emails updated or received immediately after the upgrade will still be synced with metadata-only / snippet-only content, delaying full-body indexing until the token is naturally reset or a reindex is forced.

### Recommendation

Provide a transition path for existing delta links:
- Detect if the current sync state transition is occurring (e.g., if we are upgrading and we have a stored delta link but want full body).
- If the sync state contains an active delta link but we are transitioning to full-body sync for the first time, we should consider clearing/discarding the stored delta link to force a fresh delta query with the proper `$select` parameters, OR
- Clearly document that a one-time `nimbus connector reindex outlook` is recommended/necessary to fetch full bodies for recent emails after upgrading.

---

## 3. Depth Coercion Details for `metadata_only`

### Issue

The table under *Depth semantics* states:
- `metadata_only` -> "drop the body input entirely; no body; `body_complete = 0`"

It is not explicitly stated whether the `bodyPreview` field (the 512-character preview) is also dropped or preserved under `metadata_only`. If privacy is the driving factor for `metadata_only`, storing a 512-character snippet of the body still leaks message contents into the database, violating the user's intent.

### Recommendation

Explicitly clarify in the design and store tests that under `metadata_only` depth coercion:
- Both `body` and `bodyPreview` inputs are completely stripped/coerced to `null`/empty before being stored.

---

## 4. Outlook Header Parsing and Custom Delimiters

### Issue

In addition to `________________________________` and `-----Original Message-----`, Outlook inline replies frequently use localized or structured table headers for quoted emails:

```text
From: User Name <user@example.com>
Sent: Tuesday, August 4, 2026 6:00 AM
To: Another User <another@example.com>
Subject: Re: Spec Review
```

Sometimes these inline headers do not have a divider line preceding them.

### Recommendation

Add a check in `string/email-quoted-text.ts` to identify typical email header blocks (e.g., lines containing `From:`, `Sent:`, `To:`, `Subject:` in close proximity) as quotation boundaries.
