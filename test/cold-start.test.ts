/**
 * Cold start: importing the parsing module graph must not load the native
 * tree-sitter addons. Loading them copies six `.node` files into a per-process
 * temp dir and dlopens them, which cost every CLI process and every editor hook
 * 1.5-5 s of startup even when nothing ever parsed (fnd_4b091dd16c).
 *
 * The assertions are deliberately OS-neutral and never time anything: they check
 * that no tree-sitter addon is in the require cache and that no per-process temp
 * copy dir was created, which holds identically on Windows (where the temp-copy
 * file-lock isolation matters most) as on POSIX.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COPY_PREFIX = "hunch-tree-sitter-";
const ADDON = /tree-sitter.*\.node$/;

function moduleUrl(relative: string): string {
  return JSON.stringify(pathToFileURL(join(process.cwd(), relative)).href);
}

/** Run `script` in a fresh child (tsx loader) and return its stdout report. */
function inChild(script: string): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("importing the parse/indexer/constitution modules loads no native tree-sitter addon", () => {
  const script = `
    import { createRequire } from "node:module";
    import { readdirSync } from "node:fs";
    import { tmpdir } from "node:os";
    await import(${moduleUrl("src/extractors/parse.ts")});
    await import(${moduleUrl("src/extractors/indexer.ts")});
    await import(${moduleUrl("src/constitution/g2BehaviorCandidates.ts")});
    const require = createRequire(import.meta.url);
    const loaded = Object.keys(require.cache).filter((p) => ${ADDON}.test(p));
    let copies = [];
    try {
      copies = readdirSync(tmpdir()).filter((n) => n.startsWith(${JSON.stringify(COPY_PREFIX)} + process.pid + "-"));
    } catch { /* unreadable tmpdir: the require-cache assertion still holds */ }
    console.log(JSON.stringify({ loaded, copies }));
  `;
  const child = inChild(script);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { loaded: string[]; copies: string[] };
  assert.deepEqual(report.loaded, [], `native addon loaded merely by importing: ${report.loaded.join(", ")}`);
  assert.deepEqual(report.copies, [], `per-process temp copy dir created without parsing: ${report.copies.join(", ")}`);
});

test("a real parse still works and loads the addons on first use", () => {
  const script = `
    import { createRequire } from "node:module";
    const { parseSource } = await import(${moduleUrl("src/extractors/parse.ts")});
    const parsed = parseSource("fixture.ts", "export function answer(): number { return 42; }");
    const require = createRequire(import.meta.url);
    const loaded = Object.keys(require.cache).filter((p) => /tree-sitter.*\\.node$/.test(p));
    console.log(JSON.stringify({
      parseable: parsed.parseable,
      symbols: parsed.symbols.map((s) => s.name),
      addonCount: loaded.length,
    }));
  `;
  const child = inChild(script);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
    parseable: boolean; symbols: string[]; addonCount: number;
  };
  assert.equal(report.parseable, true);
  assert.deepEqual(report.symbols, ["answer"]);
  assert.ok(report.addonCount > 0, "first parse must actually load the native addons");
});

test("this test process itself created no stray temp copy dirs", () => {
  // Guards the cleanup contract: nothing here should leave a copy dir behind for
  // THIS pid, since the child processes own (and delete) their own copies.
  let entries: string[] = [];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  const mine = entries.filter((name) => name.startsWith(`${COPY_PREFIX}${process.pid}-`));
  assert.deepEqual(mine, [], `unexpected temp copy dir for this process: ${mine.join(", ")}`);
});
