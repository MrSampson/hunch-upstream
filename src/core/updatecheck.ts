/** Opt-out-able check for a newer published Hunch release. Wired into the CLI
 *  as a fire-and-forget preAction hook — never awaited, so a slow/unreachable
 *  registry never delays the command's own work (though a pending fetch does
 *  keep the process alive, since node won't exit while a request handle is
 *  open — a cold-cache run against an unreachable registry can still delay
 *  the process's actual exit by up to FETCH_TIMEOUT_MS). Every failure mode
 *  (network, malformed cache, malformed registry response) degrades to
 *  `null`, same posture as the agent hook's own never-block invariant
 *  (con_03a0b94b2e), even though this isn't that hook. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HUNCH_PACKAGE_NAME, HUNCH_VERSION } from "./version.js";

const REGISTRY_URL = `https://registry.npmjs.org/${HUNCH_PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

export interface UpdateCheckResult {
  current: string;
  latest: string;
}

export interface UpdateCheckOptions {
  cacheFile?: string;
  currentVersion?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface UpdateCheckCache {
  lastCheckedAt: number;
  latestSeen: string;
}

/** Deliberately NOT under a `.hunch` directory anywhere on this path: `.hunch`
 *  is HUNCH_DIR (src/core/paths.ts) — the repo-root marker findRoot() walks up
 *  looking for. A stray `~/.hunch` would hijack findRoot() for any invocation
 *  outside a git repo (paths.ts's own docstring names this exact hazard), so
 *  this cache lives under a `hunch` (no dot) segment inside the OS cache
 *  convention instead — a name that can never collide with the repo marker. */
export function defaultCacheFile(): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "hunch", "update-check.json");
}

function readCache(file: string): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdateCheckCache>;
    if (typeof parsed.lastCheckedAt === "number" && typeof parsed.latestSeen === "string") {
      return { lastCheckedAt: parsed.lastCheckedAt, latestSeen: parsed.latestSeen };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(file: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  } catch {
    // Best-effort — a lost cache write just means the next invocation re-checks.
  }
}

/** Split a semver-shaped string into its numeric release core and an optional
 *  prerelease tag. Build metadata (`+...`) is dropped per semver, since it
 *  carries no ordering meaning. */
function parseVersion(v: string): { core: number[]; prerelease: string | null } {
  const withoutBuildMeta = v.split("+")[0] ?? "";
  const [main, ...prereleaseParts] = withoutBuildMeta.split("-");
  return {
    core: (main ?? "").split(".").map((p) => Number.parseInt(p, 10) || 0),
    prerelease: prereleaseParts.length > 0 ? prereleaseParts.join("-") : null,
  };
}

/** True if `a` is a strictly newer semver-shaped version than `b`. Non-numeric
 *  release segments compare as 0, so malformed input degrades to "not newer"
 *  rather than throwing. For an equal release core, only a real release beats
 *  a prerelease of it (`1.0.0` beats `1.0.0-beta.1`) — otherwise an accidental
 *  `latest` dist-tag promotion of a prerelease would tell users already on the
 *  real release to "upgrade" to something older. Two different prereleases of
 *  the same core are deliberately never treated as an upgrade over each other:
 *  the `latest` dist-tag shouldn't produce that case, and full semver
 *  prerelease-identifier precedence (numeric-aware, dot-separated) isn't worth
 *  the complexity for a comparison this narrow. */
function isNewerVersion(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return va.prerelease === null && vb.prerelease !== null;
}

