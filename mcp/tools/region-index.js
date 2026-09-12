/*
 * Sub-file retrieval index over commit history.
 *
 * Answers one question: "I have these changes staged and I am about to describe
 * them this way - what earlier work does that relate to?"
 *
 * Two independent signals, deliberately kept apart until the final blend:
 *
 *   REGIONS  which enclosing declarations a commit edited, read from git's own
 *            hunk headers. Precise, but decays as code is renamed or rewritten.
 *   WORDS    what the commit said it was doing. Survives any refactor, but is
 *            useless when a message reads "updated rails".
 *
 * They were measured to be complementary rather than overlapping: region search
 * reaches only 28% of what word search finds, and word search only 25% of what
 * region search finds. Blending them takes recall@10 on work more than twenty
 * commits back from 0.708 to 0.933.
 *
 * No model, no embeddings, no network. Ranking is deterministic - identical
 * inputs always produce an identical order.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SEP_REC = '\x1e';
const SEP_FLD = '\x1f';

/* Words that describe the ACT of committing rather than its subject. Without
 * this list every commit looks related to every other, because almost all of
 * them say "added" or "fixed". */
const STOP = new Set(`a an the and or but if then than of in on at to for with from by as is are was were be been being
it its this that these those there here now also just only more most some any all no not so such very can will would
add added adds adding fix fixed fixes fixing update updated updates updating change changed changes made make makes
new bug feature support work working use used using into onto out up down when where which what who how why
commit merge remote tracking branch origin main`.split(/\s+/));

const COMMON_WORD_CUTOFF = 0.25;   // a word in >25% of commits carries no topic
const BLEND = 0.5;                 // regions vs words - see note in findRelated

/* ─────────────────────────────────────────────── hunk parsing
 * Used by BOTH the index build and the staged-diff query. It must be one
 * function: if the query normalised a context even slightly differently, its
 * keys would not match the index's and every score would silently be zero. */

