/*
 * Turning raw git output into structured data. Nothing here scores, ranks or
 * decides anything - these are the shared primitives every consumer parses
 * through, and that is exactly why they live in one file.
 *
 * THIS FILE MUST NOT FORK. If the index built region keys one way and a query
 * built them even slightly differently - a trailing brace kept, whitespace
 * collapsed differently - then `app.js::function paintRail()` and
 * `app.js::function paintRail() {` are different keys, nothing matches, and
 * every score is silently zero. No error, no crash, just an empty result that
 * looks like "nothing is related".
 *
 * Downstream policy (what to weight, what to cut, how to rank) belongs to
 * whichever consumer is asking. Extraction does not.
 */

/* ASCII Unit and Record Separator. Necessary because a commit body is
 * multi-line by definition, so newline cannot delimit records, and commit text
 * may contain any printable character a more obvious delimiter would use. */
export const SEP_REC = '\x1e';
export const SEP_FLD = '\x1f';

/* Words describing the ACT of committing rather than its subject. Without this
 * every commit looks related to every other, because nearly all of them say
 * "added" or "fixed". Shared for the same reason the hunk parser is: two
 * consumers tokenising differently produce vocabularies that cannot be compared. */
const STOP = new Set(`a an the and or but if then than of in on at to for with from by as is are was were be been being
it its this that these those there here now also just only more most some any all no not so such very can will would
add added adds adding fix fixed fixes fixing update updated updates updating change changed changes made make makes
new bug feature support work working use used using into onto out up down when where which what who how why
commit merge remote tracking branch origin main`.split(/\s+/));

const RELATION_KEYS = new Set(['builds-on', 'fixes', 'supersedes', 'extends', 'refactors', 'relates-to']);

/* ─────────────────────────────────────────────── hunk parsing */

