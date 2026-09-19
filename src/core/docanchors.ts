/**
 * Markdown topic anchors — decision-grounding for PROSE (the doc≠graph spoke,
 * extended to the files the ecosystem already funnels team knowledge into:
 * AGENTS.md, CLAUDE.md, docs/*.md).
 *
 * A tracked markdown file declares which decision topic a section describes:
 *
 *   <!-- hunch:topic auth.session -->               grounding only
 *   <!-- hunch:topic auth.session dec_a1b2c3d4e5 --> PINNED: prose written against that decision
 *
 * Deterministic by construction: drift fires ONLY on an explicit pin whose
 * decision has been superseded — never on a semantic guess (the same philosophy
 * as `anchor-stale` in drift.ts). Unpinned markers still ground the pre-edit
 * hook but can never fire drift.
 */
import type { Decision } from "./types.js";
import { currentForTopic, rejectedForTopic } from "./topics.js";

export interface DocAnchor {
  topic: string;
  /** The decision id the prose was written against, or null for an unpinned marker. */
  pin: string | null;
  /** 1-based line of the marker in the document. */
  line: number;
}

const MARKER = /<!--\s*hunch:topic\s+([A-Za-z0-9._/-]+)(?:\s+(dec_[A-Za-z0-9]+))?\s*-->/g;

/** Character ranges covered by fenced code blocks (``` or ~~~), so a
 *  documentation EXAMPLE of a marker never registers as a live anchor.
 *  CommonMark-lite: a fence of N chars (≤3 leading spaces) closes only on a
 *  line of ≥N of the same char and nothing else; an unclosed fence runs to
 *  EOF; a backtick fence's info string may not itself contain a backtick.
 *  The "≤3 leading spaces" is measured relative to the enclosing LIST ITEM's
 *  content offset, so a fence indented under `1. step` (issue #331) is still a
 *  fence and not an indented code block. Deliberate limits: no lazy
 *  continuations (a non-blank line indented less than an open item's content
 *  offset ends the item, and with it the fence) and no blockquote containers —
 *  a `>` prefix is still read as ordinary text. With no list open the item
 *  stack is empty, the base is 0 and behaviour is the plain CommonMark-lite
 *  one. Expects LF-normalized text — see parseDocAnchors's normalization; a
 *  caller that skips it re-opens the CRLF fence-detection bug. */