async function fetchLatestVersion(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

export interface UpdateCheckGateOptions {
  commandName: string;
  isTTY: boolean;
  /** Running from an installed/published copy (global, local, or npx cache),
   *  as opposed to any kind of source checkout (`.ts` via tsx, or a built
   *  `dist/` run via `node`/`npm link`) — recommending `npm install -g` only
   *  makes sense in the installed case, so the check is skipped entirely for
   *  every source-checkout shape rather than shown with misleading advice.
   *  Mirrors ResolvedInvocation's own `installed` (src/cli/invocation.ts). */
  installed: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Commands Hunch itself wires into automated plumbing — a git hook, the merge
 *  driver, the MCP server, or CI. `mcp`, `check`, and `merge-driver` are true
 *  plumbing — never a human reading stderr, confirmed against a real
 *  inherited TTY:
 *  - `mcp`: spawned by Claude Code, not a terminal.
 *  - `check`: the pre-commit hook (hooks.ts) runs `check --staged` directly,
 *    with NO backgrounding/redirection — confirmed to inherit a real TTY.
 *  - `merge-driver`: git invokes this once per merged path with fully
 *    inherited stdio (also confirmed against a real TTY) — installed
 *    unconditionally by `hunch init` (mergeDriver.ts), so this fires on every
 *    ordinary `git merge`/`git pull` that touches a `.hunch/**` file, not just
 *    on conflicts.
 *  The rest trade away a legitimate interactive case for a simpler, harder-to-
 *  regress rule than a per-hook marker would be:
 *  - `sync`, `repair-provenance`: the post-commit/post-merge hook lines DO
 *    background and redirect to /dev/null (hooks.ts), so these two are safe
 *    today only incidentally — listed anyway as defense in depth against a
 *    future hook edit that drops the redirect. A human CAN run either by hand
 *    at a TTY; the notice is suppressed there too.
 *  - `hook`: the agent pre-edit hook (Claude Code pipes its stdio, so this is
 *    also incidental, not load-bearing).
 *  - `ci`: NOT something CI runs — it's `hunch ci`, the one-shot scaffolder a
 *    human types once to generate the GitHub Action (the command the Action
 *    itself runs is `check`, already excluded and separately gated by the
 *    `CI` env var below). Excluded because a notice adds nothing to a
 *    scaffolding command, not because it runs unattended. */
const PLUMBING_COMMANDS = new Set(["mcp", "check", "merge-driver", "sync", "repair-provenance", "hook", "ci"]);

/** The single predicate for "should we even attempt a version check" — kept
 *  separate from checkForUpdate and pure so the decision (not just
 *  checkForUpdate's own fetch/cache/compare logic) is unit testable without
 *  spawning a real process or depending on network reachability. Any piped/
 *  redirected/spawned invocation (isTTY false) is also skipped — that's what
 *  keeps this repo's own spawnSync(...)-based CLI tests (piped stdio) from
 *  making a real registry call and writing a real cache file to disk as a
 *  side effect of running the test suite. CI and HUNCH_NO_UPDATE_CHECK are
 *  explicit opt-outs for any other caller. */
export function shouldCheckForUpdate({ commandName, isTTY, installed, env = process.env }: UpdateCheckGateOptions): boolean {
  if (PLUMBING_COMMANDS.has(commandName) || !isTTY || !installed) return false;
  return !env.CI && !env.HUNCH_NO_UPDATE_CHECK;
}

export function formatUpdateNotice(result: UpdateCheckResult): string {
  return (
    `A newer version of hunch is available: ${result.current} -> ${result.latest}\n` +
    `Run \`npm install -g ${HUNCH_PACKAGE_NAME}@latest\` to update. ` +
    "(set HUNCH_NO_UPDATE_CHECK=1 to stop checking)"
  );
}

export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateCheckResult | null> {
  const cacheFile = opts.cacheFile ?? defaultCacheFile();
  const currentVersion = opts.currentVersion ?? HUNCH_VERSION;
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;

  const cached = readCache(cacheFile);
  let latest: string | null;
  if (cached && now() - cached.lastCheckedAt < CHECK_INTERVAL_MS) {
    latest = cached.latestSeen;
  } else {
    latest = await fetchLatestVersion(fetchImpl);
    if (latest === null) return null;
    writeCache(cacheFile, { lastCheckedAt: now(), latestSeen: latest });
  }

  return isNewerVersion(latest, currentVersion) ? { current: currentVersion, latest } : null;
}