export function normalizeContext(raw) {
  let s = (raw || '').trim();
  if (!s) return '';
  s = s.replace(/\s*\{\s*$/, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[=({,;]+\s*$/, '').trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

/**
 * Parse unified-diff text (produced with -U0) into changed lines per region.
 * @param {string} patchText
 * @returns {{regions: Map<string, number>, hunks: number, withContext: number}}
 */
export function parseHunks(patchText) {
  const regions = new Map();
  let curFile = null;
  let curRegion = null;
  let hunks = 0;
  let withContext = 0;

  for (const line of (patchText || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      curFile = m ? m[1] : null;
      curRegion = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('similarity ') || line.startsWith('Binary files')) continue;

    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/);
      if (!m || !curFile) continue;
      hunks++;
      const ctx = normalizeContext(m[1]);
      if (ctx) withContext++;
      /* no usable declaration -> whole-file key. Degrades to file-level
       * resolution for that hunk rather than dropping it. */
      curRegion = curFile + '::' + (ctx || '*');
      if (!regions.has(curRegion)) regions.set(curRegion, 0);
      continue;
    }

    if (curRegion && (line.startsWith('+') || line.startsWith('-'))) {
      regions.set(curRegion, regions.get(curRegion) + 1);
    }
  }
  return { regions, hunks, withContext };
}

/** Changed-line counts -> a distribution summing to 1. */
function toShares(regions) {
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
 *
 * Retrieval only needs tokens, but the knowledge graph this feeds will need the
 * real text and the real edges - so they are stored, not thrown away after
 * counting. Deriving tokens later from stored prose is trivial; recovering prose
 * from tokens is impossible. */

const RELATION_KEYS = new Set(['builds-on', 'fixes', 'supersedes', 'extends', 'refactors', 'relates-to']);

export function parseMessage(subject, rawBody) {
  const out = { type: null, scope: null, body: '', trailers: [] };

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
    if (!RELATION_KEYS.has(key)) continue;
    for (const ref of m[2].split(/[,\s]+/)) {
      const r = ref.trim().replace(/[^0-9a-fA-F]/g, '');
      if (r.length >= 7) out.trailers.push({ kind: key, ref: r.toLowerCase() });
    }
  }

  out.body = lines.slice(0, start).join('\n').trim();
  return out;
}

/* ─────────────────────────────────────────────── index construction */

export function buildIndex(repoDir) {
  const gitArgs = { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };

  let head = '';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { ...gitArgs, maxBuffer: 1024 }).trim(); } catch (_) {}

  /* pass 1 - metadata. \x1f / \x1e are ASCII Unit and Record Separator: a
   * commit body is multi-line by definition, so newline cannot delimit. */
  let metaRaw = '';
  try {
    metaRaw = execFileSync('git', ['log', '--no-renames',
      `--pretty=format:${SEP_REC}%H${SEP_FLD}%aI${SEP_FLD}%s${SEP_FLD}%B${SEP_FLD}`], gitArgs);
  } catch (_) {
    return { head, count: 0, commits: [], regionIdf: {}, wordIdf: {}, contextHitRate: 0 };
  }

  const commits = [];
  const order = new Map();
  for (const rec of metaRaw.split(SEP_REC)) {
    if (!rec.trim()) continue;
    const p = rec.split(SEP_FLD);
    if (p.length < 4) continue;
    const [hash, date, subject, rawBody] = p;
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    const msg = parseMessage(subject, rawBody);
    order.set(hash, commits.length);
    commits.push({
      hash, short: hash.slice(0, 8),
      date: (date || '').slice(0, 10),
      subject: subject || '',
      type: msg.type, scope: msg.scope,
      body: msg.body,
      trailers: msg.trailers,
      regions: {}, words: []
    });
  }

  /* pass 2 - patches, for hunk contexts. -U0 strips context lines so every
   * remaining +/- is a real change and the counts are exact. */
  let hunksSeen = 0, hunksWithCtx = 0;
  try {
    const patchRaw = execFileSync('git', ['log', '-U0', '--patch', '--no-renames', '--no-color',
      `--pretty=format:${SEP_REC}%H`], gitArgs);
    for (const rec of patchRaw.split(SEP_REC)) {
      if (!rec.trim()) continue;
      const nl = rec.indexOf('\n');
      const hash = (nl === -1 ? rec : rec.slice(0, nl)).trim();
      if (!order.has(hash)) continue;
      const { regions, hunks, withContext } = parseHunks(nl === -1 ? '' : rec.slice(nl + 1));
      hunksSeen += hunks;
      hunksWithCtx += withContext;
      commits[order.get(hash)].regions = toShares(regions);
    }
  } catch (_) { /* a repo with no diffable history still indexes on words alone */ }

  /* Word vectors over subject AND body. The body is where the reasoning lives,
   * so excluding it discards the one thing the code cannot express.
   *
   * A long body does not let a commit match everything: the union term in the
   * weighted Jaccard grows with it, so a single shared word against a 200-word
   * body yields a low ratio. Verbosity is self-penalising and needs no cap. */
  const rawDf = new Map();
  const rawTokens = commits.map(c => {
    const set = new Set([...tokenize(c.subject), ...tokenize(c.body)]);
    for (const w of set) rawDf.set(w, (rawDf.get(w) || 0) + 1);
    return set;
  });
  const N = commits.length || 1;
  commits.forEach((c, i) => {
    c.words = Array.from(rawTokens[i]).filter(w => (rawDf.get(w) || 0) / N <= COMMON_WORD_CUTOFF);
  });

  /* Explicit relation edges, both directions. A trailer is ground truth -
   * someone STATED the relation - where region similarity is only inference.
   * Nothing scores on these yet; they are surfaced so the agent can see a
   * thread rather than an isolated hit, and they are the seed material for the
   * knowledge graph that will consume this index later. */
  const byPrefix = (ref) => commits.find(c => c.hash.startsWith(ref));
  const edges = {};
  const push = (from, to, kind) => {
    if (!from || !to || from === to) return;
    (edges[from] = edges[from] || []).push({ hash: to, kind });
  };
  for (const c of commits) {
    for (const t of c.trailers) {
      const target = byPrefix(t.ref);
      if (!target) continue;
      push(c.hash, target.hash, t.kind);
      push(target.hash, c.hash, 'referenced-by:' + t.kind);
    }
  }

  /* IDF for both signals - one number per key, over the whole corpus */
  const regionDf = new Map();
  for (const c of commits) for (const r of Object.keys(c.regions)) regionDf.set(r, (regionDf.get(r) || 0) + 1);

  const regionIdf = {};
  for (const [r, n] of regionDf) regionIdf[r] = Math.log(N / n);

  const wordDf = new Map();
  for (const c of commits) for (const w of c.words) wordDf.set(w, (wordDf.get(w) || 0) + 1);
  const wordIdf = {};
  for (const [w, n] of wordDf) wordIdf[w] = Math.log(N / n);

  return {
    head,
    builtAt: new Date().toISOString(),
    count: commits.length,
    contextHitRate: hunksSeen ? +(hunksWithCtx / hunksSeen).toFixed(3) : 0,
    trailerEdges: Object.keys(edges).length,
    commits,
    edges,
    regionIdf,
    wordIdf
  };
}

/* The index is a DERIVED CACHE, not state: it is reconstructible from git alone
 * in under a second, and nothing is lost if it is deleted. So it lives in the
 * OS temp directory, keyed by repository path - NOT in the repo's own .gitx/.
 *
 * That distinction is deliberate. .gitx/ holds things that must survive a clone
 * (issues, worktree assignments) and is worth adding a .gitignore rule for. An
 * index is neither, and writing one would mean a SEARCH tool silently editing
 * the user's .gitignore and leaving a folder in their working tree. A read tool
 * must not have write side effects on the repository it reads. */
function cachePath(repoDir) {
  const key = crypto.createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'gitx-index', key + '.json');
}

