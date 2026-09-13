/** Stable id helpers. Symbol/component/edge ids are DETERMINISTIC (derived from
 *  their natural key) so re-indexing the same repo yields the same ids and the
 *  git diff of `.hunch/` stays minimal. Decisions/bugs use a content hash too,
 *  so the learning loop is idempotent for the same commit. */
import { createHash } from "node:crypto";
import { currentBranch } from "../extractors/git.js";

export function shortHash(input: string, len = 10): string {
  return createHash("sha1").update(input).digest("hex").slice(0, len);
}

/** Full sha1 (used for signature_hash etc.). */
export function sha1(input: string): string {
  return "sha1:" + createHash("sha1").update(input).digest("hex");
}

/** Symbol id from file + name + kind — deterministic across re-indexes. */
export function symbolId(file: string, name: string, kind: string): string {
  return "sym_" + shortHash(`${file}::${name}::${kind}`);
}

/** Component id from a stable name. */
export function componentId(name: string): string {
  return "cmp_" + shortHash(name.toLowerCase());
}

/** Edge id from its endpoints + type — deterministic, dedupes naturally. */
export function edgeId(from: string, to: string, type: string): string {
  return "edge_" + shortHash(`${from}->${to}:${type}`);
}

/** Stable Engineering Landscape resource identity. The kind remains visible so
 * fragments stay useful without a lookup table; the natural key is normalized
 * only where spelling cannot carry meaning (outer whitespace, path separators,
 * and a trailing slash). Kind-specific discovery may apply stricter canonical
 * rules before calling this helper. */
export function resourceId(kind: string, naturalKey: string): string {
  const normalizedKind = kind.trim().toLowerCase();
  const normalizedKey = naturalKey.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalizedKind}:${normalizedKey}`;
}

/** Resource relationships ride the existing edge graph and therefore share its
 * endpoint/type identity rule. Keeping one helper prevents a parallel graph from
 * minting incompatible relationship ids. */
export function resourceRelationshipId(from: string, to: string, type: string): string {
  return edgeId(from, to, type);
}

/** Decision id. Seed with the CANONICAL full commit sha (the auto-sync and MCP
 *  commit paths both do this, so a recorded decision upgrades the auto-draft for
 *  the same commit), or via manualDecisionId for an ad-hoc MCP decision with no
 *  commit. */
export function decisionId(seed: string): string {
  return "dec_" + shortHash(seed);
}

/** Manual (no-commit) decision id, scoped to the CALLING checkout's current
 *  branch so two same-titled captures on two different branches can't collide
 *  (issue #54): "manual:<branch-or-root>:<title>". Git refuses to check out the
 *  same branch in two worktrees at once, so same-branch re-record still lands
 *  on the same id (the intended draft-upgrade workflow) while cross-branch
 *  captures with the same title now mint different ids. `root` stands in for
 *  the branch in detached HEAD, where there is no branch name to key on. */
export function manualDecisionId(root: string, title: string): string {
  return decisionId(`manual:${currentBranch(root) || root}:${title}`);
}

/** Bug id seeded by symptom/test so the same failure doesn't spawn duplicates. */
export function bugId(seed: string): string {
  return "bug_" + shortHash(seed);
}

/** Runbook id seeded by its task; trim + lowercase so re-capturing the same task
 *  is idempotent rather than minting a duplicate. */
export function runbookId(seed: string): string {
  return "rb_" + shortHash(seed.trim().toLowerCase());
}

/** Constraint id seeded by its statement. Trim + lowercase so trivial
 *  whitespace/case variants of the same rule collapse to one id (idempotent
 *  re-capture), instead of minting a duplicate constraint. */
export function constraintId(statement: string): string {
  return "con_" + shortHash(statement.trim().toLowerCase());
}

/** Finding id seeded by its title (trim + lowercase, same idiom as constraints):
 *  re-recording the same observation UPDATES it (e.g. a triage change) instead of
 *  minting a duplicate. A genuinely new observation deserves a new title. */
export function findingId(title: string): string {
  return "fnd_" + shortHash(title.trim().toLowerCase());
}
