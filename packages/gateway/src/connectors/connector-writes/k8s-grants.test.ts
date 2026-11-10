import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { getK8sGrants, k8sGrantFor, removeK8sGrants, setK8sGrants } from "./k8s-grants.ts";

function fresh(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 86);
  return db;
}

const A = {
  context: "prod",
  namespace: "shop",
  server: "a.example:6443",
  credentialForm: "token",
} as const;
const B = {
  context: "prod",
  namespace: "api",
  server: "a.example:6443",
  credentialForm: "token",
} as const;
const C = {
  context: "staging",
  namespace: "shop",
  server: "b.example:443",
  credentialForm: "client-certificate",
} as const;

describe("the Kubernetes grants store", () => {
  test("nothing is approved on a fresh database", () => {
    const db = fresh();
    expect(getK8sGrants(db)).toEqual([]);
    db.close();
  });

  test("set then get, in (context, namespace) order, with each pair's server and form", () => {
    const db = fresh();
    setK8sGrants(db, [C, A, B], 5);
    expect(getK8sGrants(db)).toEqual([B, A, C]);
    db.close();
  });

  test("setting replaces the whole set, it never merges", () => {
    const db = fresh();
    setK8sGrants(db, [A, B], 1);
    setK8sGrants(db, [C], 2);
    expect(getK8sGrants(db)).toEqual([C]);
    db.close();
  });

  test("a repeated pair keeps its last entry (no duplicate key error)", () => {
    const db = fresh();
    setK8sGrants(db, [A, { ...A, server: "moved.example:443" }], 1);
    expect(getK8sGrants(db)).toEqual([{ ...A, server: "moved.example:443" }]);
    db.close();
  });

  test("remove drops everything and says whether there was something", () => {
    const db = fresh();
    expect(removeK8sGrants(db)).toBe(false);
    setK8sGrants(db, [A], 1);
    expect(removeK8sGrants(db)).toBe(true);
    expect(getK8sGrants(db)).toEqual([]);
    db.close();
  });

  test("a failed set leaves the earlier set in place (one transaction)", () => {
    const db = fresh();
    setK8sGrants(db, [A], 1);
    expect(() => setK8sGrants(db, [C, { ...B, credentialForm: "exec" as never }], 2)).toThrow();
    expect(getK8sGrants(db)).toEqual([A]);
    db.close();
  });

  test("k8sGrantFor matches the exact pair only", () => {
    const grants = [A, C];
    expect(k8sGrantFor(grants, "prod", "shop")).toEqual(A);
    expect(k8sGrantFor(grants, "prod", "api")).toBeUndefined();
    expect(k8sGrantFor(grants, "staging", "shop")).toEqual(C);
    expect(k8sGrantFor(grants, "Prod", "shop")).toBeUndefined();
  });

  test("a stored row whose form is not one of the closed set cannot exist (CHECK)", () => {
    const db = fresh();
    expect(() =>
      dbRun(
        db,
        "INSERT INTO connector_write_k8s_grant (context, namespace, server, credential_form, approved_at) VALUES ('x','y','h:1','basic',1)",
      ),
    ).toThrow();
    db.close();
  });
});