export function normalizeContext(raw) {
  let s = (raw || '').trim();
  if (!s) return '';
  s = s.replace(/\s*\{\s*$/, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[=({,;]+\s*$/, '').trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

/**
 * Parse unified-diff text (produced with -U0) into its hunks, each under the
 * region it changed. A region key is `path::enclosing declaration`, taken
 * from git's own hunk header - a NAME, not a coordinate, so it survives the
 * file growing above it.
 *
 * The one place a region key is made: parseHunks counts these for the index,
 * and the code under a commit (commit-code.js) shows their lines, so the code
 * an agent opens is filed under exactly the key the index scored.
 *
 * Each hunk: { file, region, context, file_status ('added' | 'deleted' |
 * null), old: {start, lines}, new: {start, lines}, lines: ['+...', '-...'] }.
 * A binary file is one hunk with binary: true and no lines; it names no region.
 * @param {string} patchText
 */
export function parseHunkBlocks(patchText) {
  const blocks = [];
  let curFile = null;
  let fileStatus = null;
  let cur = null;

  for (const line of (patchText || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      curFile = m ? m[1] : null;
      fileStatus = null;
      cur = null;
      continue;
    }
    if (line.startsWith('new file')) { fileStatus = 'added'; continue; }
    if (line.startsWith('deleted file')) { fileStatus = 'deleted'; continue; }
    if (line.startsWith('Binary files')) {
      if (curFile) blocks.push({ file: curFile, region: curFile + '::*', context: '', file_status: fileStatus, binary: true, lines: [] });
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') ||
        line.startsWith('similarity ')) continue;

    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (!m || !curFile) continue;
      const ctx = normalizeContext(m[5]);
      /* no usable declaration -> whole-file key. Degrades to file-level
       * resolution for that hunk rather than dropping it. */
      cur = {
        file: curFile, region: curFile + '::' + (ctx || '*'), context: ctx, file_status: fileStatus,
        old: { start: +m[1], lines: m[2] === undefined ? 1 : +m[2] },
        new: { start: +m[3], lines: m[4] === undefined ? 1 : +m[4] },
        lines: []
      };
      blocks.push(cur);
      continue;
    }

    if (cur && (line.startsWith('+') || line.startsWith('-'))) cur.lines.push(line);
  }
  return blocks;
}

/**
 * Changed lines per region, for the index.
 * @param {string} patchText
 * @returns {{regions: Map<string, number>, hunks: number, withContext: number}}
 */
export function parseHunks(patchText) {
  const regions = new Map();
  let hunks = 0;
  let withContext = 0;
  for (const b of parseHunkBlocks(patchText)) {
    if (b.binary) continue;
    hunks++;
    if (b.context) withContext++;
    regions.set(b.region, (regions.get(b.region) || 0) + b.lines.length);
  }
  return { regions, hunks, withContext };
}

/** Changed-line counts -> a distribution summing to 1. */
export function toShares(regions) {
  let total = 0;
  for (const n of regions.values()) total += n;
  const out = {};
  for (const [r, n] of regions) out[r] = total > 0 ? n / total : 1 / regions.size;
  return out;
}

export function tokenize(text) {
  return ((text || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(w => !STOP.has(w));
}

/* ─────────────────────────────────────────────── message structure
 * Splits a raw commit message into the three things that matter and keeps them
 * SEPARATE rather than collapsing to tokens:
 *
 *   subject/type/scope  the conventional-commit header, if present
 *   body                the prose - the WHY, which exists nowhere else. Code
 *                       says what changed; only this says what it rules out.
 *   trailers            explicit relations stated by whoever made the commit
 *   root                the name of a feature this commit declared it STARTS
 *                       (GitX-Root) - the bottom of a chain, said outright
 *   thoughts            the thoughts this commit settles (GitX-Thoughts) - the
 *                       broker moves them from the context graph into the
 *                       thought graph when the commit lands (tools/promote.js)
 *
 * Retrieval only needs tokens, but the knowledge graph that will consume this
 * needs the real text and the real edges - so they are kept, not thrown away
 * after counting. Deriving tokens from stored prose later is trivial; recovering
 * prose from tokens is impossible. */

export function parseMessage(subject, rawBody) {
  const out = { type: null, scope: null, body: '', trailers: [], root: null, thoughts: [] };

  const h = (subject || '').match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  if (h) { out.type = h[1].toLowerCase(); out.scope = h[2] ? h[2].toLowerCase() : null; }

  /* %B repeats the subject as its first line - drop it so subject words are not
   * counted twice, which would double their weight for no reason. */
  const lines = (rawBody || '').split(/\r?\n/);
  if (lines.length && lines[0].trim() === (subject || '').trim()) lines.shift();

  /* Trailers are the trailing run of Key: value lines. Every trailer-shaped
   * line is stripped from the body - including Co-Authored-By and Signed-off-by,
   * which would otherwise put "claude", "anthropic" and "noreply" into the
   * vocabulary of every single commit. Only GitX relations become edges. */
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0) {
    const t = lines[start - 1].trim();
    if (!t) break;
    if (!/^[A-Za-z][A-Za-z-]*:\s*\S/.test(t)) break;
    start--;
  }

  for (let i = start; i < end; i++) {
    const m = lines[i].trim().match(/^([A-Za-z][A-Za-z-]*):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/^gitx-/, '');
    /* A root is a NAME, not a reference, so it gets its own field instead of an
     * edge. Before this key was known a GitX-Root line was still trailer-shaped:
     * stripped from the body, then matched no relation - so it vanished from
     * both, which is worse than being ignored. */
    if (key === 'root') {
      if (!out.root) out.root = m[2].trim().toLowerCase();
      continue;
    }
    /* Thought ids, not commit hashes - the hex filter below would turn
     * "t-2be9f7be8d" into a fragment that looks like a hash. Registered here
     * for the same reason as root: an unknown key is stripped and dropped, and
     * a promotion that never runs says nothing. */
    if (key === 'thoughts') {
      for (const id of m[2].toLowerCase().match(/\bt-[0-9a-f]{10}\b/g) || []) if (!out.thoughts.includes(id)) out.thoughts.push(id);
      continue;
    }
    if (!RELATION_KEYS.has(key)) continue;
    for (const ref of m[2].split(/[,\s]+/)) {
      const r = ref.trim().replace(/[^0-9a-fA-F]/g, '');
      if (r.length >= 7) out.trailers.push({ kind: key, ref: r.toLowerCase() });
    }
  }

  out.body = lines.slice(0, start).join('\n').trim();
  return out;
}
