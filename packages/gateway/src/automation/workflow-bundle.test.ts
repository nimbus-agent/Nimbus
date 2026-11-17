// Signed workflow import (I59): the bundle format and its verification (plan task 1).
import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import {
  FIXTURE_NOW,
  FIXTURE_STEPS,
  fixtureBody,
  fixtureKey,
  pubB64,
  signFixture,
} from "../connectors/connector-writes/workflow-bundle.test-helpers.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import {
  assembleBundle,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_STEPS,
  BundleError,
  buildBundleBody,
  bundleSignedBytes,
  verifyBundle,
} from "./workflow-bundle.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";

function refusal(fn: () => unknown): BundleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BundleError);
    return e as BundleError;
  }
  throw new Error("expected a refusal");
}
const code = (fn: () => unknown): string => refusal(fn).code;
const verify = (text: string) => () => verifyBundle(text, FIXTURE_NOW);

describe("verifyBundle: the good path", () => {
  test("a signed bundle verifies and reports the signer, the hashes and the canonical text", () => {
    const v = verifyBundle(signFixture(fixtureBody()), FIXTURE_NOW);
    expect(v.body.name).toBe("weekly-cleanup");
    expect(v.canonicalSteps).toBe(canonicalJson(FIXTURE_STEPS));
    expect(v.body.stepsSha256).toBe(workflowStepsSha256(parseWorkflowSteps(v.canonicalSteps)));
    expect(v.signerFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(v.signerPubkeyB64).toBe(pubB64(fixtureKey()));
  });

  test("golden vector: the signed bytes are the tag then the canonical body", () => {
    const body = fixtureBody({ issuedAt: 1_763_251_200_000 });
    const text = new TextDecoder().decode(bundleSignedBytes(body));
    expect(text).toBe(`nimbus-workflow-bundle/v1\n${canonicalJson(body)}`);
    expect(text).toContain('"format":"nimbus-workflow-bundle/v1","issuedAt":1763251200000');
  });

  test("assembleBundle output round-trips through verify", () => {
    const body = fixtureBody();
    const kp = fixtureKey();
    const sig = Buffer.from(nacl.sign.detached(bundleSignedBytes(body), kp.secretKey)).toString(
      "base64",
    );
    const text = assembleBundle(body, sig, pubB64(kp));
    expect(verifyBundle(text, FIXTURE_NOW).body.name).toBe("weekly-cleanup");
  });
});

describe("verifyBundle: signature", () => {
  test("a flipped byte in the body is refused", () => {
    const file = JSON.parse(signFixture(fixtureBody()));
    file.body.name = "weekly-cleanuq";
    expect(code(verify(JSON.stringify(file)))).toBe("ERR_WORKFLOW_BUNDLE_SIGNATURE");
  });
  test("a flipped byte in the signature is refused", () => {
    const file = JSON.parse(signFixture(fixtureBody()));
    const raw = Buffer.from(file.sig.signature, "base64");
    raw[0] = (raw[0] ?? 0) ^ 1;
    file.sig.signature = raw.toString("base64");
    expect(code(verify(JSON.stringify(file)))).toBe("ERR_WORKFLOW_BUNDLE_SIGNATURE");
  });
  test("a wrong-length public key, a wrong-length signature and a wrong algorithm are refused", () => {
    const f = () => JSON.parse(signFixture(fixtureBody()));
    const a = f();
    a.sig.pubkey = Buffer.alloc(31).toString("base64");
    const b = f();
    b.sig.signature = Buffer.alloc(63).toString("base64");
    const c = f();
    c.sig.alg = "rsa";
    for (const bad of [a, b, c]) {
      expect(code(verify(JSON.stringify(bad)))).toBe("ERR_WORKFLOW_BUNDLE_SIGNATURE");
    }
  });
  test("a signature by another key does not verify under the claimed key", () => {
    const file = JSON.parse(signFixture(fixtureBody(), fixtureKey(1)));
    file.sig.pubkey = pubB64(fixtureKey(2));
    expect(code(verify(JSON.stringify(file)))).toBe("ERR_WORKFLOW_BUNDLE_SIGNATURE");
  });
  test("a body signed WITHOUT the domain tag (a share-style or digest signature) never verifies", () => {
    const body = fixtureBody();
    const kp = fixtureKey();
    const untagged = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(canonicalJson(body)), kp.secretKey),
    ).toString("base64");
    const file = { body, sig: { alg: "ed25519", pubkey: pubB64(kp), signature: untagged } };
    expect(code(verify(JSON.stringify(file)))).toBe("ERR_WORKFLOW_BUNDLE_SIGNATURE");
    file.sig.signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode("a".repeat(64)), kp.secretKey),
    ).toString("base64");
    expect(code(verify(JSON.stringify(file)))).toBe("ERR_WORKFLOW_BUNDLE_SIGNATURE");
  });
});

