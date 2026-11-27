import { describe, expect, test } from "bun:test";

import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { REMEDIATION_CATALOG } from "./remediation-catalog.ts";
import { reversibilityClassOf } from "./reversibility.ts";

const row = (id: string) => CONNECTOR_WRITE_ROWS.find((r) => r.toolId === id);

describe("the remediation catalogue names real, classified write rows (Phase 10 IC5a)", () => {
  const all = [
    REMEDIATION_CATALOG.argoRollback,
    ...REMEDIATION_CATALOG.repeatable,
    ...Object.values(REMEDIATION_CATALOG.alerts).flatMap((a) => [a.ack, a.close]),
  ];

  test("every id is a row of the write table", () => {
    for (const id of all) expect(row(id), id).toBeDefined();
  });

  test("a repeatable tool is reversible and its input is not incident-specific", () => {
    for (const id of REMEDIATION_CATALOG.repeatable) {
      expect(reversibilityClassOf(row(id)), id).toBe("reversible");
    }
    expect(REMEDIATION_CATALOG.repeatable).not.toContain(REMEDIATION_CATALOG.argoRollback);
    expect(REMEDIATION_CATALOG.repeatable).not.toContain("aws_ecs_service_update");
  });

  test("the flag writes are repeatable: LaunchDarkly, Flagsmith, and the Unleash and Split writes (owner ruling 2026-11-27)", () => {
    expect(REMEDIATION_CATALOG.repeatable).toEqual([
      "launchdarkly_flag_toggle",
      "flagsmith_feature_state_set",
      "unleash_feature_toggle",
      "split_kill",
      "split_restore",
      "aws_ec2_instance_start",
      "aws_ec2_instance_stop",
    ]);
  });

  test("the alert tools are irreversible and the rollback is reversible", () => {
    for (const a of Object.values(REMEDIATION_CATALOG.alerts)) {
      expect(reversibilityClassOf(row(a.ack))).toBe("irreversible");
      expect(reversibilityClassOf(row(a.close))).toBe("irreversible");
    }
    expect(reversibilityClassOf(row(REMEDIATION_CATALOG.argoRollback))).toBe("reversible");
  });

  test("the alert field is the one the row preview names", () => {
    for (const a of Object.values(REMEDIATION_CATALOG.alerts)) {
      const preview = row(a.ack)?.preview;
      expect(preview?.fields.map((f) => f.key)).toContain(a.field);
    }
  });
});
