/*
 * Retrieval: "I have these changes staged and I would describe them this way -
 * what earlier work does that relate to?"
 *
 * A READER of the index, never a writer. Nothing here changes how the index is
 * built; if this needed different weighting it would derive it from the raw
 * counts the index stores, not edit the shared computation.
 *
 * Two independent signals, deliberately kept apart until the final blend:
 *
 *   REGIONS  which enclosing declarations a commit edited. Precise, but decays
 *            as code is renamed or rewritten.
 *   WORDS    what the commit said it was doing. Survives any refactor, but is
 *            useless when a message reads "updated rails".
 *
 * Measured complementary rather than overlapping: region search reaches only
 * 28% of what word search finds, word search only 25% of what region search
 * finds. Blending takes recall@10 on work more than twenty commits back from
 * 0.708 to 0.933, and the first genuinely relevant result sits at median rank 1.
 *
 * No model, no embeddings, no network. Ranking is deterministic - identical
 * inputs always produce an identical order.
 */

import { execFileSync } from 'node:child_process';
import { parseHunks, toShares, tokenize } from './git-extract.js';
import { COMMON_WORD_CUTOFF } from './commit-index.js';

const BLEND = 0.5;   // regions vs words - see the note in findRelated

/* KNOWN CHARACTERISTIC of the paths route, recorded rather than patched.
 *
 * coverageScore asks what share of a commit's work fell inside the named area,
 * so a commit confined to that one file scores ~1.0 whether or not it is the
 * relevant one. Observed: asking why trailer relations are surfaced but not
 * scored, with paths ["mcp/tools/retrieval.js"], ranks a later commit that only
 * touched that file at 0.509 while the commit whose body actually answers it
 * sits at 0.020 - rank 3.
 *
 * Lowering the region weight for paths was tried and changed nothing: the gap
 * is 25x, far past what reweighting closes. A real fix has to make coverage
 * account for how SPECIFIC the named area is, and that wants more than three
 * queries to design against.
 *
 * Left alone for now because the outcome is still serviceable - the answering
 * commit landed inside the top 5 in every case tested, and every result now
 * carries its full body, so the agent reads the reason either way. It costs
 * rank, not the answer. */

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

/* ─────────────────────────────────────────────── paths → regions
 *
 * A fresh agent has nothing staged - it has not written anything yet - so
 * stagedRegions() returns empty and the region half, which carries most of the
 * signal, contributes nothing at all. Benchmarks on both repositories ran with
 * every result marked "text only, no shared region" for exactly this reason.
 *
 * What such an agent DOES have, after reading code to orient itself, is a sense
 * of where it is working. This turns that into the missing half.
 *
 * Three ways to name an area, deliberately, because an agent's precision varies
 * with how much it has read:
 *
 *   public/app.js::function applyWallpaper   one declaration, exact
 *   public/app.js                            every region in that file
 *   public/scenes/                           everything beneath a directory
 */
export function regionsFromPaths(index, paths) {
  const want = (paths || []).map((p) => String(p).trim().replace(/\\/g, '/')).filter(Boolean);
  const out = new Set();
  if (!want.length) return out;

  for (const key of Object.keys(index.regionDf || {})) {
    const file = key.split('::')[0];
    for (const p of want) {
      if (key === p) { out.add(key); break; }                       // exact region
      if (file === p) { out.add(key); break; }                      // whole file
      if (p.endsWith('/') && file.startsWith(p)) { out.add(key); break; }   // directory
      if (key.startsWith(p + '::')) { out.add(key); break; }        // file given without ::
    }
  }
  return out;
}

/* Scored differently from a staged diff, and the difference is the point.
 *
 * A staged diff is a DISTRIBUTION - the commit really did put 30% of its lines
 * there - so comparing two distributions with min/max Jaccard is meaningful.
 * A path list is not a distribution. It is a declaration of interest, and
 * pretending otherwise by spreading 1.0 across every region in a file would
 * make a large file score near zero against everything, quietly rebuilding the
 * whole-file problem regions were introduced to solve.
 *
 * So the question asked here is asymmetric and is the one actually being asked:
 * what share of THIS COMMIT's weighted work happened inside the area I named? */
export function coverageScore(wantedRegions, c, idf) {
  let inside = 0, total = 0;
  for (const [r, share] of Object.entries(c.regions || {})) {
    const w = (idf[r] || 0) * share;
    total += w;
    if (wantedRegions.has(r)) inside += w;
  }
  return total > 0 ? inside / total : 0;
}

