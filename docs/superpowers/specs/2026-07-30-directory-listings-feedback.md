# Review Feedback: Directory Listings Design

Feedback, open questions, and suggestions for the [directory-listings design](./2026-07-30-directory-listings-design.md) specification.

---

## 1. Open Questions

### Q1.1: GitHub Repository Readiness Check

Before submitting to high-profile lists (especially the official `modelcontextprotocol/docs` clients list), reviewers often check the target repository's homepage, README, and files.

* **Do we explicitly mention MCP client support prominently in our primary README?**
* **Suggestion:** Ensure the README contains a clear, search-friendly section or badge declaring MCP Client capability (specifically listing the verified support level for Tools) before any pull requests are submitted.

### Q1.2: Framework vs. Client Classification

Several MCP lists (e.g., `wong2/awesome-mcp-servers`) separate entries into **Clients** (end-user applications) and **Frameworks/SDKs** (developer libraries/orchestrators).

* Nimbus acts as both: a client/application for on-call engineers, and an agent gateway orchestrating MCP servers.
* **Suggestion:** We should define in which section we submit to each directory, or if we should double-list under both sections when appropriate.

---

## 2. Improvements & Suggestions

### Suggestion 2.1: Enhance the Submission Block with "Alternatives"

For directories like **AlternativeTo** (Tier 4), entries are discoverable primarily based on what popular software they can replace or complement.

* **Add an "Alternatives" field to the Reusable Submission Block:**

  ```text
  Alternatives to: Aider, Cursor (for SRE/infrastructure automation), OpenHands, Devin
  ```

### Suggestion 2.2: Add Awesome-List Linting Checks

Awesome lists are notorious for having strict, automated CI pipelines (like `awesome-lint`) that check:

* Alphabetical sorting.
* Trailing slashes on URLs.
* Exact spacing and punctuation.

Actionable step: instruct the executor of these tasks to always run `awesome-lint` or carefully inspect the list's contribution guidelines to prevent PR rejects/delays due to formatting issues.

### Suggestion 2.3: Expand the Tracking Table Columns

To make the tracking section actionable for multiple contributors, update the table format to capture metadata:

```markdown
| Target | Status | PR / Issue / Submission Link | Assigned Owner | Date Completed |
| --- | --- | --- | --- | --- |
```

### Suggestion 2.4: Additional Directory Targets

Consider adding the following targets to Tier 1 / Tier 2:

* **MCP Directory (mcpdirectory.com):** A community directory indexing both clients and servers.
* **Smithery (smithery.ai):** Although predominantly server-focused, they are starting to index integration clients and platforms.
