import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRelativeTarget } from "../src/core/paths.js";
import { SYMLINK_SKIP } from "./helpers.js";

/** Direct unit coverage for `repoRelativeTarget`'s edge cases — the shared
 *  absolute-to-repo-relative normalizer folded from `src/cli/index.ts`'s
 *  `toRepoRel` (realpath-normalized) and `src/core/correction.ts`'s
 *  `repoRelativeHint` (a thin adapter over this function). */

test("repoRelativeTarget: a plain in-repo absolute path rewrites to repo-relative", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    assert.equal(repoRelativeTarget(join(root, "src", "foo.ts"), root), "src/foo.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoRelativeTarget: a path outside root passes through unchanged — nothing safe to rewrite it to", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-paths-outside-"));
  try {
    const target = join(outside, "secret.ts");
    assert.equal(repoRelativeTarget(target, root), target.replace(/\\/g, "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("repoRelativeTarget: the root path itself has no repo-relative form — passes through unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    // relative(root, root) === "" — the guard rejects an empty result (a blank/"."
    // scope would mint a meaningless repo-wide rule if a caller treated it as valid).
    assert.equal(repoRelativeTarget(root, root), root.replace(/\\/g, "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoRelativeTarget: a relative glob passes through untouched (not absolute, nothing to rewrite)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    assert.equal(repoRelativeTarget("src/**", root), "src/**");
    assert.equal(repoRelativeTarget("./src/auth/**", root), "src/auth/**");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoRelativeTarget: a Windows drive-letter path rewrites correctly against a Windows-style root", () => {
  // Neither path exists on this (POSIX) test host, so realpathNorm's fallback walk
  // resolves both via their longest existing ancestor (this process's cwd) — the
  // point of this test is that root and target decompose into the SAME ancestor
  // chain shape (both posix'd before realpath-walking), so the relative offset
  // between them still comes out right even though nothing on disk backs either.
  const root = "C:\\Users\\dev\\repo";
  const target = "C:\\Users\\dev\\repo\\src\\foo.ts";
  assert.equal(repoRelativeTarget(target, root), "src/foo.ts");
});

test("repoRelativeTarget: a target arriving via a symlinked root still resolves (dec_e0a36efbf5)", { skip: SYMLINK_SKIP }, () => {
  // The macOS /var -> /private/var case: findRoot() resolves the real path, but a hook
  // event's file_path arrives un-resolved through the symlink. A naive relative() would
  // yield a bogus "../" path; the realpath fold this function was consolidated from
  // (src/cli/index.ts's toRepoRel) must still cancel that out.
  const base = mkdtempSync(join(tmpdir(), "hunch-paths-symlink-"));
  try {
    const realRoot = join(base, "real-repo");
    mkdirSync(join(realRoot, "src"), { recursive: true });
    writeFileSync(join(realRoot, "src", "session.ts"), "x");
    const linkRoot = join(base, "linked-repo");
    symlinkSync(realRoot, linkRoot);
    assert.equal(repoRelativeTarget(join(linkRoot, "src", "session.ts"), realRoot), "src/session.ts");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
