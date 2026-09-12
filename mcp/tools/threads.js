/*
 * Thread formation: grouping commits into the lines of work they belong to.
 *
 * A READER of the index, like retrieval - it derives its own weighting and never
 * modifies how the index is built.
 *
 * Three signals, in descending order of how much they should be trusted:
 *
 *   TRAILERS  someone STATED the relation. Ground truth, highest weight.
 *   SCOPE     feat(tools) - the author declared which thread this belongs to.
 *             Weighted below trailers because a broad scope like "canvas" can
 *             cover several unrelated things.
 *   REGIONS   which declarations the commits share. Inference, but the only
 *             signal that works on history nobody annotated - which is what
 *             has to carry any existing repository.
 *
 * All three become weighted edges and Louvain decides the grouping. Scope is
 * deliberately evidence rather than a mandate: forcing every feat(canvas) commit
 * into one thread would rebuild the "Standard" bucket problem in a new costume.
 *
 * Measured caveat: clustering was tested for RANKING and lost badly to direct
 * similarity (precision 0.253 against 0.307). It is used here for GROUPING,
 * which is a different job it did well - V2's communities came out as
 * recognisable topics. Do not wire this into retrieval.
 */

const W_TRAILER = 3.0;
const W_SCOPE = 1.5;
const W_REGION = 2.0;
const KEEP_TOP = 0.20;    // keep the strongest fifth of region-overlap pairs
const MIN_THREAD = 2;     // below this it is a commit, not a thread

/* ─────────────────────────────────────────────── edges */

function regionSim(a, b, idf) {
  let shared = 0, union = 0;
  for (const r of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[r] || 0, y = b[r] || 0, w = idf[r] || 0;
    shared += w * Math.min(x, y);
    union += w * Math.max(x, y);
  }
  return union > 0 ? shared / union : 0;
}

export function buildThreadEdges(index) {
  const commits = index.commits || [];
  const idf = index.regionIdf || {};
  const edges = new Map();

  const add = (a, b, w, source) => {
    if (!a || !b || a === b) return;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (!edges.has(key)) edges.set(key, { a: a < b ? a : b, b: a < b ? b : a, w: 0, sources: {} });
    const e = edges.get(key);
    e.w += w;
    e.sources[source] = (e.sources[source] || 0) + w;
  };

  /* 1. stated relations */
  for (const [from, list] of Object.entries(index.edges || {})) {
    for (const e of list) {
      if (e.kind.startsWith('referenced-by:')) continue;   // the reverse of a link already added
      add(from, e.hash, W_TRAILER, 'trailer');
    }
  }

  /* 2. declared scope */
  const byScope = new Map();
  for (const c of commits) {
    if (!c.scope) continue;
    if (!byScope.has(c.scope)) byScope.set(c.scope, []);
    byScope.get(c.scope).push(c.hash);
  }
  for (const [, hashes] of byScope) {
    /* A scope covering most of the repository says nothing - same reasoning as
     * the word cutoff. Skip it rather than linking everything to everything. */
    if (hashes.length > Math.max(3, commits.length * 0.5)) continue;
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) add(hashes[i], hashes[j], W_SCOPE, 'scope');
    }
  }

  /* 3. region overlap. Candidates come from an inverted index so only commits
   * that actually share a region are ever compared. The cutoff is a percentile
   * of the measured distribution rather than a constant, so it self-scales to
   * whatever repository this runs on. */
  const inverted = new Map();
  for (const c of commits) {
    for (const r of Object.keys(c.regions)) {
      if (!inverted.has(r)) inverted.set(r, []);
      inverted.get(r).push(c.hash);
    }
  }
  const byHash = new Map(commits.map(c => [c.hash, c]));
  const seen = new Set();
  const scored = [];
  for (const [, hashes] of inverted) {
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        const a = hashes[i], b = hashes[j];
        const key = a < b ? a + '|' + b : b + '|' + a;
        if (seen.has(key)) continue;
        seen.add(key);
        scored.push({ a, b, s: regionSim(byHash.get(a).regions, byHash.get(b).regions, idf) });
      }
    }
  }
  const vals = scored.map(x => x.s).sort((x, y) => x - y);
  const cutoff = vals.length ? vals[Math.floor((1 - KEEP_TOP) * (vals.length - 1))] : 0;
  for (const x of scored) {
    if (x.s >= cutoff && x.s > 0) add(x.a, x.b, x.s * W_REGION, 'region');
  }

  return { edges: Array.from(edges.values()), candidates: scored.length, cutoff };
}

/* ─────────────────────────────────────────────── louvain
 * Implemented directly rather than pulled in as a dependency: it is short, this
 * is a component whose output has to be eyeballed, and a black box would make a
 * surprising grouping impossible to diagnose. Node order is sorted so runs are
 * reproducible - same commits in, same threads out, every time. */

