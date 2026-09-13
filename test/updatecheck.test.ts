import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkForUpdate, defaultCacheFile, formatUpdateNotice, shouldCheckForUpdate } from "../src/core/updatecheck.js";
import { HUNCH_PACKAGE_NAME, HUNCH_VERSION } from "../src/core/version.js";
import { hunchCliArgs } from "./cli-invocation.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpCacheFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "hunch-updatecheck-"));
  return { dir, file: join(dir, "cache.json") };
}

function fakeFetchOk(version: string): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ version }),
  })) as unknown as typeof fetch;
}

function fetchShouldNotBeCalled(): typeof fetch {
  return (async () => {
    throw new Error("fetch should not have been called");
  }) as unknown as typeof fetch;
}

test("reports a newer version when the registry has one", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null when already on the latest version", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("1.0.0"),
      now: () => 0,
    });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null when the local build is ahead of the registry", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "2.0.0",
      fetchImpl: fakeFetchOk("1.0.0"),
      now: () => 0,
    });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not treat a prerelease as newer than its own base release", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.24.0",
      fetchImpl: fakeFetchOk("1.24.0-beta.1"),
      now: () => 0,
    });
    assert.equal(result, null, "a prerelease of the currently-installed version is not an upgrade");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports a real release as newer than a prerelease of the same version currently installed", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.24.0-beta.1",
      fetchImpl: fakeFetchOk("1.24.0"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "1.24.0-beta.1", latest: "1.24.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never treats one prerelease as an upgrade over a different prerelease of the same base release", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    // Deliberate simplification (not full semver precedence): two prereleases
    // of the same core are never an upgrade over each other, in either
    // direction — regardless of which prerelease identifier is numerically
    // higher.
    const higherToLower = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0-beta.9",
      fetchImpl: fakeFetchOk("1.0.0-beta.10"),
      now: () => 0,
    });
    assert.equal(higherToLower, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not throw on a non-numeric version segment; treats it as 0 rather than failing the comparison", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "abc",
      fetchImpl: fakeFetchOk("1.0.0"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "abc", latest: "1.0.0" }, "a malformed current version compares as 0, so any real release looks newer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pads a shorter release core with zeros before comparing (\"1.2\" vs \"1.2.1\")", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.2",
      fetchImpl: fakeFetchOk("1.2.1"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "1.2", latest: "1.2.1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips build metadata (+...) before comparing, per semver — it carries no ordering meaning", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0+abc123",
      fetchImpl: fakeFetchOk("1.0.0+xyz789"),
      now: () => 0,
    });
    assert.equal(result, null, "differing build metadata alone must not be reported as an upgrade");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists the latest-seen version to the cache file after a successful check", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 12345,
    });
    const cached = JSON.parse(readFileSync(file, "utf8")) as { lastCheckedAt: number; latestSeen: string };
    assert.equal(cached.lastCheckedAt, 12345);
    assert.equal(cached.latestSeen, "9.9.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creates the cache file's parent directory when it doesn't exist yet", async () => {
  const { dir } = tmpCacheFile();
  try {
    const nestedFile = join(dir, "nested", "cache.json");
    await checkForUpdate({
      cacheFile: nestedFile,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 0,
    });
    assert.equal(existsSync(nestedFile), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips the network call within the 24h cache window", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    writeFileSync(file, JSON.stringify({ lastCheckedAt: 1_000_000, latestSeen: "9.9.9" }));
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fetchShouldNotBeCalled(),
      now: () => 1_000_000 + DAY_MS - 1,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-checks once the cache entry is older than 24h", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    writeFileSync(file, JSON.stringify({ lastCheckedAt: 1_000_000, latestSeen: "1.0.0" }));
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 1_000_000 + DAY_MS + 1,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-checks exactly on the 24h cache boundary (treats it as expired)", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    writeFileSync(file, JSON.stringify({ lastCheckedAt: 1_000_000, latestSeen: "1.0.0" }));
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 1_000_000 + DAY_MS,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" }, "exactly 24h old counts as expired, not fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("treats a valid-JSON but wrong-shaped cache file as absent and re-fetches", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    writeFileSync(file, JSON.stringify({ lastCheckedAt: "not-a-number" }));
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null, not a thrown rejection, when the registry response body fails to parse as JSON", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const brokenJsonFetch = (async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    })) as unknown as typeof fetch;
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: brokenJsonFetch,
      now: () => 0,
    });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still returns the correct result when persisting the cache fails", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    // A file already occupying the parent path makes mkdir(dirname) throw
    // ENOTDIR, so the write fails even though writeCache creates missing
    // parent directories for the ordinary (not-yet-existing-dir) case.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const unwritableFile = join(blocker, "cache.json");
    const result = await checkForUpdate({
      cacheFile: unwritableFile,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" }, "a lost cache write must not affect the returned result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null and never throws on a network failure", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: failingFetch,
      now: () => 0,
    });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null on a non-OK registry response", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const notOkFetch = (async () => ({
      ok: false,
      json: async () => ({ version: "9.9.9" }),
    })) as unknown as typeof fetch;
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: notOkFetch,
      now: () => 0,
    });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null on a malformed registry response", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    const malformedFetch = (async () => ({
      ok: true,
      json: async () => ({ notVersion: "oops" }),
    })) as unknown as typeof fetch;
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: malformedFetch,
      now: () => 0,
    });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null on a corrupt cache file, without throwing", async () => {
  const { dir, file } = tmpCacheFile();
  try {
    writeFileSync(file, "{not json");
    const result = await checkForUpdate({
      cacheFile: file,
      currentVersion: "1.0.0",
      fetchImpl: fakeFetchOk("9.9.9"),
      now: () => 0,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "9.9.9" }, "recovers by treating a corrupt cache as absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldCheckForUpdate: false for hunch mcp, regardless of TTY", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "mcp", isTTY: true, installed: true, env: {} }), false);
  assert.equal(shouldCheckForUpdate({ commandName: "mcp", isTTY: false, installed: true, env: {} }), false);
});

