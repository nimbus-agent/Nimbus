import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  traverseGraph,
  upsertGraphEntity,
  upsertGraphRelation,
} from "../../../src/graph/relationship-graph.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

describe("incident correlation (indexed only)", () => {
  test("search + graph link pagerduty alert to pr, ci run, slack, and aws alert", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    const t = Date.now();

    db.run(`INSERT INTO person (id, display_name, canonical_email, linked) VALUES (?, ?, ?, ?)`, [
      "person-corr-1",
      "Dev",
      "dev@example.com",
      0,
    ]);

    const pdPk = "pagerduty:PD-INC-42";
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "alert",
      externalId: "PD-INC-42",
      title: "PD-INC-42 payment-service elevated 5xx — SEV2",
      bodyPreview: "customer checkout impact — incident commander paged",
      modifiedAt: t,
      syncedAt: t,
    });

    const prPk = "github:acme/payment-service#501";
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/payment-service#501",
      title: "Mitigate payment-service latency regression",
      bodyPreview: "rollback plan for incident PD-INC-42",
      modifiedAt: t,
      syncedAt: t,
      authorId: "person-corr-1",
      metadata: { repo: "acme/payment-service" },
    });

    const jenkinsPk = "jenkins:payment-service#main#88";
    upsertIndexedItem(db, {
      service: "jenkins",
      type: "ci_run",
      externalId: "payment-service#main#88",
      title: "payment-service pipeline failed post-deploy",
      bodyPreview: "same incident window",
      modifiedAt: t,
      syncedAt: t,
    });

    const slackPk = "slack:C09INCIDENT:1700000000.000100";
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "C09INCIDENT:1700000000.000100",
      title: "payment-service war room — mitigations",
      bodyPreview: "incident thread linking PD-INC-42 and PR 501",
      modifiedAt: t,
      syncedAt: t,
      metadata: { channel: "C09INCIDENT" },
    });

    const awsPk = "aws:cloudwatch/payment-lambda-errors";
    upsertIndexedItem(db, {
      service: "aws",
      type: "alert",
      externalId: "cloudwatch/payment-lambda-errors",
      title: "Lambda payment-service throttles spike",
      bodyPreview: "metric anomaly during incident — aligned with PD-INC-42 timeframe",
      modifiedAt: t,
      syncedAt: t,
    });

    const graphEntityId = (type: string, externalId: string): string => {
      const r = db
        .query(`SELECT id FROM graph_entity WHERE type = ? AND external_id = ?`)
        .get(type, externalId) as { id: string } | null;
      if (r === null) {
        throw new Error(`missing graph_entity ${type} ${externalId}`);
      }
      return r.id;
    };

    const pdEnt = upsertGraphEntity(db, {
      type: "alert",
      externalId: pdPk,
      label: "PD-INC-42",
      service: "pagerduty",
    });
    const prEnt = graphEntityId("pr", prPk);
    const jenkinsEnt = upsertGraphEntity(db, {
      type: "ci_run",
      externalId: jenkinsPk,
      label: "jenkins build",
      service: "jenkins",
    });
    const slackEnt = graphEntityId("message", slackPk);
    const awsEnt = upsertGraphEntity(db, {
      type: "alert",
      externalId: awsPk,
      label: "cloudwatch",
      service: "aws",
    });

    upsertGraphRelation(db, pdEnt, prEnt, "correlates_with", t);
    upsertGraphRelation(db, pdEnt, jenkinsEnt, "correlates_with", t);
    upsertGraphRelation(db, pdEnt, slackEnt, "correlates_with", t);
    upsertGraphRelation(db, pdEnt, awsEnt, "correlates_with", t);

    const ranked = idx.searchRanked({ name: "payment-service incident", limit: 40 }, {});
    expect(ranked.length).toBeGreaterThanOrEqual(5);
    const svc = new Set(ranked.map((r) => r.service));
    expect(svc.has("pagerduty")).toBe(true);
    expect(svc.has("github")).toBe(true);
    expect(svc.has("jenkins")).toBe(true);
    expect(svc.has("slack")).toBe(true);
    expect(svc.has("aws")).toBe(true);

    const sub = traverseGraph(db, pdPk, { depth: 4, maxNodes: 80 });
    expect(sub).not.toHaveProperty("error");
    if (!("error" in sub)) {
      const ext = new Set(sub.entities.map((e) => e.external_id));
      expect(ext.has(prPk)).toBe(true);
      expect(ext.has(jenkinsPk)).toBe(true);
      expect(ext.has(slackPk)).toBe(true);
      expect(ext.has(awsPk)).toBe(true);
    }

    idx.close();
  });
});