function louvain(nodeIds, edgeList) {
  const adj = new Map(nodeIds.map(n => [n, new Map()]));
  for (const { a, b, w } of edgeList) {
    if (!adj.has(a) || !adj.has(b) || a === b) continue;
    adj.get(a).set(b, (adj.get(a).get(b) || 0) + w);
    adj.get(b).set(a, (adj.get(b).get(a) || 0) + w);
  }

  const deg = new Map();
  for (const [n, nbrs] of adj) {
    let d = 0;
    for (const [, w] of nbrs) d += w;
    deg.set(n, d);
  }
  let m = 0;
  for (const d of deg.values()) m += d;
  m /= 2;
  if (m <= 0) return new Map(nodeIds.map(n => [n, n]));

  const comm = new Map(nodeIds.map(n => [n, n]));
  const commTot = new Map(nodeIds.map(n => [n, deg.get(n)]));
  const order = nodeIds.slice().sort();

  let moved = true, guard = 0;
  while (moved && guard++ < 50) {
    moved = false;
    for (const n of order) {
      const nDeg = deg.get(n), cur = comm.get(n);
      const wTo = new Map();
      for (const [nb, w] of adj.get(n)) {
        const c = comm.get(nb);
        wTo.set(c, (wTo.get(c) || 0) + w);
      }
      commTot.set(cur, commTot.get(cur) - nDeg);

      let bestC = cur;
      let bestGain = (wTo.get(cur) || 0) - (commTot.get(cur) * nDeg) / (2 * m);
      for (const [c, w] of wTo) {
        if (c === cur) continue;
        const gain = w - (commTot.get(c) * nDeg) / (2 * m);
        if (gain > bestGain + 1e-12) { bestGain = gain; bestC = c; }
      }

      commTot.set(bestC, commTot.get(bestC) + nDeg);
      if (bestC !== cur) { comm.set(n, bestC); moved = true; }
    }
  }
  return comm;
}

/* ─────────────────────────────────────────────── labelling
 * A word earns a place in a thread's label by recurring inside it AND being at
 * least three times more common there than across the repository. That second
 * half is what stops every thread being labelled with whatever this project
 * says constantly. No model involved - this fell out of the V5 validation and
 * turned out to produce usable names for free. */

function labelThread(members, index) {
  const N = index.count || 1;
  const wordDf = index.wordDf || {};
  const byHash = new Map(index.commits.map(c => [c.hash, c]));
  const docs = members.map(h => new Set((byHash.get(h) || {}).words || []));

  const local = new Map();
  for (const d of docs) for (const w of d) local.set(w, (local.get(w) || 0) + 1);

  /* Scored as local count x corpus idf, NOT as a rate ratio. A ratio rewards
   * whatever is rarest globally, so a word appearing in 2 of 25 commits beats
   * one appearing in 15 of them - which produced labels like "sync · worse ·
   * offers" for a thread that was plainly about git tooling. Multiplying by the
   * local count instead asks for words that are BOTH common in this thread and
   * uncommon elsewhere, which is what a label is. */
  const distinctive = [];
  for (const [w, df] of local) {
    if (df < 2 && docs.length > 1) continue;
    const corpusDf = wordDf[w] || 0;
    if (!corpusDf) continue;
    const localRate = df / docs.length;
    if (localRate < 3 * (corpusDf / N)) continue;        // must still be over-represented
    distinctive.push({ w, score: df * Math.log(N / corpusDf) });
  }
  distinctive.sort((a, b) => b.score - a.score);
  const keywords = distinctive.slice(0, 8).map(x => x.w);

  /* If most of the thread declared the same scope, that is a better name than
   * anything inferred - the author said it outright. */
  const scopes = new Map();
  for (const h of members) {
    const s = (byHash.get(h) || {}).scope;
    if (s) scopes.set(s, (scopes.get(s) || 0) + 1);
  }
  let topScope = null, topN = 0;
  for (const [s, n] of scopes) if (n > topN) { topN = n; topScope = s; }

  if (topScope && topN >= members.length * 0.6) {
    return { name: topScope, keywords, namedBy: 'scope' };
  }
  if (keywords.length) {
    return { name: keywords.slice(0, 3).join(' · '), keywords, namedBy: 'keywords' };
  }

  /* Nothing distinctive in the prose - which happens when every member has a
   * subject like "fixed claude mcp bug" and no body. The code still says where
   * the work was, so fall back to the file the thread actually lives in rather
   * than admitting defeat with "unlabelled". */
  const files = new Map();
  for (const h of members) {
    for (const r of Object.keys((byHash.get(h) || {}).regions || {})) {
      const f = r.split('::')[0];
      files.set(f, (files.get(f) || 0) + 1);
    }
  }
  let topFile = null, topFileN = 0;
  for (const [f, n] of files) if (n > topFileN) { topFileN = n; topFile = f; }

  return { name: topFile || 'unlabelled', keywords, namedBy: topFile ? 'file' : 'none' };
}

