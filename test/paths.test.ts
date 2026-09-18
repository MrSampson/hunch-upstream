import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRelativeTarget } from "../src/core/paths.js";

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