/* Weighted Jaccard, min/max form. min asks "how much do BOTH live here",
 * max asks "how much does EITHER". A commit that merely brushed a region
 * another one lives in scores low, which a plain set overlap cannot express. */
export function regionScore(q, c, idf) {
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
 * @param {object} index       from loadOrBuildIndex
 * @param {object} qRegions    region -> share, from stagedRegions
 * @param {object} opts
 * @param {object} opts.regions     region -> share, from stagedRegions
 * @param {string} opts.description one line: what the agent built or intends
 * @param {string[]} opts.paths     files, directories or region keys the agent
 *                                  is working in - the region half for someone
 *                                  who has not staged anything yet
 * @param {number} opts.limit
 */
export function findRelated(index, opts = {}) {
  const qRegions = opts.regions || {};
  const description = opts.description || '';
  const limit = opts.limit || 10;

  /* The same corpus filter the index applied, so a description saying "git" in
   * a git tool does not drag every commit in. Reads the stored counts rather
   * than scanning every commit per query - which is what storing raw df buys. */
  const wordDf = index.wordDf || {};
  const qWords = tokenize(description).filter(w =>
    !index.count || (wordDf[w] || 0) / index.count <= COMMON_WORD_CUTOFF);

  const hasStaged = Object.keys(qRegions).length > 0;
  /* Staged work outranks a declared area when both are present: one is evidence
   * of what was actually touched, the other is a statement of intent. */
  const wantedRegions = hasStaged ? null : regionsFromPaths(index, opts.paths);
  const hasPaths = !hasStaged && wantedRegions && wantedRegions.size > 0;

  const hasRegions = hasStaged || hasPaths;
  const hasWords = qWords.length > 0;
  if (!hasRegions && !hasWords) return { qWords, regionSource: 'none', matchedRegions: 0, results: [] };

  /* With only one signal present, that signal is the whole score rather than
   * half of it - otherwise every result would be capped at 0.5 for a reason
   * that has nothing to do with relevance. */
  const wR = hasRegions && hasWords ? BLEND : (hasRegions ? 1 : 0);
  const wW = hasRegions && hasWords ? (1 - BLEND) : (hasWords ? 1 : 0);

  const byHash = new Map(index.commits.map(c => [c.hash, c]));
  const edges = index.edges || {};
  const wordSets = new Map(index.commits.map(c => [c.hash, new Set(c.words)]));

  const scored = index.commits.map(c => {
    const rs = hasStaged ? regionScore(qRegions, c.regions, index.regionIdf)
      : (hasPaths ? coverageScore(wantedRegions, c, index.regionIdf) : 0);
    const ts = hasWords ? wordScore(qWords, c.words, index.wordIdf) : 0;
    const shared = hasStaged
      ? Object.keys(qRegions).filter(r => c.regions[r] !== undefined)
      : (hasPaths ? Object.keys(c.regions || {}).filter(r => wantedRegions.has(r)) : []);
    const cw = wordSets.get(c.hash);

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
      shared_words: qWords.filter(w => cw.has(w)),
      /* The WHY - the part no diff can carry, and the whole reason this tool
       * exists.
       *
       * Previously capped at 400 characters, which was measured to be actively
       * destructive: real commit bodies here run 1,000-2,400 characters, so the
       * cap discarded 60-83% of every one. Retrieval would surface exactly the
       * right commit and then hand back its opening paragraph, with the
       * reasoning the agent asked for cut off below the fold. Correct answer
       * found, correct answer withheld.
       *
       * 1500 covers essentially every real body whole. Anything longer says so
       * and names the commit, because a silent truncation is how the first
       * version went wrong. */
      why: c.body
        ? (c.body.length > 1500
            ? c.body.slice(0, 1500) + '\n[…truncated at 1500 of ' + c.body.length +
              ' chars — run: git show -s --format=%B ' + c.short + ']'
            : c.body)
        : undefined,
      thread: thread.length ? thread : undefined,
      /* Set when this commit declared itself the first commit of a feature
       * (GitX-Root). Nothing earlier in that line of work exists, so a chain
       * followed back through builds-on ends here - and can say so, instead of
       * wandering on into whatever older work happens to share a file. */
      root: c.root || undefined
    };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return {
    qWords,
    /* Which half actually carried the query, so a caller can tell a genuinely
     * weak result from one scored on text alone. */
    regionSource: hasStaged ? 'staged' : (hasPaths ? 'paths' : 'none'),
    matchedRegions: hasStaged ? Object.keys(qRegions).length : (hasPaths ? wantedRegions.size : 0),
    results: scored.slice(0, Math.max(1, Math.min(50, limit)))
  };
}