describe("verifyBundle: strict envelope", () => {
  test.each([
    ["schedule", "a schedule"],
    ["standingRule", "a standing rule"],
    ["rules", "a standing rule"],
    ["credentials", "a credential"],
    ["trigger", "a trigger"],
  ])("a body key %s is refused by name", (key, noun) => {
    const body = { ...fixtureBody(), [key]: "x" };
    const e = refusal(verify(signFixture(body)));
    expect(e.code).toBe("ERR_WORKFLOW_BUNDLE_FORBIDDEN_KEY");
    expect(e.message).toContain(noun);
    expect(e.message).toContain(key);
  });
  test("a forbidden key at the top level and in sig is refused too", () => {
    const top = signFixture(fixtureBody(), fixtureKey(), {}, { schedule: "* * * * *" });
    expect(code(verify(top))).toBe("ERR_WORKFLOW_BUNDLE_FORBIDDEN_KEY");
    const inSig = signFixture(fixtureBody(), fixtureKey(), { trigger: 1 });
    expect(code(verify(inSig))).toBe("ERR_WORKFLOW_BUNDLE_FORBIDDEN_KEY");
  });
  test("an unknown key is refused as malformed; not JSON and not an object are refused", () => {
    expect(code(verify(signFixture({ ...fixtureBody(), extra: 1 })))).toBe(
      "ERR_WORKFLOW_BUNDLE_MALFORMED",
    );
    expect(code(verify("{"))).toBe("ERR_WORKFLOW_BUNDLE_MALFORMED");
    expect(code(verify("[]"))).toBe("ERR_WORKFLOW_BUNDLE_MALFORMED");
    expect(code(verify('{"body":{}}'))).toBe("ERR_WORKFLOW_BUNDLE_MALFORMED");
  });
});

describe("verifyBundle: body fields", () => {
  test("another format is refused (signed)", () => {
    expect(code(verify(signFixture(fixtureBody({ format: "other/v1" }))))).toBe(
      "ERR_WORKFLOW_BUNDLE_FORMAT",
    );
  });
  test.each(["", "-x", "has space", "a/b", "x".repeat(65), "line\nbreak", "\u202eevil"])(
    "the name %j is refused",
    (name) => {
      expect(code(verify(signFixture(fixtureBody({ name }))))).toBe("ERR_WORKFLOW_BUNDLE_NAME");
    },
  );
  test("description and author caps, at and over", () => {
    expect(verify(signFixture(fixtureBody({ description: "d".repeat(500) })))()).toBeDefined();
    expect(code(verify(signFixture(fixtureBody({ description: "d".repeat(501) }))))).toBe(
      "ERR_WORKFLOW_BUNDLE_MALFORMED",
    );
    expect(verify(signFixture(fixtureBody({ author: "a".repeat(64) })))()).toBeDefined();
    expect(code(verify(signFixture(fixtureBody({ author: "a".repeat(65) }))))).toBe(
      "ERR_WORKFLOW_BUNDLE_MALFORMED",
    );
    expect(verify(signFixture(fixtureBody({ description: null, author: null })))()).toBeDefined();
  });
  test("issuedAt: at now + 24 h passes; one ms over, a fraction, a negative and a string are refused", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(verify(signFixture(fixtureBody({ issuedAt: FIXTURE_NOW + day })))()).toBeDefined();
    for (const issuedAt of [FIXTURE_NOW + day + 1, 1.5, -1, "1"]) {
      expect(code(verify(signFixture(fixtureBody({ issuedAt }))))).toBe(
        "ERR_WORKFLOW_BUNDLE_ISSUED_AT",
      );
    }
  });
});

describe("verifyBundle: steps", () => {
  test("a run step, a kindless step and a guarded run step are refused as model steps", () => {
    for (const row of [
      { kind: "run", run: "do it" },
      { run: "do it" },
      { kind: "run", run: "x", when: [{ count: "old-mail", op: "gt", value: 0 }] },
    ]) {
      const body = { ...fixtureBody(), steps: [...FIXTURE_STEPS, row] };
      expect(code(verify(signFixture(body)))).toBe("ERR_WORKFLOW_BUNDLE_MODEL_STEP");
    }
  });
  test("the fixpoint: a step the parser would change (a padded label) is refused as not canonical", () => {
    const steps = FIXTURE_STEPS.map((s) =>
      (s as { kind: string }).kind === "write" ? { ...(s as object), label: " archive " } : s,
    );
    const body = {
      ...fixtureBody(),
      steps,
      stepsSha256: workflowStepsSha256(parseWorkflowSteps(JSON.stringify(steps))),
    };
    const e = refusal(verify(signFixture(body)));
    expect(e.code).toBe("ERR_WORKFLOW_BUNDLE_STEPS");
    expect(e.message).toContain("not in canonical form");
  });
  test("a step with an unknown key is refused by the strict parser", () => {
    const steps = FIXTURE_STEPS.map((s) =>
      (s as { kind: string }).kind === "write" ? { ...(s as object), extra: 1 } : s,
    );
    expect(code(verify(signFixture({ ...fixtureBody(), steps })))).toBe(
      "ERR_WORKFLOW_BUNDLE_STEPS",
    );
  });
  test("stepsSha256 must match", () => {
    expect(code(verify(signFixture(fixtureBody({ stepsSha256: "0".repeat(64) }))))).toBe(
      "ERR_WORKFLOW_BUNDLE_STEPS",
    );
  });
  test("empty steps and more than 50 steps are refused; 50 steps pass", () => {
    expect(code(verify(signFixture({ ...fixtureBody(), steps: [] })))).toBe(
      "ERR_WORKFLOW_BUNDLE_STEPS",
    );
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "query",
        label: `q${String(i)}`,
        query: {
          service: "gmail",
          type: "email",
          where: [],
          select: "id",
          distinct: false,
          limit: 1,
        },
      }));
    const ok = mk(BUNDLE_MAX_STEPS);
    const okBody = {
      ...fixtureBody(),
      steps: ok,
      stepsSha256: workflowStepsSha256(parseWorkflowSteps(JSON.stringify(ok))),
    };
    expect(verifyBundle(signFixture(okBody), FIXTURE_NOW).steps).toHaveLength(BUNDLE_MAX_STEPS);
    expect(code(verify(signFixture({ ...fixtureBody(), steps: mk(BUNDLE_MAX_STEPS + 1) })))).toBe(
      "ERR_WORKFLOW_BUNDLE_STEPS",
    );
  });
  test("the file cap: over 256 KiB is refused before it is parsed", () => {
    expect(code(verify(" ".repeat(BUNDLE_MAX_FILE_BYTES + 1)))).toBe(
      "ERR_WORKFLOW_BUNDLE_TOO_LARGE",
    );
  });
});

