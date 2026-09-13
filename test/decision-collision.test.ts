import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/mcp/server.js";
import { decisionId } from "../src/core/ids.js";

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function decisionRepo(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-decision-collision-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Decision Collision Test");
  git(root, "config", "user.email", "decision-collision@example.invalid");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), `${JSON.stringify({ autoCommit: false })}\n`);
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

function decisionRepoWithWorktree(): { root: string; worktree: string; branch: string; cleanup: () => void } {
  const { root } = decisionRepo();
  const branch = "feature-decision-collision";
  const worktree = `${root}-wt`;
  git(root, "worktree", "add", "-q", "-b", branch, worktree);
  mkdirSync(join(worktree, ".hunch"), { recursive: true });
  writeFileSync(join(worktree, ".hunch", "local.json"), `${JSON.stringify({ autoCommit: false })}\n`);
  return {
    root,
    worktree,
    branch,
    cleanup: () => {
      try { git(root, "worktree", "remove", "--force", worktree); } catch { /* best effort */ }
      try { rmSync(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
    },
  };
}

async function connect(root: string): Promise<{ client: Client; server: McpServer }> {
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "decision-collision-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function record(client: Client, decision: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({
    name: "hunch_record_decision",
    arguments: { decision },
  })) as ToolText;
  return {
    isError: !!result.isError,
    text: result.content.map((item) => item.text ?? "").join("\n"),
  };
}

test("same commit cannot silently replace a different human-confirmed decision", async (t) => {
  const { root, sha } = decisionRepo();
  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const first = await record(client, {
    title: "Decision A",
    topic: "decision-a",
    context: "first",
    decision: "Choose A",
    commit: sha,
  });
  assert.equal(first.isError, false, first.text);

  const id = decisionId(sha);
  const file = join(root, ".hunch", "decisions", `${id}.json`);
  const before = readFileSync(file, "utf8");
  const second = await record(client, {
    title: "Decision B",
    topic: "decision-b",
    context: "second",
    decision: "Choose B",
    commit: sha,
  });

  assert.equal(second.isError, true, `the second capture must be refused, got: ${second.text}`);
  assert.match(second.text, /already identifies a different curated decision/i);
  assert.equal(readFileSync(file, "utf8"), before, "the first decision remains byte-for-byte unchanged");

  const topicless = await record(client, {
    title: "Decision C",
    context: "third",
    decision: "Choose C",
    commit: sha,
  });
  assert.equal(topicless.isError, true, `omitting a topic must not bypass the collision guard: ${topicless.text}`);
  assert.equal(readFileSync(file, "utf8"), before, "the first decision remains unchanged after a topicless collision");
});