function characteristicRegions(members, index, limit = 6) {
  const byHash = new Map(index.commits.map(c => [c.hash, c]));
  const idf = index.regionIdf || {};
  const score = new Map();
  for (const h of members) {
    for (const r of Object.keys((byHash.get(h) || {}).regions || {})) {
      score.set(r, (score.get(r) || 0) + (idf[r] || 0));
    }
  }
  return Array.from(score.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([r]) => r);
}

/* ─────────────────────────────────────────────── entry point */

/**
 * @param {object} index from loadOrBuildIndex
 * @returns {{threads: Array, loose: Array, stats: object}}
 */
export function formThreads(index) {
  const commits = index.commits || [];
  if (!commits.length) return { threads: [], loose: [], stats: { candidates: 0, cutoff: 0 } };

  const { edges, candidates, cutoff } = buildThreadEdges(index);
  const comm = louvain(commits.map(c => c.hash), edges);

  const groups = new Map();
  for (const c of commits) {
    const g = comm.get(c.hash);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c.hash);
  }

  const threads = [];
  const loose = [];
  for (const [, members] of groups) {
    if (members.length < MIN_THREAD) { loose.push(...members); continue; }
    const { name, keywords, namedBy } = labelThread(members, index);
    threads.push({
      id: 't-' + members.slice().sort()[0].slice(0, 8),   // stable: derived from members, not order
      name, keywords, namedBy,
      commits: members,
      regions: characteristicRegions(members, index)
    });
  }

  threads.sort((a, b) => b.commits.length - a.commits.length || (a.id < b.id ? -1 : 1));

  return {
    threads,
    loose,
    links: interThreadLinks(threads, edges),
    relations: statedRelations(index),
    stats: { candidates, cutoff: +cutoff.toFixed(4), edges: edges.length, grouped: commits.length - loose.length }
  };
}

/* Connections BETWEEN threads, which is the only cross-link worth drawing once
 * threads exist - two commits inside one thread are already visibly together,
 * so a line between them adds nothing.
 *
 * Replaces the previous rule, which linked any two commits sharing at least one
 * file, against a hardcoded list of five filenames to ignore. That list guessed
 * wrong: on ter-manager the real noise is app.js (71% of commits), server.js and
 * app.css, none of which were on it - so most pairs qualified, a cap of three
 * admitted an arbitrary subset, and which three survived came down to loop
 * order. Here the weight is the one the clustering already computed, which is
 * idf-weighted, so a shared hub region contributes almost nothing by itself. */
function interThreadLinks(threads, edges, perThread = 2) {
  const owner = new Map();
  for (const t of threads) for (const h of t.commits) owner.set(h, t.id);

  const between = new Map();
  for (const e of edges) {
    const ta = owner.get(e.a), tb = owner.get(e.b);
    if (!ta || !tb || ta === tb) continue;
    const key = ta < tb ? ta + '|' + tb : tb + '|' + ta;
    if (!between.has(key)) {
      between.set(key, { a: ta < tb ? ta : tb, b: ta < tb ? tb : ta, weight: 0, sources: {} });
    }
    const link = between.get(key);
    link.weight += e.w;
    for (const [s, v] of Object.entries(e.sources || {})) link.sources[s] = (link.sources[s] || 0) + v;
  }

  /* Divided by sqrt(sizeA x sizeB): a big thread has more member pairs and would
   * otherwise out-weigh every small one purely by being big, which says nothing
   * about how related the two are. */
  const size = new Map(threads.map(t => [t.id, t.commits.length]));
  for (const l of between.values()) {
    l.strength = +(l.weight / Math.sqrt((size.get(l.a) || 1) * (size.get(l.b) || 1))).toFixed(4);
  }

  /* Top few per thread rather than a global cut, so a small thread is not
   * silently dropped by louder neighbours - then de-duplicated. */
  const ranked = Array.from(between.values()).sort((x, y) => y.strength - x.strength);
  const kept = new Map();
  const count = new Map();
  for (const l of ranked) {
    const ca = count.get(l.a) || 0, cb = count.get(l.b) || 0;
    if (ca >= perThread && cb >= perThread) continue;
    kept.set(l.a + '|' + l.b, l);
    count.set(l.a, ca + 1);
    count.set(l.b, cb + 1);
  }
  return Array.from(kept.values());
}

/* Relations someone STATED in a trailer, as opposed to any the clustering
 * inferred. Empty on a repository that has not adopted the format - which is
 * every repository today - but these are ground truth where everything else on
 * the graph is a guess, and they deserve to be drawn differently. */
function statedRelations(index) {
  const out = [];
  for (const [from, list] of Object.entries(index.edges || {})) {
    for (const e of list) {
      if (e.kind.startsWith('referenced-by:')) continue;
      out.push({ from, to: e.hash, kind: e.kind });
    }
  }
  return out;
}