describe("buildBundleBody (export)", () => {
  const base = {
    name: "weekly-cleanup",
    description: null,
    author: null,
    issuedAt: FIXTURE_NOW - 1,
  };
  test("refuses a stored workflow with a run step", () => {
    const stepsJson = JSON.stringify([{ run: "summarise" }]);
    expect(code(() => buildBundleBody({ ...base, stepsJson }, FIXTURE_NOW))).toBe(
      "ERR_WORKFLOW_BUNDLE_MODEL_STEP",
    );
  });
  test("refuses a constant that looks like a credential, naming the step", () => {
    const steps = [
      FIXTURE_STEPS[0],
      {
        kind: "write",
        label: "post",
        tool: "gmail_thread_archive",
        input: { threadId: { const: `ghp_${"a".repeat(36)}` } },
      },
    ];
    const e = refusal(() =>
      buildBundleBody({ ...base, stepsJson: JSON.stringify(steps) }, FIXTURE_NOW),
    );
    expect(e.code).toBe("ERR_WORKFLOW_BUNDLE_CREDENTIAL");
    expect(e.message).toContain("step 2");
    expect(e.message).toContain("post");
  });
  test("never echoes a step label that itself looks like a credential", () => {
    const token = `ghp_${"b".repeat(36)}`;
    const steps = [
      FIXTURE_STEPS[0],
      {
        kind: "write",
        label: token,
        tool: "gmail_thread_archive",
        input: { threadId: { const: "t1" } },
      },
    ];
    const e = refusal(() =>
      buildBundleBody({ ...base, stepsJson: JSON.stringify(steps) }, FIXTURE_NOW),
    );
    expect(e.code).toBe("ERR_WORKFLOW_BUNDLE_CREDENTIAL");
    expect(e.message).toContain("step 2");
    expect(e.message).not.toContain("ghp_");
  });
  test("refuses a description or an author that looks like a credential, without echoing it", () => {
    const stepsJson = JSON.stringify(FIXTURE_STEPS);
    const token = `ghp_${"c".repeat(36)}`;
    for (const over of [{ description: `use token ${token}` }, { author: token }]) {
      const e = refusal(() => buildBundleBody({ ...base, ...over, stepsJson }, FIXTURE_NOW));
      expect(e.code).toBe("ERR_WORKFLOW_BUNDLE_CREDENTIAL");
      expect(e.message).toContain(Object.keys(over)[0] ?? "");
      expect(e.message).not.toContain("ghp_");
    }
  });
  test("refuses a name a bundle cannot hold and a stored description over 500", () => {
    const stepsJson = JSON.stringify(FIXTURE_STEPS);
    expect(code(() => buildBundleBody({ ...base, name: "bad name", stepsJson }, FIXTURE_NOW))).toBe(
      "ERR_WORKFLOW_BUNDLE_NAME",
    );
    expect(
      code(() =>
        buildBundleBody({ ...base, description: "d".repeat(501), stepsJson }, FIXTURE_NOW),
      ),
    ).toBe("ERR_WORKFLOW_BUNDLE_MALFORMED");
  });
  test("a stored workflow in loose form is exported in canonical form and verifies", () => {
    const loose = JSON.stringify([
      FIXTURE_STEPS[0],
      { ...(FIXTURE_STEPS[1] as object), continueOnError: false },
    ]);
    const body = buildBundleBody({ ...base, stepsJson: loose }, FIXTURE_NOW);
    expect(verifyBundle(signFixture(body), FIXTURE_NOW).canonicalSteps).toBe(
      canonicalJson(body.steps),
    );
  });
});