test("a human capture still upgrades the machine draft for its commit", async (t) => {
  const { root, sha } = decisionRepo();
  const id = decisionId(sha);
  const file = join(root, ".hunch", "decisions", `${id}.json`);
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    id,
    title: "Machine draft",
    topic: null,
    status: "accepted",
    context: "draft",
    decision: "Draft choice",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["app.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: sha,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "llm_draft", confidence: 0.5, evidence: [`commit:${sha}`] },
    date: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`);

  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  // The human vouch travels via the capture token (authorship stamp): an
  // un-token'd upgrade still lands the content, but as agent_recorded testimony —
  // only the interview mints human_confirmed.
  const brief = (await client.callTool({ name: "hunch_capture_decision", arguments: { topic: "human-topic" } })) as ToolText;
  const token = /capture_token:"([^"]+)"/.exec(brief.content.map((c) => c.text ?? "").join("\n"))?.[1];
  assert.ok(token, "capture brief must issue a token");
  const result = (await client.callTool({
    name: "hunch_record_decision",
    arguments: {
      decision: { title: "Human decision", topic: "human-topic", context: "human rationale", decision: "Confirmed choice", commit: sha },
      capture_token: token,
    },
  })) as ToolText;
  assert.equal(!!result.isError, false, result.content.map((c) => c.text ?? "").join("\n"));

  const upgraded = JSON.parse(readFileSync(file, "utf8")) as {
    title: string;
    topic: string | null;
    provenance: { source: string };
  };
  assert.equal(upgraded.title, "Human decision");
  assert.equal(upgraded.topic, "human-topic");
  assert.equal(upgraded.provenance.source, "llm_draft+human_confirmed");
});

test("same-topic human re-record may refine the title without minting a duplicate", async (t) => {
  const { root, sha } = decisionRepo();
  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const first = await record(client, {
    title: "Initial wording",
    topic: "stable-topic",
    decision: "Choice",
    commit: sha,
  });
  assert.equal(first.isError, false, first.text);

  const second = await record(client, {
    title: "Clearer wording",
    topic: "stable-topic",
    decision: "Choice, clarified",
    commit: sha,
  });
  assert.equal(second.isError, false, second.text);

  const saved = JSON.parse(readFileSync(
    join(root, ".hunch", "decisions", `${decisionId(sha)}.json`),
    "utf8",
  )) as { title: string; topic: string };
  assert.equal(saved.title, "Clearer wording");
  assert.equal(saved.topic, "stable-topic");
});

test("same-titled manual captures (no commit) on different branches do not collide on one id (#54)", async (t) => {
  const fixture = decisionRepoWithWorktree();
  const rootConn = await connect(fixture.root);
  const worktreeConn = await connect(fixture.worktree);
  t.after(async () => {
    await rootConn.client.close().catch(() => {});
    await rootConn.server.close().catch(() => {});
    await worktreeConn.client.close().catch(() => {});
    await worktreeConn.server.close().catch(() => {});
    fixture.cleanup();
  });

  // Same title, deliberately, and no `commit` field — this is the exact shape a
  // misrouted-then-corrected re-call produced in the field: the manual-fallback id
  // seed must not collide just because a subagent phrased two genuinely different
  // decisions with the same title on two different branches.
  const title = "Use a retry queue for flaky uploads";
  const onRoot = await record(rootConn.client, {
    title,
    topic: "upload-retry-root",
    context: "captured from the primary checkout",
    decision: "Retry with backoff",
  });
  assert.equal(onRoot.isError, false, onRoot.text);

  const onWorktree = await record(worktreeConn.client, {
    title,
    topic: "upload-retry-worktree",
    context: "captured from the linked worktree — a genuinely different decision",
    decision: "Retry via a dead-letter queue instead",
  });
  assert.equal(onWorktree.isError, false, onWorktree.text);

  const rootDecisions = readdirSync(join(fixture.root, ".hunch", "decisions"));
  const worktreeDecisions = readdirSync(join(fixture.worktree, ".hunch", "decisions"));
  assert.equal(rootDecisions.length, 1, `expected exactly one decision at the root: ${rootDecisions.join(", ")}`);
  assert.equal(worktreeDecisions.length, 1, `expected exactly one decision at the worktree: ${worktreeDecisions.join(", ")}`);
  assert.notEqual(
    rootDecisions[0], worktreeDecisions[0],
    "the same title on two different branches must not collide on one manual-fallback id",
  );

  const rootRec = JSON.parse(readFileSync(join(fixture.root, ".hunch", "decisions", rootDecisions[0]!), "utf8")) as { context: string };
  const worktreeRec = JSON.parse(readFileSync(join(fixture.worktree, ".hunch", "decisions", worktreeDecisions[0]!), "utf8")) as { context: string };
  assert.equal(rootRec.context, "captured from the primary checkout");
  assert.equal(worktreeRec.context, "captured from the linked worktree — a genuinely different decision");
});

test("a same-titled manual re-record on the SAME branch still upgrades the same slot, in a real git repo (#54)", async (t) => {
  // The fix must not break the intentional draft-upgrade workflow it shares a code
  // path with: re-recording the same title with no commit, on the SAME branch,
  // is how a manual capture gets refined. test/testimony.test.ts covers this in a
  // fixture with NO git repo at all (branch component stably absent); this
  // exercises it against a real branch, so a future change to the seed that
  // accidentally makes it branch-AND-something-else-volatile would be caught here.
  const fixture = decisionRepo();
  const { client, server } = await connect(fixture.root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const title = "Cache invalidation strategy";
  const first = await record(client, { title, context: "first pass", decision: "TTL-based" });
  assert.equal(first.isError, false, first.text);

  const second = await record(client, { title, context: "refined after review", decision: "TTL-based with explicit purge" });
  assert.equal(second.isError, false, second.text);

  const decisions = readdirSync(join(fixture.root, ".hunch", "decisions"));
  assert.equal(decisions.length, 1, `same-branch re-record must upgrade in place, not mint a second slot: ${decisions.join(", ")}`);
  const rec = JSON.parse(readFileSync(join(fixture.root, ".hunch", "decisions", decisions[0]!), "utf8")) as { context: string; decision: string };
  assert.equal(rec.context, "refined after review");
  assert.equal(rec.decision, "TTL-based with explicit purge");
});

test("same-titled manual captures from two different branches sharing ONE private overlay do not overwrite each other (#54)", async (t) => {
  // The two-store comparison above only proves the collision is avoided; the
  // actual data-loss shape the bug report worried about (and mergeHunchJson's
  // pickWinner would otherwise silently resolve) is TWO branches racing to write
  // the SAME store — exactly what a shared/team private overlay is. This proves
  // the fix closes that immediately, not just eventually at a git merge.
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-decision-collision-shared-overlay-"));
  const overlay = join(sandbox, "shared-overlay", ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", join(sandbox, "shared-overlay")]);

  const makeRoot = (name: string, branch: string): string => {
    const root = join(sandbox, name);
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q");
    git(root, "config", "user.name", "Decision Collision Test");
    git(root, "config", "user.email", "decision-collision@example.invalid");
    writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    git(root, "checkout", "-q", "-b", branch);
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "local.json"), `${JSON.stringify({ privateDir: overlay, autoCommit: false })}\n`);
    return root;
  };
  const rootA = makeRoot("repo-a", "feature-a");
  const rootB = makeRoot("repo-b", "feature-b");

  const connA = await connect(rootA);
  const connB = await connect(rootB);
  t.after(async () => {
    await connA.client.close().catch(() => {});
    await connA.server.close().catch(() => {});
    await connB.client.close().catch(() => {});
    await connB.server.close().catch(() => {});
    try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const title = "Retry uploads with a queue";
  const onA = await record(connA.client, {
    title, topic: "upload-retry-a", context: "captured from repo A", decision: "Backoff retry", private: true,
  });
  assert.equal(onA.isError, false, onA.text);
  const onB = await record(connB.client, {
    title, topic: "upload-retry-b", context: "captured from repo B — a genuinely different decision", decision: "Dead-letter queue instead", private: true,
  });
  assert.equal(onB.isError, false, onB.text);

  const overlayDecisions = readdirSync(join(overlay, "decisions"));
  assert.equal(overlayDecisions.length, 2, `expected two distinct decisions in the shared overlay, not one overwriting the other: ${overlayDecisions.join(", ")}`);
});
