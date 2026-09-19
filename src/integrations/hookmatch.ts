/**
 * The single rule for "is this hook command Hunch's own?", shared by every hook
 * writer (scaffold.ts for Claude Code's .claude/settings.json, providers.ts for
 * Cursor/Codex/VS Code/Windsurf/Antigravity). One rule, because each writer
 * deletes what it classifies as ours, and a writer that guesses wide deletes the
 * user's hooks (con_8460b6770f).
 */

/** Does one command string invoke Hunch's own hook?
 *
 * Anchored to the shapes hookCommand() / resolveInvocation() write — a Hunch
 * launcher (the pinned npm package spec, or a …/dist|src/cli/index.js|ts path for
 * source installs) plus a `hook` tail, tokens quoted or bare. The old unanchored
 * /index\.(js|ts)/ + /\bhook\b/ pair classified FOREIGN entries like
 * `node ./hook/index.js` as ours and silently deleted them, violating the
 * leave-every-foreign-hook-in-place contract (con_8460b6770f, issue #41).
 *
 * `requireProvider` distinguishes the two writers. Provider configs always carry
 * `hook --provider <name>`, so their tail must too; only the LEGACY fully-quoted
 * form (written before the quoting fix, and by hunch versions that predate
 * --provider) may omit it, and its quotes keep it unambiguous. Claude Code's own
 * settings.json never carries --provider, so a bare `hook` tail is all that is
 * left to match on — and a bare tail alone is far too weak, so there the
 * source-install launcher must additionally be a QUOTED path, which is how
 * resolveInvocation renders it. That keeps an unrelated tool which merely shares
 * Hunch's layout (`node tools/lint/dist/cli/index.js hook`) foreign; deleting it
 * was issue #310. */
export function isHunchHookCommand(command: string, requireProvider: boolean): boolean {
  const published = /@davesheffer\/hunch/.test(command);
  if (!requireProvider) {
    const launcher = published || /"[^"]*(?:dist|src)[\\/]+cli[\\/]+index\.(?:js|ts)"/.test(command);
    return launcher && /\s"?hook"?\s*$/.test(command);
  }
  const launcher = published || /(?:dist|src)[\\/]+cli[\\/]+index\.(?:js|ts)(?=["\s]|$)/.test(command);
  const legacyTail = /\s"hook"(?:\s+"--provider"\s+"[a-z]+")?\s*$/.test(command);
  return launcher && (legacyTail || /\s"?hook"?\s+"?--provider"?\s+"?[a-z]+"?\s*$/.test(command));
}
