import { describe, expect, test } from "bun:test";

import { mapSagemakerModelToItem } from "../../../src/connectors/sagemaker-model-mapping.ts";

const SYNCED_AT = 1_700_000_900_000;

describe("mapSagemakerModelToItem", () => {
  test("maps a list-models entry + describe enrichment to metadata-only item", () => {
    const item = mapSagemakerModelToItem(
      {
        ModelName: "fraud-detector",
        ModelArn: "arn:aws:sagemaker:us-east-1:1:model/fraud-detector",
        CreationTime: 1_700_000_000,
      },
      {
        syncedAt: SYNCED_AT,
        containerImage: "1.dkr.ecr.us-east-1.amazonaws.com/xgboost:latest",
        modelDataUrl: "s3://my-bucket/models/fraud-detector/model.tar.gz",
        executionRoleArn: "arn:aws:iam::1:role/SageMakerRole",
      },
    );
    expect(item).not.toBeNull();
    if (item === null) {
      return;
    }
    expect(item.service).toBe("sagemaker");
    expect(item.type).toBe("model");
    expect(item.externalId).toBe("arn:aws:sagemaker:us-east-1:1:model/fraud-detector");
    expect(item.title).toBe("fraud-detector");
    // epoch-SECONDS CreationTime parses to millis.
    expect(item.modifiedAt).toBe(1_700_000_000_000);
    expect(item.url).toBeNull();
    expect(item.canonicalUrl).toBeNull();
    expect(item.metadata).toMatchObject({
      modelName: "fraud-detector",
      modelArn: "arn:aws:sagemaker:us-east-1:1:model/fraud-detector",
      containerImage: "1.dkr.ecr.us-east-1.amazonaws.com/xgboost:latest",
      modelDataUrl: "s3://my-bucket/models/fraud-detector/model.tar.gz",
      executionRoleArn: "arn:aws:iam::1:role/SageMakerRole",
      creationTime: 1_700_000_000_000,
    });
    // No inference / prediction / training data of any kind.
    const meta = JSON.stringify(item.metadata);
    expect(meta).not.toContain("prediction");
    expect(meta).not.toContain("inference");
  });

  test("maps a bare list-models entry (no describe enrichment)", () => {
    const item = mapSagemakerModelToItem(
      {
        ModelName: "churn-model",
        ModelArn: "arn:aws:sagemaker:us-east-1:1:model/churn-model",
      },
      { syncedAt: SYNCED_AT },
    );
    expect(item?.metadata).toMatchObject({ modelName: "churn-model" });
    expect(item?.metadata.containerImage).toBeUndefined();
    expect(item?.metadata.modelDataUrl).toBeUndefined();
  });

  test("external_id falls back to ModelName when ModelArn absent", () => {
    const item = mapSagemakerModelToItem({ ModelName: "no-arn-model" }, { syncedAt: SYNCED_AT });
    expect(item?.externalId).toBe("no-arn-model");
  });

  test("modifiedAt falls back to syncedAt when CreationTime absent", () => {
    const item = mapSagemakerModelToItem({ ModelName: "m" }, { syncedAt: SYNCED_AT });
    expect(item?.modifiedAt).toBe(SYNCED_AT);
  });

  test("parses an ISO-8601 CreationTime string", () => {
    const item = mapSagemakerModelToItem(
      { ModelName: "iso-model", CreationTime: "2023-11-14T22:13:20.000Z" },
      { syncedAt: SYNCED_AT },
    );
    expect(item?.modifiedAt).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
  });

  test("returns null when ModelName is missing or blank", () => {
    expect(mapSagemakerModelToItem({ ModelArn: "x" }, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapSagemakerModelToItem({ ModelName: "" }, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapSagemakerModelToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
  });
});
