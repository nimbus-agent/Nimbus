import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { registerConnectorWithCompanions } from "./auth-register.ts";

let db: Database;
let index: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  index = new LocalIndex(db);
});
afterEach(() => db.close());

const rows = () =>
  (
    db.query("SELECT service_id AS id FROM scheduler_state ORDER BY service_id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);

describe("registerConnectorWithCompanions", () => {
  test("jenkins registers its build-minutes companion with it", () => {
    registerConnectorWithCompanions(index, "jenkins");
    expect(rows()).toEqual(["jenkins", "jenkins_billing"]);
  });

  test("a connector with no companion registers alone", () => {
    registerConnectorWithCompanions(index, "gitlab");
    expect(rows()).toEqual(["gitlab"]);
  });
});
