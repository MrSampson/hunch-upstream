import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempStore, prov } from "./helpers.js";
import { resolveSymbols, resolveFiles } from "../src/mcp/server.js";

function seed() {
  const ctx = tempStore();
  const { store } = ctx;
  store.json.replaceAll("symbols", [
    { id: "sym_db", file: "src/db.ts", name: "connect", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" },
    { id: "sym_mongo", file: "src/mongodb.ts", name: "connectMongo", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" },
    // "datastore" merely CONTAINS "store" as a substring — no "/" boundary before it,
    // so this must never match a "store/db.ts" target (the issue's own example).
    { id: "sym_datastore_db", file: "src/datastore/db.ts", name: "connectDatastore", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" },
    { id: "sym_store_db", file: "src/store/db.ts", name: "connectStore", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" },
    { id: "sym_auth", file: "src/auth/session.ts", name: "verifySession", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" },
  ] as never);
  store.json.put("constraints", {
    id: "con_1", type: "security", statement: "must not break", scope: ["src/auth/**"], severity: "blocking",
    enforcement: "advisory_v1", rationale: "x", source_decision: null, violations: [], provenance: prov(0.9),
  } as never);
  store.reindex();
  return ctx;
}

test("resolveSymbols matches only a segment-anchored suffix — 'db.ts' must not pull 'mongodb.ts', 'store/db.ts' must not pull 'datastore/db.ts' (issue #300)", () => {
  const { store, cleanup } = seed();
  const dbMatches = resolveSymbols(store, "db.ts").map((s) => s.id).sort();
  assert.deepEqual(dbMatches, ["sym_datastore_db", "sym_db", "sym_store_db"].sort(), "every real db.ts file matches, mongodb.ts never does");
  const storeDbMatches = resolveSymbols(store, "store/db.ts").map((s) => s.id);
  assert.deepEqual(storeDbMatches, ["sym_store_db"], "'datastore/db.ts' must not match 'store/db.ts' — 'store' there is a substring, not a path segment");
  const exact = resolveSymbols(store, "src/db.ts").map((s) => s.id);
  assert.deepEqual(exact, ["sym_db"]);
  cleanup();
});

test("resolveSymbols/resolveFiles rewrite an absolute target to repo-relative before matching (issue #296)", () => {
  const { store, root, cleanup } = seed();
  const abs = join(root, "src", "auth", "session.ts");
  assert.deepEqual(resolveSymbols(store, abs).map((s) => s.id), ["sym_auth"]);
  assert.deepEqual(resolveFiles(store, abs), ["src/auth/session.ts"]);
  cleanup();
});

test("checkConstraints matches an absolute target the same as its repo-relative form (issue #296)", () => {
  const { store, root, cleanup } = seed();
  const rel = store.checkConstraints("src/auth/session.ts").map((c) => c.id);
  const abs = store.checkConstraints(join(root, "src", "auth", "session.ts")).map((c) => c.id);
  assert.deepEqual(rel, ["con_1"]);
  assert.deepEqual(abs, rel);
  cleanup();
});
