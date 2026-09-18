import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function overlayDecision(id: string): Decision {
  return {
    id,
    title: `Overlay decision ${id}`,
    topic: null,
    status: "accepted",
    context: "fixture",
    decision: "d",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
}

// issue #294: `hunch supersede` resolved both ids and closed the old one against
// the PUBLIC store only (`store.json`), so in unified/shared mode — where every
// decision lives in the private overlay — it always failed "--by decision ...
// not found", and even a resolvable overlay decision could never be superseded.
test("supersede resolves and closes a decision that lives in the private overlay (issue #294)", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-supersede-private-"));
  const publicRoot = join(sandbox, "code");
  const overlayRoot = join(sandbox, "private-memory");
  const privateHunch = join(overlayRoot, ".hunch");
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(overlayRoot, { recursive: true });

  try {
    git(publicRoot, "init", "-q");
    git(publicRoot, "config", "user.email", "test@example.com");
    git(publicRoot, "config", "user.name", "Test Human");
    git(publicRoot, "config", "commit.gpgsign", "false");
    writeFileSync(join(publicRoot, "src.ts"), "export const value = 1;\n");
    const publicJson = new JsonStore(hunchPaths(publicRoot));
    publicJson.ensureDirs();
    git(publicRoot, "add", "-A");
    git(publicRoot, "commit", "-qm", "fixture: public baseline");

    git(overlayRoot, "init", "-q");
    git(overlayRoot, "config", "user.email", "test@example.com");
    git(overlayRoot, "config", "user.name", "Test Human");
    git(overlayRoot, "config", "commit.gpgsign", "false");
    const privateJson = new JsonStore(hunchPathsForDir(privateHunch));
    privateJson.ensureDirs();
    const oldDecision = overlayDecision("dec_overlay_old");
    const newDecision = overlayDecision("dec_overlay_new");
    privateJson.put("decisions", oldDecision);
    privateJson.put("decisions", newDecision);
    git(overlayRoot, "add", "-A");
    git(overlayRoot, "commit", "-qm", "fixture: overlay baseline");

    const run = spawnSync(process.execPath, [tsx, cli, "supersede", oldDecision.id, "--by", newDecision.id], {
      cwd: publicRoot,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: privateHunch, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /superseded by/);

    const closed = JSON.parse(readFileSync(join(privateHunch, "decisions", `${oldDecision.id}.json`), "utf8")) as Decision;
    assert.equal(closed.status, "superseded");
    assert.equal(closed.superseded_by, newDecision.id);
    assert.ok(closed.valid_to);

    // The close must land in the overlay, never leak a copy into the public store.
    const publicDecisionsDir = join(publicRoot, ".hunch/decisions");
    let publicHasIt = false;
    try {
      readFileSync(join(publicDecisionsDir, `${oldDecision.id}.json`));
      publicHasIt = true;
    } catch { /* expected: no such file */ }
    assert.equal(publicHasIt, false, "the superseded record is never written to the public store");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