/**
 * Load the cached index, rebuilding when HEAD has moved. A rebuild is a single
 * linear pass, so the index is rebuilt rather than incrementally patched - which
 * means it can never drift out of sync with the repository it describes.
 */
export function loadOrBuildIndex(repoDir) {
  const file = cachePath(repoDir);
  let head = '';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', maxBuffer: 1024 }).trim(); } catch (_) {}

  try {
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.head && cached.head === head) return { index: cached, rebuilt: false, cache: file };
    }
  } catch (_) { /* unreadable or corrupt cache - fall through and rebuild */ }

  const index = buildIndex(repoDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index), 'utf8');
  } catch (_) { /* no temp write access - still works, just rebuilds each call */ }

  return { index, rebuilt: true, cache: file };
}

/* ─────────────────────────────────────────────── query */

export function stagedRegions(repoDir) {
  try {
    const out = execFileSync('git', ['diff', '--cached', '-U0', '--no-renames', '--no-color'],
      { cwd: repoDir, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const { regions } = parseHunks(out);
    return toShares(regions);
  } catch (_) {
    return {};
  }
}

/* Weighted Jaccard, min/max form. min asks "how much do BOTH live here",
 * max asks "how much does EITHER". A commit that merely brushed a region
 * another one lives in scores low, which a plain set overlap cannot express. */
function regionScore(q, c, idf) {
  let shared = 0, union = 0;
  const keys = new Set([...Object.keys(q), ...Object.keys(c)]);
  for (const r of keys) {
    const a = q[r] || 0, b = c[r] || 0, w = idf[r] || 0;
    shared += w * Math.min(a, b);
    union += w * Math.max(a, b);
  }
  return union > 0 ? shared / union : 0;
}

/* Same shape over sets, where every share is 1 or 0 - so min/max collapses to
 * weighted intersection over weighted union. Expressing both the same way is
 * what lets the blend below be a plain average with nothing to calibrate. */
function wordScore(qWords, cWords, idf) {
  const a = new Set(qWords), b = new Set(cWords);
  let shared = 0, union = 0;
  for (const w of new Set([...a, ...b])) {
    const iw = idf[w] || 0;
    if (a.has(w) && b.has(w)) shared += iw;
    union += iw;
  }
  return union > 0 ? shared / union : 0;
}

/**
 * @param {object} index      from loadOrBuildIndex
 * @param {object} qRegions   region -> share, from stagedRegions
 * @param {string} description one line: what the agent just built
 * @param {number} limit
 */
export function findRelated(index, qRegions, description, limit = 10) {
  const qWords = tokenize(description).filter(w => {
    /* apply the corpus filter to the query too, so a description saying "git"
     * in a git tool does not drag every commit in */
    const df = index.commits.filter(c => c.words.includes(w)).length;
    return index.count ? df / index.count <= COMMON_WORD_CUTOFF : true;
  });

  const hasRegions = Object.keys(qRegions).length > 0;
  const hasWords = qWords.length > 0;
  if (!hasRegions && !hasWords) return { qWords, results: [] };

  /* With only one signal present, that signal is the whole score rather than
   * half of it - otherwise every result would be capped at 0.5 for a reason
   * that has nothing to do with relevance. */
  const wR = hasRegions && hasWords ? BLEND : (hasRegions ? 1 : 0);
  const wW = hasRegions && hasWords ? (1 - BLEND) : (hasWords ? 1 : 0);

  const byHash = new Map(index.commits.map(c => [c.hash, c]));
  const edges = index.edges || {};

  const scored = index.commits.map(c => {
    const rs = hasRegions ? regionScore(qRegions, c.regions, index.regionIdf) : 0;
    const ts = hasWords ? wordScore(qWords, c.words, index.wordIdf) : 0;
    const shared = Object.keys(qRegions).filter(r => c.regions[r] !== undefined);

    /* Commits this one explicitly declared a relation to, or that declared one
     * to it. Surfaced, NOT scored: boosting a neighbour because it sits next to
     * a hit is an untested heuristic, and everything else here was measured
     * before it shipped. The agent can see the thread and judge. */
    const thread = (edges[c.hash] || []).map(e => {
      const t = byHash.get(e.hash);
      return t ? { kind: e.kind, short: t.short, subject: t.subject } : null;
    }).filter(Boolean).slice(0, 4);

    return {
      hash: c.hash,
      short: c.short,
      date: c.date,
      subject: c.subject,
      score: +(wR * rs + wW * ts).toFixed(4),
      region_score: +rs.toFixed(4),
      text_score: +ts.toFixed(4),
      shared_regions: shared.slice(0, 5),
      shared_words: qWords.filter(w => c.words.includes(w)),
      /* the WHY - the part no diff can carry. Trimmed, because the agent needs
       * enough to judge relevance, not the whole essay. */
      why: c.body ? (c.body.length > 400 ? c.body.slice(0, 400) + '…' : c.body) : undefined,
      thread: thread.length ? thread : undefined
    };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return { qWords, results: scored.slice(0, Math.max(1, Math.min(50, limit))) };
}
