import { describe, expect, test } from "bun:test";

import {
  BITBUCKET_APP_PASSWORD_DEPRECATION,
  type BitbucketCredentialKey,
  readBitbucketCredential,
} from "./bitbucket-credential.ts";

const reader =
  (m: Partial<Record<BitbucketCredentialKey, string | null>>) =>
  async (k: BitbucketCredentialKey): Promise<string | null> =>
    m[k] ?? null;

describe("readBitbucketCredential", () => {
  test("the API token pair wins over the old pair", async () => {
    const c = await readBitbucketCredential(
      reader({ email: "a@b.c", api_token: "tok", username: "old", app_password: "pw" }),
    );
    expect(c).toEqual({ kind: "token", user: "a@b.c", secret: "tok" });
  });

  test("the old pair alone is an app_password credential", async () => {
    const c = await readBitbucketCredential(reader({ username: "old", app_password: "pw" }));
    expect(c).toEqual({ kind: "app_password", user: "old", secret: "pw" });
  });

  test("blank or half-stored values are none", async () => {
    expect(await readBitbucketCredential(reader({ email: "a@b.c", api_token: "  " }))).toEqual({
      kind: "none",
    });
    expect(await readBitbucketCredential(reader({ api_token: "tok" }))).toEqual({ kind: "none" });
    expect(await readBitbucketCredential(reader({ username: "", app_password: "pw" }))).toEqual({
      kind: "none",
    });
    expect(await readBitbucketCredential(reader({}))).toEqual({ kind: "none" });
  });

  test("a half-stored new pair falls back to a complete old pair", async () => {
    const c = await readBitbucketCredential(
      reader({ email: "a@b.c", username: "old", app_password: "pw" }),
    );
    expect(c.kind).toBe("app_password");
  });

  test("whitespace is trimmed", async () => {
    const c = await readBitbucketCredential(reader({ email: " a@b.c ", api_token: "\ttok\n" }));
    expect(c).toEqual({ kind: "token", user: "a@b.c", secret: "tok" });
  });

  test("the deprecation line names the removal date", () => {
    expect(BITBUCKET_APP_PASSWORD_DEPRECATION).toContain("2026-07-28");
  });
});
