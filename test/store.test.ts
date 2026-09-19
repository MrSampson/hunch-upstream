import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tempStore, prov } from "./helpers.js";
import { openMemoryDb, type DB } from "../src/store/db.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

function seed() {
  const ctx = tempStore();
  const { store } = ctx;
  store.json.replaceAll("symbols", [
    { id: "sym_a", file: "src/auth/session.ts", name: "verifySession", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 40, churn_90d: 14, bug_count: 3, fan_in: 2, fan_out: 0 }, last_changed: "" },
    { id: "sym_b", file: "src/billing/charge.ts", name: "charge", kind: "function", signature_hash: "", calls: ["sym_a"], called_by: [], metrics: { loc: 30, churn_90d: 1, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
    { id: "sym_c", file: "src/api/mw.ts", name: "mw", kind: "function", signature_hash: "", calls: ["sym_a"], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
  ] as never);
  store.json.replaceAll("edges", [
    { id: "e1", from: "sym_b", to: "sym_a", type: "calls", reason: "", strength: 1, provenance: prov() },
    { id: "e2", from: "sym_c", to: "sym_a", type: "calls", reason: "", strength: 1, provenance: prov() },
  ] as never);
  store.json.put("decisions", { id: "dec_1", title: "Sessions in Redis", status: "accepted", context: "Token leak forced logout impossible", decision: "Server-side sessions", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth/session.ts"], supersedes: null, caused_by_bug: "bug_1", commit: null, provenance: prov(0.95), date: "2026-05-30T12:00:00Z" } as never);
  store.json.put("bugs", { id: "bug_1", title: "Leaked token usable after reset", symptom: "old token authenticated", root_cause: "stateless JWT not revocable", severity: "critical", status: "fixed", affected_files: ["src/auth/session.ts"], affected_symbols: ["sym_a"], lineage: { introduced_commit: "f00", detected: "t", fixed_commit: "a1b", recurrence_of: null, spawned_decision: "dec_1", spawned_constraint: "con_1" }, provenance: prov(0.88) } as never);
  store.json.put("constraints", { id: "con_1", type: "security", statement: "Revocation must be server-side", scope: ["src/auth/**"], severity: "blocking", enforcement: "advisory_v1", rationale: "from bug_1", source_decision: "dec_1", violations: [], provenance: prov(0.9) } as never);
  store.reindex();
  return ctx;
}

test("reindex counts every entity", () => {
  const { store, cleanup } = seed();
  const { counts } = store.reindex();
  assert.equal(counts.symbols, 3);
  assert.equal(counts.decisions, 1);
  assert.equal(counts.constraints, 1);
  cleanup();
});

test("FTS search finds decision + constraint by topic", () => {
  const { store, cleanup } = seed();
  const refs = store.search("revocation redis").map((h) => h.ref);
  assert.ok(refs.includes("dec_1"));
  cleanup();
});

test("why() returns decisions/bugs/constraints for a file", () => {
  const { store, cleanup } = seed();
  const w = store.why("src/auth/session.ts");
  assert.deepEqual(w.decisions.map((d) => d.id), ["dec_1"]);
  assert.deepEqual(w.bugs.map((b) => b.id), ["bug_1"]);
  assert.deepEqual(w.constraints.map((c) => c.id), ["con_1"]);
  cleanup();
});

test("a 0-byte per-record file (merge-driver tombstone) loads as absent — no corrupt warning, no record (issue #37)", () => {
  const { store, root, cleanup } = seed();
  writeFileSync(join(root, ".hunch", "decisions", "dec_tombstone.json"), "");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => { warns.push(String(msg)); };
  try {
    const ids = store.json.loadAll("decisions").map((d) => d.id);
    assert.ok(ids.includes("dec_1"), "real records still load");
    assert.ok(!ids.includes("dec_tombstone"), "the tombstone contributes no record");
    assert.deepEqual(warns.filter((w) => w.includes("tombstone")), [], "sanity");
    assert.deepEqual(warns.filter((w) => w.includes("corrupt")), [], "no corrupt-warning treadmill for a tombstone");
  } finally {
    console.warn = orig;
    cleanup();
  }
});

/** A decision fixture written straight to disk under an arbitrary file name. */
function writeDecisionFile(root: string, name: string, id: string, title: string): void {
  writeFileSync(join(root, ".hunch", "decisions", name), JSON.stringify({
    id, title, status: "accepted", context: "", decision: "x", consequences: [], alternatives_rejected: [],
    related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null,
    provenance: prov(0.9), date: "2026-06-01T00:00:00Z",
  }));
}

test("a stray copy of a record file loads once, from its canonical <id>.json (issue #291)", () => {
  const { store, root, cleanup } = seed();
  writeDecisionFile(root, "dec_stray.json", "dec_stray", "canonical");
  writeDecisionFile(root, "dec_stray_BASE_1234.json", "dec_stray", "aborted mergetool copy");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => { warns.push(String(msg)); };
  try {
    const hits = store.json.loadAll("decisions").filter((d) => d.id === "dec_stray");
    assert.equal(hits.length, 1, "the stray copy contributes no second record");
    assert.equal(hits[0]?.title, "canonical", "the canonical file wins");
    assert.ok(warns.some((w) => w.includes("stray copy") && w.includes("dec_stray_BASE_1234.json")));
  } finally {
    console.warn = orig;
    cleanup();
  }
});

test("reindex survives a stray copy instead of failing on a duplicate primary key (issue #291)", () => {
  const { store, root, cleanup } = seed();
  writeDecisionFile(root, "dec_stray.json", "dec_stray", "canonical");
  writeDecisionFile(root, "dec_stray (1).json", "dec_stray", "cloud-sync conflict copy");
  const orig = console.warn;
  console.warn = () => {};
  try {
    const { counts } = store.reindex();
    assert.equal(counts.decisions, 2, "dec_1 + dec_stray, counted once each");
  } finally {
    console.warn = orig;
    cleanup();
  }
});

test("a misnamed record with NO canonical file is kept, exactly once (con_947c578b2c, issue #291)", () => {
  const { store, root, cleanup } = seed();
  writeDecisionFile(root, "dec_orphan.orig.json", "dec_orphan", "only home");
  writeDecisionFile(root, "dec_orphan_BASE_9.json", "dec_orphan", "second misnamed copy");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => { warns.push(String(msg)); };
  try {
    const hits = store.json.loadAll("decisions").filter((d) => d.id === "dec_orphan");
    assert.equal(hits.length, 1, "never two records with the same id");
    assert.equal(hits[0]?.title, "only home", "deterministic: the first sorted name wins");
    assert.ok(warns.some((w) => w.includes("expected file name dec_orphan.json")));
  } finally {
    console.warn = orig;
    cleanup();
  }
});

test("why() matches on path segments, never a bare suffix — 'io.ts' must not pull 'scenario.ts' records (issue #32)", () => {
  const { store, cleanup } = seed();
  store.json.put("symbols", { id: "sym_scen", file: "src/x/scenario.ts", name: "scen", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" } as never);
  store.json.put("decisions", { id: "dec_scen", title: "Scenario decision", status: "accepted", context: "", decision: "x", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/x/scenario.ts"], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" } as never);
  store.reindex();
  const w = store.why("io.ts"); // "scenario.ts".endsWith("io.ts") is true — must NOT match
  assert.deepEqual(w.symbols.map((s) => s.id), [], "no symbol matches a bare suffix");
  assert.deepEqual(w.decisions.map((d) => d.id), [], "no decision matches a bare suffix");
  // Segment-anchored suffix still works: the intended convenience is intact.
  const anchored = store.why("x/scenario.ts");
  assert.deepEqual(anchored.decisions.map((d) => d.id), ["dec_scen"]);
  cleanup();
});

test("replaceAll writes new records BEFORE deleting stale ones — a mid-operation failure never empties the kind (issue #30)", () => {
  const { store, root, cleanup } = seed();
  store.json.put("decisions", { id: "dec_keeper", title: "keeper", status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" } as never);
  // Second record is oversized: with write-first ordering the operation throws
  // DURING the write phase, before any delete ran — every pre-existing record
  // must still be on disk (the old delete-all-first ordering left the kind empty).
  const huge = "x".repeat(9 * 1024 * 1024);
  assert.throws(() => store.json.replaceAll("decisions", [
    { id: "dec_new_ok", title: "ok", status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" },
    { id: "dec_new_huge", title: "huge", status: "accepted", context: huge, decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" },
  ] as never));
  const ids = store.json.loadAll("decisions").map((d) => d.id);
  assert.ok(ids.includes("dec_1"), "pre-existing record survives the failed replace");
  assert.ok(ids.includes("dec_keeper"), "pre-existing record survives the failed replace");
  // And a SUCCESSFUL replace still removes stale records and lands the new set.
  store.json.replaceAll("decisions", [
    { id: "dec_only", title: "only", status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" },
  ] as never);
  assert.deepEqual(store.json.loadAll("decisions").map((d) => d.id), ["dec_only"]);
  void root;
  cleanup();
});

test("single-file RMW lock: a stale .rmw-lock is taken over and the write lands; the lock is released after (issue #35)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // provably ownerless — every RMW holds it for milliseconds
  store.json.put("edges", { id: "e_lock", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never);
  assert.ok(store.json.loadAll("edges").some((e) => e.id === "e_lock"), "the write proceeded through the stale lock");
  assert.equal(existsSync(lock), false, "the lock is released after the write");
  cleanup();
});

test("single-file RMW lock: a live lock is a refusal after timeout, never an unlocked write", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.tmp.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  try {
    assert.throws(() => store.json.put("edges", { id: "e_live_lock", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never), /timed out acquiring the edges index lock/);
    assert.equal(existsSync(lock), true, "the contending lock remains owned by its holder");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_live_lock"), false, "the refused write does not publish an unlocked index update");
  } finally { cleanup(); }
});

test("single-file rebuild: replaceAll honors the RMW lock instead of publishing over a live update", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  try {
    assert.throws(() => store.json.replaceAll("edges", [
      { id: "e_rebuild", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() },
    ] as never), /timed out acquiring the edges index lock/);
    assert.deepEqual(store.json.loadAll("edges").map((e) => e.id).sort(), ["e1", "e2"], "a refused rebuild leaves the index unchanged");
    assert.equal(existsSync(lock), true, "the contending lock remains owned by its holder");
  } finally { cleanup(); }
});

for (const kind of ["hardlink", "oversized"] as const) test(`single-file RMW lock refuses ${kind} ownership metadata`, () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock);
  const owner = join(lock, "owner.tmp.json");
  if (kind === "hardlink") {
    const outside = join(root, "foreign-owner.json");
    writeFileSync(outside, "{}");
    fs.linkSync(outside, owner);
  } else writeFileSync(owner, " ".repeat(8192));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  try {
    assert.throws(() => store.json.replaceAll("edges", []), /unsafe|unreadable/);
    assert.deepEqual(store.json.loadAll("edges").map((e) => e.id).sort(), ["e1", "e2"]);
    assert.equal(existsSync(owner), true, "unsafe ownership never licenses removal of another lock");
  } finally { cleanup(); }
});

test("single-file RMW lock: owner metadata failure refuses and cleans up its owned lock", () => {
  const { store, root, cleanup } = seed();
  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(to).replace(/\\/g, "/").endsWith(".rmw-lock/owner.tmp.json")) throw new Error("simulated metadata publication failure");
    return originalRenameSync(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.json.put("edges", { id: "e_owner_failure", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never), /could not record ownership/);
    assert.equal(existsSync(join(root, ".hunch", "edges", ".rmw-lock")), false, "a lock without ownership metadata is never left behind");
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("getDependents walks the graph backward (blast radius)", () => {
  const { store, cleanup } = seed();
  const deps = store.getDependents("sym_a").map((d) => d.id).sort();
  assert.deepEqual(deps, ["sym_b", "sym_c"]);
  assert.deepEqual(store.getDependencies("sym_a"), []);
  cleanup();
});

test("checkConstraints matches by glob scope, severity-sorted", () => {
  const { store, cleanup } = seed();
  const cons = store.checkConstraints("src/auth/session.ts");
  assert.equal(cons[0]?.id, "con_1");
  assert.equal(store.checkConstraints("src/other/x.ts").length, 0);
  cleanup();
});

test("bugLineage finds by symbol and exposes lineage", () => {
  const { store, cleanup } = seed();
  const bugs = store.bugLineage("sym_a");
  assert.equal(bugs[0]?.id, "bug_1");
  assert.equal(bugs[0]?.lineage.fixed_commit, "a1b");
  cleanup();
});

test("fragility ranks the buggy, churned, central symbol first", () => {
  const { store, cleanup } = seed();
  const top = store.fragility(3);
  assert.equal(top[0]?.name, "verifySession");
  assert.ok(top[0]!.score >= top[1]!.score);
  cleanup();
});

test("non-ASCII (CJK) query returns results, never silently [] (regression #2)", () => {
  const { store, cleanup } = tempStore();
  store.json.put("decisions", { id: "dec_jp", title: "セッションをRedisに保存", status: "accepted", context: "", decision: "サーバ側セッション", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-01-01T00:00:00Z" } as never);
  store.reindex();
  const refs = store.search("セッション").map((h) => h.ref);
  assert.ok(refs.includes("dec_jp"), "CJK query matched (FTS or LIKE), not empty");
  cleanup();
});

test("punctuation-only query (no FTS tokens) uses the LIKE fallback (regression #2/#11)", () => {
  const { store, cleanup } = tempStore();
  // statement contains "::" — a token that toFtsQuery() maps to null (no word chars)
  store.json.put("constraints", { id: "con_ns", type: "architecture", statement: "Namespace symbols with :: separators", scope: ["src/**"], severity: "advisory", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: prov(0.8) } as never);
  store.reindex();
  const refs = store.search("::").map((h) => h.ref);
  assert.ok(refs.includes("con_ns"), "punctuation-only query matched via LIKE, not empty");
  cleanup();
});

test("plain search fallback keeps reindex and scoped retrieval working without FTS5", async () => {
  const { store, cleanup } = tempStore();
  // Inject the same schema openDb selects when sqlite_compileoption_used reports
  // no ENABLE_FTS5 (the official Linux Node build exercised this path in CI).
  (store as unknown as { _db: DB | null })._db = openMemoryDb({ forcePlainSearch: true });
  store.json.put("decisions", {
    id: "dec_plain", title: "Redis session memory", status: "accepted", context: "", decision: "Keep sessions server-side",
    consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null,
    caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-07-17T00:00:00Z",
  } as never);
  store.json.put("runbooks", {
    id: "rb_plain", task: "release version", trigger: ["publish package"], steps: ["run tests"], gotchas: [],
    outcome: "published", files: ["package.json"], source_range: null,
    valid_from: "2026-07-17T00:00:00Z", valid_to: null,
    provenance: prov(0.9), date: "2026-07-17T00:00:00Z",
  } as never);
  store.reindex();

  assert.ok(store.search("redis sessions").some((hit) => hit.ref === "dec_plain"));
  assert.ok((await store.searchRunbooks("release package")).some((hit) => hit.ref === "rb_plain"));
  const schema = store.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'search'`).get() as { sql: string };
  assert.doesNotMatch(schema.sql, /VIRTUAL\s+TABLE/i);
  cleanup();
});
