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
 * @param {object} index       from loadOrBuildIndex
 * @param {object} qRegions    region -> share, from stagedRegions
 * @param {string} description one line: what the agent just built
 * @param {number} limit
 */
export function findRelated(index, qRegions, description, limit = 10) {
  /* The same corpus filter the index applied, so a description saying "git" in
   * a git tool does not drag every commit in. Reads the stored counts rather
   * than scanning every commit per query - which is what storing raw df buys. */
  const wordDf = index.wordDf || {};
  const qWords = tokenize(description).filter(w =>
    !index.count || (wordDf[w] || 0) / index.count <= COMMON_WORD_CUTOFF);

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
  const wordSets = new Map(index.commits.map(c => [c.hash, new Set(c.words)]));

  const scored = index.commits.map(c => {
    const rs = hasRegions ? regionScore(qRegions, c.regions, index.regionIdf) : 0;
    const ts = hasWords ? wordScore(qWords, c.words, index.wordIdf) : 0;
    const shared = Object.keys(qRegions).filter(r => c.regions[r] !== undefined);
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
      thread: thread.length ? thread : undefined
    };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return { qWords, results: scored.slice(0, Math.max(1, Math.min(50, limit))) };
}