function fencedRanges(text: string): Array<[number, number]> {
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const ranges: Array<[number, number]> = [];
  let open: { ch: string; len: number; start: number; base: number } | null = null;
  // Content offsets (columns) of the currently open list items, outermost first.
  const items: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    // Matching-only copy: tabs in the indent count as 4 columns. Offsets below
    // always come from the ORIGINAL line, never from the probe.
    const probe = line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    "));
    const indent = probe.length - probe.replace(/^ +/, "").length;
    const blank = probe.trim() === "";

    if (open) {
      if (!blank && indent < open.base) {
        // The list item holding the fence ended, which ends the fence too.
        ranges.push([open.start, offset - 1]);
        open = null;
      } else {
        const m = FENCE.exec(probe.slice(Math.min(open.base, indent)));
        if (m && m[1]![0]! === open.ch && m[1]!.length >= open.len && m[2]!.trim() === "") {
          ranges.push([open.start, offset + line.length]);
          open = null;
        }
        offset += line.length + 1;
        continue; // the item stack is frozen while a fence is open
      }
    }

    if (blank) {
      offset += line.length + 1;
      continue; // a blank line neither opens nor closes an item here
    }
    while (items.length && items.at(-1)! > indent) items.pop();
    for (;;) {
      const base = items.at(-1) ?? 0;
      const rest = probe.slice(base);
      if (/^ {0,3}([-*_])( *\1){2,} *$/.test(rest)) break; // thematic break, not a list marker
      const li = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/.exec(rest);
      if (li) {
        // ≥5 spaces after the marker starts an indented code block, so the
        // item's content begins one column after the marker instead.
        const w = li[3]!.length >= 1 && li[3]!.length <= 4 ? li[3]!.length : 1;
        items.push(base + li[1]!.length + li[2]!.length + w);
        continue; // `- 1. x` nests, and "- ```js" opens a fence on the marker line
      }
      const m = FENCE.exec(rest);
      if (m) {
        const ch = m[1]![0]!;
        if (!(ch === "`" && m[2]!.includes("`"))) open = { ch, len: m[1]!.length, start: offset, base };
      }
      break;
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

/** Character ranges covered by inline code spans (`…`), same rationale as
 *  fencedRanges: prose quoting a marker in backticks is showing an example.
 *  CommonMark-lite: an opener run pairs with the next run of the SAME length
 *  on the same line; unpaired runs never open a span.
 *  Expects LF-normalized text — see parseDocAnchors's normalization.
 *  `split("\n")` does not split a bare CR, so on CR-only input the whole
 *  document reads as one line and stray backticks on different lines
 *  falsely pair. */
function inlineSpanRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    let pending: { len: number; start: number } | null = null;
    const runs = /`+/g;
    let m: RegExpExecArray | null;
    while ((m = runs.exec(line))) {
      if (!pending) pending = { len: m[0].length, start: m.index };
      else if (m[0].length === pending.len) {
        ranges.push([offset + pending.start, offset + m.index + m[0].length - 1]);
        pending = null;
      }
    }
    offset += line.length + 1;
  }
  return ranges;
}

/** Parse every hunch:topic marker out of a markdown document. Markers inside
 *  fenced code blocks or inline code spans are examples, not declarations,
 *  and are skipped. */
export function parseDocAnchors(text: string): DocAnchor[] {
  // fencedRanges is CRLF-sensitive (its fence-line regex's `.` excludes \r, so
  // "```\r" never matched at all on a CRLF checkout); inlineSpanRanges is
  // lone-CR-sensitive (split("\n") doesn't split a bare CR — see its
  // docblock). Either way an example marker inside a fence/span registered as
  // a live, pinned anchor. Normalizing both CRLF and lone CR once here keeps
  // fencedRanges/inlineSpanRanges/MARKER offsets consistent with each other
  // and with the line numbers reported below.
  text = text.replace(/\r\n?/g, "\n");
  const out: DocAnchor[] = [];
  const skip = [...fencedRanges(text), ...inlineSpanRanges(text)];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    const at = m.index;
    if (skip.some(([s, e]) => at >= s && at <= e)) continue;
    out.push({ topic: m[1]!, pin: m[2] ?? null, line: text.slice(0, at).split("\n").length });
  }
  return out;
}

const clip = (s: string, n = 220): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Pre-edit grounding for a markdown document that carries topic anchors: the
 *  CURRENT decision per declared topic (graph over prose), what it rejected,
 *  and a stale-pin warning the editor can heal inline. Empty when no anchor
 *  resolves to a decision. */
export function renderDocGrounding(anchors: readonly DocAnchor[], decisions: readonly Decision[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (seen.has(a.topic)) continue;
    seen.add(a.topic);
    const current = currentForTopic(decisions, a.topic);
    if (!current) continue;
    let line = `• topic "${a.topic}" → current decision ${current.id} — "${current.title}": ${clip(current.decision)}`;
    const rejected = rejectedForTopic(decisions, a.topic);
    if (rejected.length) line += `\n    rejected: ${rejected.slice(0, 3).map((r) => clip(r, 90)).join("; ")}`;
    // Scan ALL markers for this topic, not just the first: the topic dedupe must not
    // let an earlier unpinned marker swallow a later marker's stale-pin warning.
    const stalePin = anchors.find((x) => x.topic === a.topic && x.pin && x.pin !== current.id)?.pin;
    if (stalePin) {
      line += `\n    ⚠ this section is PINNED to ${stalePin}, which is no longer current — reconcile the prose with ${current.id}, then re-pin.`;
    }
    parts.push(line);
  }
  if (!parts.length) return "";
  return `🧭 Doc-grounding — this document declares topic anchors; the GRAPH is the source of truth. Follow the current decision, update prose to match it:\n${parts.join("\n")}`;
}