test("shouldCheckForUpdate: false for hunch check, regardless of TTY — it runs synchronously inside the pre-commit hook with inherited (TTY) stdio, so a fetch there would add latency to every commit and interleave with constraint-guard output", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "check", isTTY: true, installed: true, env: {} }), false);
  assert.equal(shouldCheckForUpdate({ commandName: "check", isTTY: false, installed: true, env: {} }), false);
});

test("shouldCheckForUpdate: false for hunch merge-driver, regardless of TTY — git invokes it once per merged path with fully inherited stdio, installed unconditionally by `hunch init`, so it fires on every ordinary git merge/pull that touches a .hunch/** file, not just conflicts", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "merge-driver", isTTY: true, installed: true, env: {} }), false);
  assert.equal(shouldCheckForUpdate({ commandName: "merge-driver", isTTY: false, installed: true, env: {} }), false);
});

test("shouldCheckForUpdate: false for the other automated-plumbing commands (sync, repair-provenance, hook, ci) — defense in depth: sync/repair-provenance are safe today only because their hook lines happen to background+redirect to /dev/null, so this doesn't depend on that staying true", () => {
  for (const commandName of ["sync", "repair-provenance", "hook", "ci"]) {
    assert.equal(shouldCheckForUpdate({ commandName, isTTY: true, installed: true, env: {} }), false, commandName);
  }
});

test("shouldCheckForUpdate: false when stderr is not a TTY (piped/redirected/spawned — this is the gate every spawnSync(...)-based CLI test in this suite relies on)", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "doctor", isTTY: false, installed: true, env: {} }), false);
});

test("shouldCheckForUpdate: false for any source-checkout shape (tsx dev run or a built dist/npm-link run), even at an interactive TTY — 'npm install -g' is not how it's run", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "doctor", isTTY: true, installed: false, env: {} }), false);
});

