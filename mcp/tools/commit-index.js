/*
 * The commit index: one artifact, one writer, many readers.
 *
 * Everything downstream - retrieval today, the knowledge graph later - reads
 * this and derives whatever it needs. Nothing downstream modifies how it is
 * built, because two consumers sharing a mutable computation means changing it
 * for one silently changes it for the other.
 *
 * The rule that makes that work: SHARE FACTS, NOT DERIVED VALUES.
 *
 * `regionDf` / `wordDf` are facts - how many commits touched this region, used
 * this word. `regionIdf` / `wordIdf` are one derivation of them, weighted per
 * repository, which is what single-repo retrieval wants. A consumer that needs
 * different weighting - global IDF across five projects, say - recomputes from
 * the raw counts rather than editing the shared one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { SEP_REC, SEP_FLD, parseHunks, toShares, tokenize, parseMessage } from './git-extract.js';

export const COMMON_WORD_CUTOFF = 0.25;   // a word in >25% of commits carries no topic

/* Bumped whenever what an indexed commit CARRIES changes. The cache is keyed by
 * HEAD, and HEAD says nothing about which version of this code built the file:
 * without this, an index written before `root` existed would keep being served
 * for the same HEAD with every root silently missing. */
export const INDEX_VERSION = 2;

export function buildIndex(repoDir) {
  const gitArgs = { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };

  let head = '';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { ...gitArgs, maxBuffer: 1024 }).trim(); } catch (_) {}

  /* pass 1 - metadata and message structure */
  let metaRaw = '';
  try {
    metaRaw = execFileSync('git', ['log', '--no-renames',
      `--pretty=format:${SEP_REC}%H${SEP_FLD}%aI${SEP_FLD}%s${SEP_FLD}%B${SEP_FLD}`], gitArgs);
  } catch (_) {
    return {
      version: INDEX_VERSION,
      head, count: 0, commits: [], edges: {},
      regionDf: {}, wordDf: {}, regionIdf: {}, wordIdf: {}, contextHitRate: 0
    };
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
      root: msg.root,
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
  const preFilterDf = new Map();
  const rawTokens = commits.map(c => {
    const set = new Set([...tokenize(c.subject), ...tokenize(c.body)]);
    for (const w of set) preFilterDf.set(w, (preFilterDf.get(w) || 0) + 1);
    return set;
  });
  const N = commits.length || 1;
  commits.forEach((c, i) => {
    c.words = Array.from(rawTokens[i]).filter(w => (preFilterDf.get(w) || 0) / N <= COMMON_WORD_CUTOFF);
  });

  /* Explicit relation edges, both directions. A trailer is ground truth -
   * someone STATED the relation - where region similarity is only inference.
   * Nothing scores on these yet; they are surfaced so an agent can see a thread
   * rather than an isolated hit, and they are seed material for the graph. */
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

  /* Counts first, weighting second - see the note at the top of this file. */
  const regionDfMap = new Map();
  for (const c of commits) for (const r of Object.keys(c.regions)) regionDfMap.set(r, (regionDfMap.get(r) || 0) + 1);

  const wordDfMap = new Map();
  for (const c of commits) for (const w of c.words) wordDfMap.set(w, (wordDfMap.get(w) || 0) + 1);

  const regionDf = {}, regionIdf = {};
  for (const [r, n] of regionDfMap) { regionDf[r] = n; regionIdf[r] = Math.log(N / n); }

  const wordDf = {}, wordIdf = {};
  for (const [w, n] of wordDfMap) { wordDf[w] = n; wordIdf[w] = Math.log(N / n); }

  return {
    version: INDEX_VERSION,
    head,
    builtAt: new Date().toISOString(),
    count: commits.length,
    contextHitRate: hunksSeen ? +(hunksWithCtx / hunksSeen).toFixed(3) : 0,
    trailerEdges: Object.keys(edges).length,
    commits,
    edges,
    regionDf, wordDf,        // facts
    regionIdf, wordIdf       // one derivation of them, for single-repo retrieval
  };
}

/* The index is a DERIVED CACHE, not state: reconstructible from git alone in
 * under a second, and nothing is lost if it is deleted. So it lives in the OS
 * temp directory, keyed by repository path - NOT in the repo's own .gitx/.
 *
 * That distinction is deliberate. .gitx/ holds things that must survive a clone
 * (issues, worktree assignments) and is worth a .gitignore rule. An index is
 * neither, and writing one there would mean a SEARCH tool silently editing the
 * user's .gitignore and leaving a folder in their working tree. A read tool must
 * not have write side effects on the repository it reads. */
function cachePath(repoDir) {
  const key = crypto.createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'gitx-index', key + '.json');
}

/**
 * Load the cached index, rebuilding when HEAD has moved or the index format has
 * changed. A rebuild is a single linear pass, so the index is rebuilt rather
 * than incrementally patched - which means it can never drift out of sync with
 * the repository it describes.
 */
export function loadOrBuildIndex(repoDir) {
  const file = cachePath(repoDir);
  let head = '';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', maxBuffer: 1024 }).trim(); } catch (_) {}

  try {
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.head && cached.head === head && cached.version === INDEX_VERSION) {
        return { index: cached, rebuilt: false, cache: file };
      }
    }
  } catch (_) { /* unreadable or corrupt cache - fall through and rebuild */ }

  const index = buildIndex(repoDir);
  /* Written to a unique temp name and renamed, because a query and a graph
   * build can run at once: rename is atomic, so a concurrent reader sees either
   * the whole old file or the whole new one, never half of either. */
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) { /* no temp write access - still works, just rebuilds each call */ }

  return { index, rebuilt: true, cache: file };
}