test("shouldCheckForUpdate: false when CI is set", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "doctor", isTTY: true, installed: true, env: { CI: "true" } }), false);
});

test("shouldCheckForUpdate: false when HUNCH_NO_UPDATE_CHECK is set", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "doctor", isTTY: true, installed: true, env: { HUNCH_NO_UPDATE_CHECK: "1" } }), false);
});

test("shouldCheckForUpdate: true for an ordinary installed command run at an interactive terminal with no opt-out set", () => {
  assert.equal(shouldCheckForUpdate({ commandName: "doctor", isTTY: true, installed: true, env: {} }), true);
});

test("defaultCacheFile respects XDG_CACHE_HOME when set, falls back to ~/.cache when unset, and NEVER collides with HUNCH_DIR (\".hunch\") either way — a stray ~/.hunch directory would hijack findRoot() (src/core/paths.ts) for any invocation outside a git repo, which is exactly what putting this cache at ~/.hunch/update-check.json did until this was caught in review", () => {
  const original = process.env.XDG_CACHE_HOME;
  try {
    process.env.XDG_CACHE_HOME = "/somewhere/else";
    const withXdg = defaultCacheFile();
    assert.equal(withXdg, join("/somewhere/else", "hunch", "update-check.json"));

    delete process.env.XDG_CACHE_HOME;
    const withoutXdg = defaultCacheFile();
    assert.ok(withoutXdg.endsWith(join(".cache", "hunch", "update-check.json")), withoutXdg);

    for (const file of [withXdg, withoutXdg]) {
      const segments = file.split(/[\\/]/);
      assert.ok(!segments.includes(".hunch"), `cache path must never contain a ".hunch" path segment: ${file}`);
    }
  } finally {
    if (original === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = original;
  }
});

test("checkForUpdate() with no options at all resolves every default — cacheFile, currentVersion, and fetchImpl — this is the exact call shape production uses (src/cli/index.ts)", async () => {
  const scratchCacheHome = mkdtempSync(join(tmpdir(), "hunch-updatecheck-defaults-"));
  const originalXdg = process.env.XDG_CACHE_HOME;
  const originalFetch = globalThis.fetch;
  try {
    process.env.XDG_CACHE_HOME = scratchCacheHome;
    // The only safe way to exercise the `fetchImpl ?? fetch` branch itself
    // without a real network call: replace the global temporarily.
    globalThis.fetch = fakeFetchOk("9999.0.0");
    const result = await checkForUpdate();
    assert.deepEqual(result, { current: HUNCH_VERSION, latest: "9999.0.0" });
    assert.equal(existsSync(join(scratchCacheHome, "hunch", "update-check.json")), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdg;
    rmSync(scratchCacheHome, { recursive: true, force: true });
  }
});

test("formats the update notice with the current and latest versions and an upgrade command", () => {
  const message = formatUpdateNotice({ current: "1.0.0", latest: "1.2.0" });
  assert.match(message, /1\.0\.0/);
  assert.match(message, /1\.2\.0/);
  assert.match(message, new RegExp(`npm install -g ${HUNCH_PACKAGE_NAME.replace("/", "\\/")}@latest`));
  assert.match(message, /HUNCH_NO_UPDATE_CHECK/, "the opt-out must be discoverable from the notice itself, not just the source");
});

test("a spawned CLI invocation never writes the update-check cache to disk — an end-to-end backstop for the preAction wiring as a whole (piped stdio and a source-checkout run both independently block it here; the per-branch shouldCheckForUpdate unit tests above are what isolate each individual gate condition)", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-updatecheck-home-"));
  try {
    const run = spawnSync(process.execPath, hunchCliArgs("doctor"), {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, ".cache") },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(
      existsSync(join(home, ".cache", "hunch", "update-check.json")),
      false,
      "a spawned CLI run must never write the real update-check cache file to disk",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
