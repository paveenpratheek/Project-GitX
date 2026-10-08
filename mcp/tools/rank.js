/*
 * The ranking engine: one answer to "given this, what is most relevant, and
 * why?" - over every commit, settled thought and waiting thought at once.
 *
 * Decided 28 September (t-d69e5f5910). Before it, four scorers answered the
 * same question with four sets of rules - searchThoughts and similarThoughts
 * in thought-query.js, findRelated in retrieval.js, suggestTopics in
 * topics.js - so a fix to one never reached the others, and a decision said
 * in other words than its duplicate was missed by all of them (t-772fc78f0b,
 * recorded again as t-8b53b17a98).
 *
 * A READER, like everything in this folder: it builds its index from the
 * commit index and the thought files and never writes either. No model, no
 * embeddings, no network, and the order is deterministic - the same graph and
 * the same query always give the same list.
 *
 * Four stages per query:
 *
 *   candidates  word, region and topic postings, plus the neighbours of the
 *               strongest word hits and of any ids the caller names
 *   signals     each 0..1: words, regions, topic, topic affinity, links, active
 *   score       a weighted mean of the signals the query could offer
 *   shape       each result with the reasons it ranked
 *
 * Version 1 has the signals that exist today. Earned words and learned
 * weights need the hook event log (t-3a272ff25b) and come with it. Every
 * weight here is judged by mcp/rank-eval.js against real questions before it
 * changes, the house rule retrieval.js states: measured before it ships.
 */

import { loadOrBuildIndex } from './commit-index.js';
import { loadThoughts, laterOf, asksQuestion } from './thoughts.js';
import { loadTopics, loadGoal, domainOf } from './topics.js';
import { tokenize } from './git-extract.js';
import { regionsFromPaths, coverageScore, regionScore } from './retrieval.js';
import { learnedFor } from './learn.js';

/* Hand-set first (t-6c830b6b34); learned from outcomes once there are any. */
export const WEIGHTS = {
  words: 1,       // the query's rarer words, found in the node
  regions: 1,     // the code the query names, touched by the node
  topic: 0.5,     // the node is in the topic the caller names
  affinity: 0.2,  // the node is in a topic the strongest word hits share
  link: 0.3,      // the node is linked to a strong hit or a named id
  active: 0.05    // a waiting thought in the goal's topics
};
/* Affinity and active say where a node sits, not what it is about, so they
 * only add to a node with evidence of its own - words, code, a link, or the
 * topic the caller named. Given to every node in a topic they lifted all of
 * it alike, and the words stopped deciding the order (first run, 28 Sep). */

const PREFIX_MIN = 4;        // "tunnels" finds "tunnel", as thought search does
const REST = 0.5;            // a word in forces or a commit body, against its own text
const LINK_SEEDS = 8;        // strongest word hits whose neighbours are pulled in
const AFFINITY_SEEDS = 10;   // strongest word hits that vote for a topic
const TEXT_CAP = 220;

const cap = (s, n = TEXT_CAP) => (!s || s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');

/* One form per word, so "offers" meets "offered" and "knows" is not counted
 * again beside "know" - the suffixes topics.js strips for its suggestions,
 * never below three letters. */
export function stem(w) {
  const m = w.match(/^(.{3,}?)(ings|ing|ies|es|s|ed)$/);
  return m ? m[1] : w;
}
const stems = (text) => tokenize(text).map(stem);

/* ─────────────────────────────────────────────── the index */

export function buildRankIndex(repoDir, { commitIndex } = {}) {
  const index = commitIndex || loadOrBuildIndex(repoDir).index;
  const nodes = new Map();
  const adj = new Map();
  const link = (a, b, type) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ to: b, type });
    adj.get(b).push({ to: a, type: 'by:' + type });
  };

  const commitOf = new Map(index.commits.map((c) => [c.hash, c]));
  for (const c of index.commits) {
    const own = new Set(stems(c.subject));
    nodes.set(c.hash, {
      id: c.hash, short: c.short, layer: 'commit', kind: 'commit', text: c.subject,
      created: c.date, own, rest: new Set(c.words.map(stem).filter((w) => !own.has(w))),
      regions: c.regions || {}, topic: null
    });
  }
  for (const [from, list] of Object.entries(index.edges || {})) {
    for (const e of list) if (!e.kind.startsWith('referenced-by:')) link(from, e.hash, e.kind);
  }

  const { topics } = loadTopics(repoDir);
  const { goal } = loadGoal(repoDir);
  for (const [store, layer] of [['thought', 'thought'], ['context', 'context']]) {
    for (const t of loadThoughts(repoDir, { store }).thoughts) {
      const commit = t.resulted_in && t.resulted_in.commit;
      const forces = (t.forces || []).map((f) => f.text + ' ' + (f.revisit_if || '')).join(' ');
      const own = new Set(stems(t.text));
      nodes.set(t.id, {
        id: t.id, layer, kind: t.kind, outcome: t.outcome, decided_by: t.decided_by || null,
        text: t.text, created: t.created || null,
        /* What held a rejected idea back, so it is not proposed again unanswered. */
        held: (t.forces || []).filter((f) => f.direction === 'backward').map((f) => f.text),
        own, rest: new Set(stems(forces).filter((w) => !own.has(w))),
        /* A settled thought borrows the code its commit touched (t-dca06fa7aa);
         * a waiting one has none yet. */
        regions: commit && commitOf.has(commit) ? commitOf.get(commit).regions : {},
        topic: t.topic || null, domain: domainOf(t), placedIn: t.domain || null, commit: commit || null
      });
      for (const l of t.links || []) link(t.id, l.to, l.type);
      for (const f of t.forces || []) for (const id of f.cites || []) link(t.id, id, 'cites');
      if (commit) link(t.id, commit, 'settled-by');
    }
  }

  /* A thought's domain takes what became of it (t-4b3d8c6970), which is known
   * only once every link is in: an answered question is no longer in Bugs &
   * open questions. */
  for (const n of nodes.values()) {
    if (n.layer === 'commit') continue;
    const incoming = (adj.get(n.id) || []).filter((e) => e.type.startsWith('by:')).map((e) => ({ type: e.type.slice(3), from: e.to }));
    n.domain = domainOf({ outcome: n.outcome, kind: n.kind, domain: n.placedIn }, laterOf(incoming, (id) => (nodes.get(id) || {}).commit || null));
  }

  /* Postings over own and rest words together; which of the two a word is in
   * is looked up per node when scoring. */
  const postings = new Map();
  for (const n of nodes.values()) {
    for (const w of new Set([...n.own, ...n.rest])) {
      if (!postings.has(w)) postings.set(w, new Set());
      postings.get(w).add(n.id);
    }
  }
  const regionIdf = index.regionIdf || {};

  return {
    repoDir, nodes, adj, postings, vocab: [...postings.keys()], regionIdf, commitIndex: index,
    topics: new Map(topics.map((t) => [t.id, t])), goal,
    builtAt: new Date().toISOString()
  };
}

/* ─────────────────────────────────────────────── a query */

/* Which vocabulary stems a query stem stands for: itself, and any stem it is a
 * prefix of or that is a prefix of it, once both are long enough to mean it. */
function expand(ix, q) {
  const out = [];
  for (const w of ix.vocab) {
    if (w === q || (Math.min(w.length, q.length) >= PREFIX_MIN && (w.startsWith(q) || q.startsWith(w)))) out.push(w);
  }
  return out;
}

/* Words, with the idf of what each query word stands for among live nodes.
 * `also` is secondary text - a draft's reasons beside its sentence - and
 * counts at the weight a node's own reasons do. One stem is one word however
 * many forms of it the query uses.
 *
 * A node's word score is a similarity in the sense t-0db141dc7d asks for: the
 * idf of the question's words the node holds over the idf of all of them the
 * graph knows, 1.0 when every meaning-bearing word is in its own text, so 70%
 * means the same for every question. rank() and pull() both read it here. */
function wordStage(ix, text, also, alive) {
  const N = [...ix.nodes.values()].filter(alive).length || 1;
  const shown = new Map();       // stem -> the word as the query wrote it
  const want = new Map();        // stem -> 1 for the text, REST for `also`
  for (const [src, weight] of [[also, REST], [text, 1]]) {
    for (const w of tokenize(String(src || ''))) {
      const s = stem(w);
      if (!shown.has(s) || weight === 1) shown.set(s, w);
      want.set(s, Math.max(want.get(s) || 0, weight));
    }
  }
  const per = [];
  const unmatched = [];
  for (const [q, weight] of want) {
    const forms = expand(ix, q);
    const hits = new Set();
    for (const f of forms) for (const id of ix.postings.get(f) || []) if (alive(ix.nodes.get(id))) hits.add(id);
    if (!hits.size) { if (weight === 1) unmatched.push(shown.get(q)); continue; }
    per.push({ q: shown.get(q), forms: new Set(forms), hits, idf: weight * Math.log((N + 1) / (hits.size + 0.5)) });
  }
  const idfTotal = per.reduce((s, p) => s + p.idf, 0);
  const words = new Map();       // id -> { s, matched: [q] }
  for (const p of per) {
    for (const id of p.hits) {
      const n = ix.nodes.get(id);
      const inOwn = [...p.forms].some((f) => n.own.has(f));
      const w = words.get(id) || { s: 0, matched: [] };
      w.s += p.idf * (inOwn ? 1 : REST);
      w.matched.push({ q: p.q, idf: p.idf, own: inOwn });
      words.set(id, w);
    }
  }
  for (const w of words.values()) w.s = idfTotal > 0 ? w.s / idfTotal : 0;
  return { per, words, unmatched };
}

/**
 * @param ix     from buildRankIndex
 * @param query
 *   text     words: a prompt, a question, a draft thought
 *   ids      nodes the caller is on or is linking to - their neighbours rank higher
 *   paths    files, directories or file::declaration the caller works in
 *   regions  region -> share, a staged diff (outranks paths, as in findRelated)
 *   topic    the topic the caller is filing under
 *   before   only nodes that existed before this time (ISO) - for replaying a
 *            past moment, as the evaluation does
 *   exclude  ids never to return (the thought being recorded)
 *   layers   ['commit', 'thought', 'context'] to limit what comes back
 *   limit    how many to return
 */
export function rank(ix, query = {}) {
  const text = String(query.text || '');
  const given = (query.ids || []).filter((id) => ix.nodes.has(id));
  const skip = new Set(query.exclude || []);
  const before = query.before || null;
  const layers = query.layers || null;
  const outcomes = query.outcome && query.outcome.length ? query.outcome : null;
  const kinds = query.kind && query.kind.length ? query.kind : null;
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
  const alive = (n) => n && !skip.has(n.id) && (!layers || layers.includes(n.layer)) &&
    (!outcomes || outcomes.includes(n.outcome)) && (!kinds || kinds.includes(n.kind)) &&
    (!before || !n.created || n.created < before);
  /* ① words */
  const { per, words, unmatched } = wordStage(ix, text, query.also, alive);

  /* ② regions: a staged diff is a distribution, a path list is a declaration
   * of interest - scored the two ways findRelated scores them. */
  const staged = query.regions && Object.keys(query.regions).length ? query.regions : null;
  const wanted = staged ? null : regionsFromPaths(ix.commitIndex, query.paths);
  const hasRegions = !!staged || (wanted && wanted.size > 0);
  const regionOf = (n) => {
    if (!hasRegions || !Object.keys(n.regions).length) return 0;
    return staged ? regionScore(staged, n.regions, ix.regionIdf) : coverageScore(wanted, n, ix.regionIdf);
  };

  /* ③ seeds: the strongest word hits and the named ids, for links and topics */
  const byWords = [...words.entries()].sort((a, b) => b[1].s - a[1].s);
  const top = byWords.length ? byWords[0][1].s : 0;
  /* A link carries the strength of the hit it comes from: a named id gives
   * full strength, a word hit gives its own word score. A flat bonus let the
   * neighbours of the best hit outrank the hit itself (first run, 28 Sep). */
  const linkSeed = new Map(given.map((id) => [id, 1]));
  for (const [id, w] of byWords.slice(0, LINK_SEEDS)) if (top > 0) linkSeed.set(id, Math.max(linkSeed.get(id) || 0, w.s));
  const topicVote = new Map();
  for (const [id, w] of byWords.slice(0, AFFINITY_SEEDS)) {
    const t = ix.nodes.get(id).topic;
    if (t) topicVote.set(t, (topicVote.get(t) || 0) + w.s);
  }
  for (const id of given) {
    const t = ix.nodes.get(id).topic;
    if (t) topicVote.set(t, (topicVote.get(t) || 0) + (top || 1));
  }
  const voteTop = Math.max(0, ...topicVote.values());

  /* ④ candidates */
  const cand = new Set(words.keys());
  if (hasRegions) for (const n of ix.nodes.values()) if (regionOf(n) > 0) cand.add(n.id);
  for (const id of linkSeed.keys()) for (const e of ix.adj.get(id) || []) cand.add(e.to);
  const topicIds = new Set([query.topic, ...[...topicVote.entries()].filter(([, v]) => v >= voteTop * 0.5).map(([t]) => t)].filter(Boolean));
  for (const n of ix.nodes.values()) if (n.topic && topicIds.has(n.topic)) cand.add(n.id);

  const W = WEIGHTS;
  const present = {
    words: per.length > 0, regions: hasRegions, topic: !!query.topic,
    affinity: voteTop > 0, link: linkSeed.size > 0, active: !!(ix.goal && ix.goal.topics.length)
  };
  const denom = Object.keys(W).reduce((s, k) => s + (present[k] ? W[k] : 0), 0) || 1;

  const scored = [];
  for (const id of cand) {
    const n = ix.nodes.get(id);
    if (!alive(n) || given.includes(id)) continue;
    const w = words.get(id);
    const sig = {
      words: w ? w.s : 0,
      regions: regionOf(n),
      topic: query.topic && n.topic === query.topic ? 1 : 0,
      affinity: n.topic && voteTop > 0 ? (topicVote.get(n.topic) || 0) / voteTop : 0,
      link: 0,
      active: n.layer === 'context' && ix.goal && n.topic && ix.goal.topics.includes(n.topic) ? 1 : 0
    };
    let via = null;
    for (const e of ix.adj.get(id) || []) {
      const s = linkSeed.get(e.to);
      if (s && s > sig.link) { sig.link = s; via = e; }
    }
    if (!(sig.words || sig.regions || sig.link || sig.topic)) { sig.affinity = 0; sig.active = 0; }
    const score = Object.keys(W).reduce((s, k) => s + (present[k] ? W[k] * sig[k] : 0), 0) / denom;
    if (score <= 0) continue;
    scored.push({ n, sig, via, w, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.sig.words - a.sig.words) || String(b.n.created).localeCompare(String(a.n.created)));

  return {
    words: per.map((p) => p.q),
    unmatched,
    signals: Object.keys(present).filter((k) => present[k]),
    candidates: cand.size,
    matched: scored.length,
    results: scored.slice(0, limit).map((r) => shape(ix, r))
  };
}

/* ─────────────────────────────────────────────── the pull */

/*
 * A question answered with a stack, not a cut list (t-8e3f4c2aa9). Every
 * node whose word similarity reaches ENTRY_AT is an entry (t-0db141dc7d);
 * every link in every layer is a string pulled from the entries out to
 * PULL_HOPS, and a node's support is the sum over the entries of 0.5 per hop
 * (t-7e316ab799) - many short strings make the core, one long string the
 * edge. A shared topic ties too, as weakly as three hops. Nothing is dropped:
 * what words alone found and no string reached comes back too, as its own
 * group.
 *
 * Judged by rank-eval.js on the owner's 18 questions: first place 11, the top
 * ten 18 and every answer shown in full, MRR 0.755 against rank()'s 0.752 on
 * the same graph once a node's own match counts in the order (both move as
 * the graph grows) - and for "what is
 * the 4th dimension" every one of its 113 nodes on the stack, the first 40
 * 95% on it. Similarity-weighted entries, 3 hops and half-weight commit links
 * were each no better and are not here. Neither is widening by the words the
 * entries repeat (t-8661f9e247): on the stack it found nothing the pull had
 * not, for all 18 questions and the 4th Dimension.
 *
 * Two things the decisions did not say, decided while building: with no node
 * at ENTRY_AT the search enters at the closest (within 80% of the best) and
 * says so - 7 of the 18 questions have none; and a node words found that no
 * string reaches is kept as "words only", or the pull would lose answers
 * rank() finds (the sidebar commit 5d27166 is linked to nothing).
 */
export const ENTRY_AT = 0.7;
export const PULL_HOPS = 4;
export const CORE_AT = 1;        // support at which a node comes back in full - one entry's worth
const CLOSEST = 0.8;
const CLOSEST_MAX = 5;
const HOP = 0.5;
const TOPIC_TIE = 3;         // a shared topic ties as strongly as a string 3 hops long
const SIM_IN_ORDER = 1;      // a node's own word match counts beside its support in the order

/**
 * @param query  text, ids, paths, hops (1-6), layers, outcome, kind, exclude,
 *               entryAt (for measuring)
 * @returns { words, unmatched, entries, closest, hops, pulled, core, edge,
 *            wordsOnly } - each row { n, support, reach, hop, sim, entry, via, w }
 */
export function pull(ix, query = {}) {
  const hops = Math.max(1, Math.min(6, Number(query.hops) || PULL_HOPS));
  const entryAt = query.entryAt != null ? query.entryAt : ENTRY_AT;
  const { per, words, unmatched } = wordStage(ix, String(query.text || ''), '', () => true);
  /* A word the graph does not hold still belongs to the question: it counts in
   * the similarity at the rarest weight, so no node is 100% of a question it
   * holds half of. Without it "zzzqqq nothing here" entered at 42 nodes that
   * say "nothing". Here only: rank() mixes the word score with other signals
   * and is judged as it is. */
  const known = per.reduce((s, p) => s + p.idf, 0);
  const missing = unmatched.length * Math.log((ix.nodes.size + 1) / 0.5);
  if (missing && known) for (const w of words.values()) w.s = (w.s * known) / (known + missing);

  /* ① entries: by words, by name, by the code a commit touched */
  const entry = new Map();
  for (const [id, w] of words) if (w.s >= entryAt) entry.set(id, { by: 'words', sim: w.s });
  const wanted = regionsFromPaths(ix.commitIndex, query.paths);
  if (wanted && wanted.size) {
    for (const n of ix.nodes.values()) {
      if (n.layer !== 'commit' || !Object.keys(n.regions).length) continue;
      const cov = coverageScore(wanted, n, ix.regionIdf);
      if (cov >= entryAt && !entry.has(n.id)) entry.set(n.id, { by: 'code', sim: cov });
    }
  }
  for (const id of query.ids || []) if (ix.nodes.has(id)) entry.set(id, { by: 'named', sim: 1 });
  /* Nothing at ENTRY_AT: the question is vaguer than the graph, so enter at
   * the closest few - those within 80% of the best, CLOSEST_MAX at most, the
   * best first and a node's own text before its reasons. */
  let closest = null;
  if (!entry.size && words.size) {
    const best = Math.max(...[...words.values()].map((w) => w.s));
    const own = (w) => w.matched.filter((m) => m.own).length;
    [...words].filter(([, w]) => w.s >= best * CLOSEST)
      .sort((a, b) => b[1].s - a[1].s || own(b[1]) - own(a[1]) || String(ix.nodes.get(b[0]).created).localeCompare(String(ix.nodes.get(a[0]).created)))
      .slice(0, CLOSEST_MAX)
      .forEach(([id, w]) => entry.set(id, { by: 'words', sim: w.s }));
    closest = best;
  }

  /* ② strings: every link, both ways, out to `hops` - from each entry at full
   * strength, and from every weaker word match (RELATED_FLOOR and up) at half
   * its similarity. Without them a node one link from a 60% match was lost
   * though rank() finds it - the sidebar commit 5d27166 - and three of the
   * owner's answers fell to the edge: MRR 0.645 and one lost, against 0.668,
   * 18 in the top ten and none lost with them (rank() 0.684, 17, none). */
  const weak = query.weak !== undefined ? query.weak : { from: RELATED_FLOOR, scale: 0.5 };
  const pullFrom = new Map([...entry.keys()].map((id) => [id, 1]));
  if (weak) for (const [id, w] of words) if (!entry.has(id) && w.s >= weak.from) pullFrom.set(id, w.s * weak.scale);
  /* Words agents' declared paths learned for this question's key
   * (t-4f44aa05bb) pull as weak matches do - never as entries, so what was
   * learned widens the search and never decides it (t-11190c437f). */
  if (weak && query.learnedWords && query.learnedWords.length) {
    for (const [id, w] of wordStage(ix, query.learnedWords.join(' '), '', () => true).words) {
      if (entry.has(id) || w.s < weak.from) continue;
      pullFrom.set(id, Math.max(pullFrom.get(id) || 0, w.s * weak.scale));
    }
  }
  const got = new Map();
  for (const [e, strength] of pullFrom) {
    const seen = new Map([[e, { h: 0 }]]);
    let front = [e];
    for (let h = 1; h <= hops; h++) {
      const next = [];
      for (const id of front) {
        for (const x of ix.adj.get(id) || []) {
          if (seen.has(x.to)) continue;
          seen.set(x.to, { h, from: id, type: x.type });
          next.push(x.to);
        }
      }
      front = next;
    }
    /* A shared topic is a string too: every node in the entry's topic that no
     * link reached is tied in as if TOPIC_TIE hops away. Thoughts nobody linked
     * still sit in the topic they are about - 17 of the 4th Dimension's 113,
     * its "three layers" definition among them, were on no string; tied, all
     * 113 are on the stack, and the owner's questions improved (MRR 0.698 to
     * 0.729, all 18 still shown in full). A topic is a curated domain, so it
     * ties weaker than a link and never more than once. */
    const tie = query.topicTie !== undefined ? query.topicTie : TOPIC_TIE;
    const t = tie && ix.nodes.get(e).topic;
    if (t) for (const n of ix.nodes.values()) if (n.topic === t && !seen.has(n.id)) seen.set(n.id, { h: tie, from: e, type: 'topic' });
    for (const [id, p] of seen) {
      const c = strength * HOP ** p.h;
      const g = got.get(id) || { support: 0, reach: 0, hop: Infinity, best: 0, via: null };
      g.support += c;
      g.reach++;
      g.hop = Math.min(g.hop, p.h);
      if (p.from && c > g.best) { g.best = c; g.via = { from: p.from, type: p.type }; }
      got.set(id, g);
    }
  }

  /* ③ what comes back: filters decide what is shown, never what is walked */
  const skip = new Set(query.exclude || []);
  const list = (v) => (v && v.length ? v : null);
  const layers = list(query.layers), outcomes = list(query.outcome), kinds = list(query.kind);
  const shown = (n) => !skip.has(n.id) && (!layers || layers.includes(n.layer)) &&
    (!outcomes || outcomes.includes(n.outcome)) && (!kinds || kinds.includes(n.kind));
  const row = (id, g) => {
    const w = words.get(id);
    return { n: ix.nodes.get(id), support: g ? g.support : 0, reach: g ? g.reach : 0, hop: g ? g.hop : null,
      sim: w ? w.s : 0, w, entry: entry.get(id) || null, via: g ? g.via : null };
  };
  /* The order is support plus the node's own word match. By support alone a
   * hub many strings reach outranked the thought that says the question
   * outright - "agents read the context graph only when they ask for it" fell
   * to second behind a hub by 0.01 as the graph grew - MRR 0.701 on the
   * owner's 18; adding the match at equal weight gave 0.755, first place 11,
   * for 88% to 84% on topic in the 4th Dimension's first 25. At double
   * weight 0.759 and 72%. */
  const simW = query.simInOrder != null ? query.simInOrder : SIM_IN_ORDER;
  const key = (r) => r.support + simW * r.sim;
  const order = (a, b) => key(b) - key(a) || b.sim - a.sim || String(b.n.created).localeCompare(String(a.n.created));
  const core = [], edge = [];
  for (const [id, g] of got) {
    const r = row(id, g);
    if (!shown(r.n)) continue;
    (r.entry || g.support >= CORE_AT ? core : edge).push(r);
  }
  const wordsOnly = [...words.keys()].filter((id) => !got.has(id) && words.get(id).s >= RELATED_FLOOR)
    .map((id) => row(id, null)).filter((r) => shown(r.n)).sort((a, b) => b.sim - a.sim);
  core.sort(order);
  edge.sort(order);
  return {
    words: per.map((p) => p.q), unmatched, hops,
    entries: entry.size, entered_by: [...entry.values()].reduce((m, e) => ((m[e.by] = (m[e.by] || 0) + 1), m), {}),
    closest, pulled: got.size, core, edge, wordsOnly
  };
}

/* Why a pulled node is on the stack, in one line. */
function pullWhy(ix, r) {
  const out = [];
  if (r.entry) out.push('entry: ' + (r.entry.by === 'named' ? 'named' : r.entry.by === 'code' ? 'touches the named code' : 'words ' + pct(r.entry.sim)));
  else if (r.w) out.push('words ' + pct(r.sim));
  if (r.reach) out.push('support ' + r.support.toFixed(2) + ' from ' + r.reach + ' entr' + (r.reach === 1 ? 'y' : 'ies') + (r.hop ? ', nearest ' + r.hop + ' hop' + (r.hop === 1 ? '' : 's') : ''));
  if (r.via) {
    out.push(r.via.type === 'topic' ? 'shares the topic ' + topicName(ix, r.n.topic) + ' with ' + label(ix, r.via.from)
      : r.via.type.startsWith('by:') ? label(ix, r.via.from) + ' ' + r.via.type.slice(3) + ' it'
      : 'it ' + r.via.type + ' ' + label(ix, r.via.from));
  }
  return out.join(' · ');
}
const pct = (s) => Math.round(s * 100) + '%';

/* ─────────────────────────────────────────────── callers */

/* For a thought being recorded: what on record it most likely continues,
 * repeats, answers or contradicts. Thoughts only - a link can name nothing
 * else - and never the thoughts it already links to, which the caller passes
 * as ids so their neighbours rank higher. The floor keeps a weak word match
 * from being offered as a relation; mcp/rank-eval.js replays real records
 * through this same function with no floor, to see where the answer sat. */
export const RELATED_FLOOR = 0.35;
export function relatedToDraft(ix, { text, also = '', ids = [], exclude = [], topic = null, before = null, limit = 4, floor = RELATED_FLOOR } = {}) {
  const out = rank(ix, { text, also, ids, exclude, topic, before, layers: ['thought', 'context'], limit });
  return out.results.filter((r) => r.score >= floor);
}

/* gitx_related: the pull as an agent asks it. The core comes in full - status
 * first, the whole sentence, never cut, since a fragment reads as a finished
 * statement (t-ee4606572d) - with why it is there and the call that reads it.
 * The edge, and what words alone found, are counted by layer and topic and
 * listed with edge: true, one line each and marked cut - the owner's choice on
 * 5 October: every line of the edge cost 5,500-13,500 tokens a question, since
 * four hops reach 145-300 nodes of a graph this tied together, while counted it
 * costs a few lines and stays one call away. The edge's strongest
 * EDGE_IN_FULL come in full too, also the owner's choice: with the core alone,
 * 4 of their 18 questions' answers were only counted, though each was within
 * the stack's first six; with the five strongest of the edge, all 18 are
 * shown, for ~660 tokens. A broad subject's core is still large - 68 nodes,
 * ~8,500 tokens for "what is the 4th dimension" - and limit caps it. An empty
 * answer says which kind of empty it is. */
const LAYER_NAME = { commit: 'commit', thought: 'thought graph', context: 'context graph' };
const EDGE_IN_FULL = 5;
const LANDING_SHARE = 0.2;
const LANDING_MAX = 3;
const CORE_CAP = 25;

export function related(repoDir, args = {}, { dataDir = null } = {}) {
  const query = String(args.query || '').trim();
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  if (!query && !ids.length && !paths.length) {
    return { error: 'Give a query (your words), ids you are on, or paths you work in - there is nothing to relate to.' };
  }
  const layers = Array.isArray(args.layers) && args.layers.length
    ? args.layers.map((l) => ({ 'thought graph': 'thought', 'context graph': 'context', commits: 'commit' }[l] || l))
    : null;
  const limit = Number(args.limit) >= 1 ? Math.floor(Number(args.limit)) : Infinity;

  const t0 = Date.now();
  const ix = buildRankIndex(repoDir);
  const indexMs = Date.now() - t0;
  const count = { commits: 0, settled: 0, waiting: 0 };
  for (const n of ix.nodes.values()) count[{ commit: 'commits', thought: 'settled', context: 'waiting' }[n.layer]]++;
  const unknown = ids.filter((id) => !ix.nodes.has(id) && ![...ix.nodes.values()].some((n) => n.short && id.length >= 7 && n.id.startsWith(id)));
  const named = ids.map((id) => ix.nodes.has(id) ? id : ([...ix.nodes.values()].find((n) => n.short && id.length >= 7 && n.id.startsWith(id)) || {}).id).filter(Boolean);

  const list = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : null);
  const filters = { layers, outcome: list(args.outcome), kind: list(args.kind) };
  const t1 = Date.now();
  /* What agents' declared paths learned for this question's key - read from
   * the path files on every call; a broken file never stops the answer. */
  let learned = { key: [], matched: [], bridge: [] };
  if (query) { try { learned = learnedFor(ix, repoDir, dataDir, query); } catch (_) { /* no paths readable */ } }
  const learnedWords = [...new Set(learned.matched.flatMap((m) => m.words))];
  const out = pull(ix, { text: query, ids: named, paths, hops: args.hops, learnedWords, ...filters });
  /* A topic named by the caller goes first within each group; it is not a
   * filter, since what is linked to it from elsewhere belongs on the stack. */
  if (args.topic) for (const g of [out.core, out.edge, out.wordsOnly]) g.sort((a, b) => (b.n.topic === args.topic) - (a.n.topic === args.topic));
  const stack = [...out.core, ...out.edge, ...out.wordsOnly];
  const edgeFull = out.edge.slice(0, EDGE_IN_FULL);

  /* The topics the answer lands in, read first (t-aca34dc7d9): those holding
   * a fifth or more of the support of the core and the edge's strongest, with
   * two nodes at least, three topics at most. */
  const mass = new Map();
  let massTotal = 0;
  const lands = [...out.core.slice(0, limit), ...edgeFull];
  for (const r of lands) if (r.n.topic) { mass.set(r.n.topic, (mass.get(r.n.topic) || 0) + r.support); massTotal += r.support; }
  const landing = [...mass].filter(([t, m]) => m >= massTotal * LANDING_SHARE && lands.filter((r) => r.n.topic === t).length >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, LANDING_MAX).map(([t]) => t);
  const summaries = landing.map((t) => summaryOf(ix, t)).filter(Boolean);

  /* A large core stands behind its summaries (the owner's choice, 5 October,
   * t-67083a740f's revisit): when it is over CORE_CAP and every topic it lands
   * in has its summary written, the strongest CORE_CAP come in full and the
   * rest are counted with the edge - "what is the 4th dimension" had grown to
   * 106 nodes, ~15,000 tokens. An explicit limit decides instead. */
  const covered = summaries.length > 0 && summaries.every((s) => s.summary);
  const capped = !Number.isFinite(limit) && covered && out.core.length > CORE_CAP;
  const coreFull = out.core.slice(0, capped ? CORE_CAP : limit);
  const inFull = [...coreFull, ...edgeFull];
  const rest = [...out.core.slice(coreFull.length), ...out.edge.slice(edgeFull.length)];
  const onEdge = new Set(edgeFull);

  const full = (r) => {
    const n = r.n;
    return prune({
      id: n.layer === 'commit' ? n.short : n.id,
      on: onEdge.has(r) ? 'edge' : 'core',
      status: statusOf(ix, n),
      text: n.text,
      held_back_by: n.outcome === 'rejected' && n.held.length ? n.held : undefined,
      code: n.layer === 'commit' ? codeOf(n) : undefined,
      topic: n.topic ? topicName(ix, n.topic) : undefined,
      in: LAYER_NAME[n.layer],
      why: pullWhy(ix, r),
      read: n.layer === 'commit' ? 'gitx_graph_commit hash ' + n.short + ' - code: true for the lines it changed' : 'gitx_thought id ' + n.id
    });
  };
  /* One line: the id, the status, the first words - cut, and marked cut. */
  const line = (r) => {
    const n = r.n;
    const words = String(n.text).split(/\s+/);
    return (n.layer === 'commit' ? n.short : n.id) + ' · ' + statusOf(ix, n) + ' · ' +
      (words.length > 14 ? words.slice(0, 14).join(' ') + ' …' : n.text) + ' · support ' + r.support.toFixed(2);
  };

  /* For GitX Monitor only (t-0156b1d6c5): what GitX did with the question and
   * the layers it arranged the answer in. server.js takes this off before the
   * answer reaches the agent, so it costs the agent nothing. */
  const _monitor = {
    phases: {
      processing: { nodes: ix.nodes.size, ...count, ms: indexMs },
      search: { words: out.words, unmatched: out.unmatched, ids: named, paths, topic: args.topic || null,
        learned: learned.matched.map((m) => m.key + ' (' + m.paths + ' path' + (m.paths === 1 ? '' : 's') + ')') },
      results: {
        entries: out.entries, entered_by: out.entered_by, closest: out.closest, hops: out.hops, pulled: out.pulled,
        candidates: out.pulled + out.wordsOnly.length, matched: stack.length, ms: Date.now() - t1
      },
      filtering: { layers: layers || 'all', outcome: filters.outcome, kind: filters.kind, limit,
        core: out.core.length, edge: out.edge.length, words_only: out.wordsOnly.length, returned: inFull.length,
        summaries: summaries.map((s) => s.title + (s.summary ? '' : ' (none written)')) }
    },
    stack: stackOf(ix, out.core.map((r) => ({ ref: r.n.id, score: +r.support.toFixed(3), why: [pullWhy(ix, r)] })),
      [...out.edge, ...out.wordsOnly].map((r) => r.n.id))
  };
  const head = {
    searched: count,
    asked: out.words.length ? out.words.join(' ') : undefined,
    not_in_the_graph: out.unmatched.length ? out.unmatched : undefined,
    unknown_ids: unknown.length ? unknown : undefined
  };
  if (!stack.length) {
    return prune({
      ...head, results: [],
      nothing_on_record: 'Nothing in the commits, the settled thoughts or the waiting ones relates to this. That is not evidence it was never considered - only that nothing recorded says so in these words. Try other words, or name a file with paths.',
      _monitor
    });
  }
  const by = (rows) => rows.reduce((m, r) => ((m[LAYER_NAME[r.n.layer]] = (m[LAYER_NAME[r.n.layer]] || 0) + 1), m), {});
  /* The edge counted: how many, in which layers, under which topics - enough
   * to tell whether it is worth listing. */
  const topics = (rows) => {
    const m = new Map();
    for (const r of rows) { const t = r.n.topic ? topicName(ix, r.n.topic) : r.n.layer === 'commit' ? 'commits (no topic)' : 'no topic yet'; m.set(t, (m.get(t) || 0) + 1); }
    return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 8));
  };
  const counted = (rows, extra = {}) => prune({ nodes: rows.length, layers: by(rows), topics: topics(rows), ...extra, list: 'Ask again with edge: true to list each, one line and cut.' });
  return prune({
    _monitor,
    ...head,
    entered: out.closest != null
      ? 'No node holds ' + pct(ENTRY_AT) + ' of the question\'s words (the closest ' + pct(out.closest) + ') - entered at the ' + out.entries + ' closest.'
      : 'At ' + out.entries + ' node' + (out.entries === 1 ? '' : 's') + (out.entered_by.words ? ' holding ' + pct(ENTRY_AT) + ' or more of the question\'s words' : '') +
        (out.entered_by.named ? (out.entered_by.words ? ', ' : ' ') + out.entered_by.named + ' named' : '') +
        (out.entered_by.code ? ', ' + out.entered_by.code + ' by the code named' : '') + '.',
    pulled: 'Every link from the entries, ' + out.hops + ' hops out: ' + out.pulled + ' nodes, ' + out.core.length + ' of them in the core.',
    summaries: summaries.length ? summaries : undefined,
    /* A hint, never the answer (t-11190c437f): where agents who asked this
     * went and what they used, with what has come since. */
    most_walked: learned.matched.length ? learned.matched.map((m) => {
      const fresh = inFull.filter((r) => r.n.created && String(r.n.created) > m.newest).map((r) => (r.n.layer === 'commit' ? r.n.short : r.n.id));
      return prune({
        key: m.key,
        learned_from: m.paths + ' declared path' + (m.paths === 1 ? '' : 's') + ', the newest ' + m.newest.slice(0, 10),
        route: m.route.length ? m.route.map((id) => label(ix, id)).join(' > ') + ' (taken ' + m.walked + ' of ' + m.paths + ')' : undefined,
        used: m.used.slice(0, 8).map((u) => label(ix, u.id) + (u.n > 1 ? ' x' + u.n : '')),
        learned_words: m.words.length ? m.words : undefined,
        new_since: fresh.length ? fresh.slice(0, 8).concat(fresh.length > 8 ? ['and ' + (fresh.length - 8) + ' more'] : []) : undefined
      });
    }) : undefined,
    bridge: learned.bridge.length ? learned.bridge.map((id) => label(ix, id)) : undefined,
    core_in_full: capped
      ? 'The core is ' + out.core.length + ' nodes; its strongest ' + CORE_CAP + ' are below in full, the rest counted with the edge - the summaries above say what the whole is. Pass limit to have more in full.'
      : undefined,
    core: by(out.core),
    results: inFull.map(full),
    edge: rest.length
      ? (args.edge ? rest.map(line) : counted(rest, { of_them_core: out.core.length > coreFull.length ? out.core.length - coreFull.length : undefined }))
      : undefined,
    words_only: out.wordsOnly.length
      ? (args.edge ? out.wordsOnly.map((r) => line(r).replace(/ · support .*$/, ' · words ' + pct(r.sim))) : counted(out.wordsOnly))
      : undefined,
    further: out.hops < 6 ? 'hops: ' + (out.hops + 1) + ' pulls one ring further.' : undefined,
    how_to_use: 'This is the stack for the question. summaries, read first, are the topics it lands in: what each does today in an agent\'s words, and - computed now - the commits that built it, its code and what is open; since_written says whether the words may be out of date. results is the core in full - what many of the links from the entries reach, strongest first - then the strongest few of the edge, each marked on: edge. edge is the rest of what the links reach - a single long string each - and words_only what the question\'s words found that no link reaches: counted here, listed one line each and CUT with edge: true; read one with gitx_thought id or gitx_graph_commit hash before relying on it. Read the status before the text: an OPEN QUESTION is not decided, a PROPOSED one was put forward and nobody confirmed it, ANSWERED names the settled thought that answered it, ACCEPTED - NOT BUILT is decided but not in the code - unless it names a settled thought that refined it, which says what was built instead - and a REJECTED idea is not to be proposed again without answering what held it back.'
  });
}

function prune(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/* The answer arranged in the layers, for GitX Monitor: every result in its
 * layer, the commit each settled result was carried out in (shown as reached
 * through it, since the result names it), the code each commit changed under
 * it, and the links between all of them. An agent reading code with its own
 * Read or Grep is still unseen until the hook event log; going down through
 * gitx_graph_commit with code is seen. */
function stackOf(ix, results, edgeIds = []) {
  const nodes = [];
  const byRef = new Map();
  const place = (n, role, extra = {}) => {
    if (byRef.has(n.id)) return;
    const node = {
      id: n.layer === 'commit' ? n.short : n.id, layer: n.layer, role,
      kind: n.kind, status: statusOf(ix, n), text: cap(n.text, 160),
      topic: n.topic ? topicName(ix, n.topic) : undefined,
      commit: n.commit ? n.commit.slice(0, 8) : undefined, ...extra
    };
    byRef.set(n.id, node);
    nodes.push(node);
  };
  results.forEach((r, i) => place(ix.nodes.get(r.ref), 'result', { rank: i + 1, score: r.score, why: r.why.join(' · ') }));
  for (const r of results) {
    const n = ix.nodes.get(r.ref);
    if (n.layer !== 'commit' && n.commit && ix.nodes.has(n.commit)) place(ix.nodes.get(n.commit), 'via');
  }
  const links = [];
  for (const [ref, node] of byRef) {
    for (const e of ix.adj.get(ref) || []) {
      if (e.type.startsWith('by:') || !byRef.has(e.to)) continue;
      links.push([node.id, e.type, byRef.get(e.to).id]);
    }
  }
  /* The edge of the pull (t-8e3f4c2aa9): on the stack, so an agent opening
   * one is still on it, but drawn as dots with no links and no code under
   * them - a few hundred lines between them would hide the core. */
  for (const id of edgeIds) if (ix.nodes.has(id) && !byRef.has(id)) place(ix.nodes.get(id), 'edge');
  /* One layer down (t-4f0de6c907): under each commit, every region it
   * changed, largest share first. A region two of them changed is one node
   * with a link from each - where two commits met in the code. `major` marks
   * a commit's largest few, the ones GitX Monitor names; the rest are drawn
   * small but are on the stack all the same, so an agent opening one is
   * still on it. */
  const code = new Map();
  for (const [ref, node] of byRef) {
    if (node.layer !== 'commit' || node.role === 'edge') continue;
    const regions = Object.entries(ix.nodes.get(ref).regions || {}).sort((a, b) => b[1] - a[1]);
    regions.forEach(([region, share], i) => {
      const id = 'code:' + region;
      if (!code.has(id)) {
        const c = { id, layer: 'code', role: 'code', kind: 'code', status: 'CODE', text: region, commits: [], share: 0, major: false };
        code.set(id, c);
        nodes.push(c);
      }
      const c = code.get(id);
      c.commits.push(node.id);
      c.share = Math.max(c.share, +share.toFixed(2));
      if (i < CODE_NAMED) c.major = true;
      links.push([node.id, 'changed', id]);
    });
  }
  for (const node of nodes) for (const k of Object.keys(node)) if (node[k] === undefined) delete node[k];
  return { nodes, links };
}

/* ─────────────────────────────────────────────── topic summaries */

/* A topic's summary as an agent reads it (t-aca34dc7d9): the words an agent
 * wrote about what the feature does today, then what is computed afresh on
 * every read and so cannot go stale - the commits that carried out its
 * thoughts, the code those commits changed, and what is still open - and
 * how much has happened on the topic since the words were written. Members
 * are the thoughts filed under the topic, in either graph. */
export function summaryOf(ix, topicId, { full = false } = {}) {
  const t = ix.topics.get(topicId);
  if (!t) return null;
  const d = t.digest && typeof t.digest === 'object' ? t.digest : t.digest ? { text: String(t.digest) } : null;
  const members = [...ix.nodes.values()].filter((n) => n.layer !== 'commit' && n.topic === topicId);
  const order = ix._order || (ix._order = new Map(ix.commitIndex.commits.map((c, i) => [c.hash, i])));   // newest first

  const byCommit = new Map();
  for (const n of members) if (n.commit && ix.nodes.has(n.commit)) byCommit.set(n.commit, (byCommit.get(n.commit) || 0) + 1);
  const built = [...byCommit].sort((a, b) => (order.has(a[0]) ? order.get(a[0]) : 1e9) - (order.has(b[0]) ? order.get(b[0]) : 1e9));
  const regions = new Map();
  for (const [h] of built) for (const [r, s] of Object.entries(ix.nodes.get(h).regions || {})) regions.set(r, (regions.get(r) || 0) + s);
  const code = [...regions].sort((a, b) => b[1] - a[1]).map(([r]) => r);

  const status = members.map((n) => ({ n, s: statusOf(ix, n) }));
  const open = (re) => status.filter((x) => re.test(x.s));
  const groups = { questions: open(/^OPEN QUESTION/), proposals: open(/^PROPOSED - NOT CONFIRMED/), decided_not_built: open(/NOT BUILT$/) };

  /* Since the words: commits that settled the topic's thoughts after the one
   * the summary was written at, and thoughts filed under it after. */
  let since = null;
  if (d && d.at) {
    const atHash = d.at_commit && [...order.keys()].find((h) => h.startsWith(d.at_commit));
    const at = atHash ? order.get(atHash) : null;
    const commits = at == null ? 0 : built.filter(([h]) => order.has(h) && order.get(h) < at).length;
    const thoughts = members.filter((n) => n.created && n.created > d.at).length;
    since = { commits, thoughts };
  }
  const commitLine = ([h, k]) => ix.nodes.get(h).short + ' ' + cap(ix.nodes.get(h).text, 80) + ' (' + k + ' thought' + (k === 1 ? '' : 's') + ')';
  const listOf = (g) => (full ? g.map((x) => x.n.id + ' · ' + x.s + ' · ' + x.n.text) : g.slice(0, 5).map((x) => x.n.id));
  const more = (list, k) => (list.length > k ? ' and ' + (list.length - k) + ' more' : '');
  const nBuilt = full ? 50 : 5, nCode = full ? 20 : 6;
  return prune({
    topic: topicId,
    title: t.title,
    summary: d ? d.text : undefined,
    written: d ? [d.by || 'someone', d.at ? 'on ' + String(d.at).slice(0, 10) : null, d.at_commit ? 'at ' + String(d.at_commit).slice(0, 7) : null].filter(Boolean).join(' ') : undefined,
    since_written: since
      ? (since.commits || since.thoughts
        ? since.commits + ' commit(s) settled thinking on this topic and ' + since.thoughts + ' thought(s) were filed under it since - check the summary still holds, and rewrite it if not.'
        : 'Nothing on this topic has been settled or filed since it was written.')
      : undefined,
    no_summary: d ? undefined : 'Nobody has written this topic\'s summary yet. Write one - what it does today, in a few lines - with gitx_thought_record summary: { topic: "' + topicId + '", text }.',
    thoughts: members.length,
    built_by: built.length ? built.slice(0, nBuilt).map(commitLine).concat(built.length > nBuilt ? ['and ' + (built.length - nBuilt) + ' more'] : []) : undefined,
    code: code.length ? code.slice(0, nCode).concat(code.length > nCode ? ['and ' + (code.length - nCode) + ' more regions'] : []) : undefined,
    open: Object.values(groups).some((g) => g.length) ? prune(Object.fromEntries(Object.entries(groups).filter(([, g]) => g.length)
      .map(([k, g]) => [k, full ? listOf(g) : g.length + ': ' + listOf(g).join(', ') + more(g, 5)]))) : undefined,
    read: full ? undefined : 'gitx_thought topic ' + topicId
  });
}

/* How many of a commit's regions GitX Monitor names under it, and a commit
 * result lists. */
const CODE_NAMED = 4;

/* The code under a commit result, in one line: where it changed most, so the
 * agent sees which code the commit is about before choosing to go down. */
function codeOf(n) {
  const regions = Object.entries(n.regions || {}).sort((a, b) => b[1] - a[1]);
  if (!regions.length) return undefined;
  const named = regions.slice(0, CODE_NAMED).map(([r]) => r).join(' · ');
  return regions.length > CODE_NAMED ? named + ' · and ' + (regions.length - CODE_NAMED) + ' more' : named;
}

/* What a node is, in capitals, first - the detail a hasty reader gets wrong
 * most is taking an open question for a decision or a rejected idea for the
 * plan (t-ee4606572d). What became of it later comes from the rule every
 * reader shares (laterOf in thoughts.js): a thought another supersedes says so
 * before anything, an open question a settled thought refines is ANSWERED,
 * and a decision still waiting names the settled work that carried it on -
 * without which an agent reports as unbuilt what shipped. An open thought that
 * asks nothing is a proposal, not a question. */
export function statusOf(ix, n) {
  if (n.layer === 'commit') return 'COMMIT ' + n.created;
  const incoming = (ix.adj.get(n.id) || []).filter((e) => e.type.startsWith('by:')).map((e) => ({ type: e.type.slice(3), from: e.to }));
  const later = laterOf(incoming, (id) => (ix.nodes.get(id) || {}).commit || null);
  const settled = (l) => (l.commit ? ', SETTLED in ' + l.commit.slice(0, 7) : '');
  if (later && later.how === 'superseded') return 'SUPERSEDED by ' + later.by + settled(later);
  const built = n.commit ? ' in ' + n.commit.slice(0, 7) : '';
  if (n.outcome === 'open') {
    const question = asksQuestion(n);
    if (later) return (question ? 'ANSWERED by ' : 'PROPOSED - TAKEN UP by ') + later.by + settled(later);
    return question ? 'OPEN QUESTION' : 'PROPOSED - NOT CONFIRMED';
  }
  if (n.outcome === 'rejected') return 'REJECTED';
  if (n.outcome === 'stashed') return 'STASHED';
  if (n.kind === 'learned') return 'RULE';
  if (n.kind === 'finding') return n.layer === 'thought' ? 'FINDING, SETTLED' : 'FINDING';
  /* A settled decision a later settled one refined is still what was built
   * then, but no longer the whole of it: the promotion rule that brings what
   * a decision cites read as plain SETTLED beside the later rule that stops
   * it at a decision still waiting. The status still starts SETTLED in. */
  if (n.layer === 'thought') return 'SETTLED' + built + (later ? ' - refined later by ' + later.by + settled(later) : '');
  const waiting = n.kind === 'cost' ? 'COST ACCEPTED - NOT BUILT' : 'ACCEPTED - NOT BUILT';
  return later ? waiting + ' itself - refined by ' + later.by + settled(later) : waiting;
}

/* ─────────────────────────────────────────────── shape */

function shape(ix, { n, sig, via, w, score }) {
  const why = [];
  if (w && w.matched.length) {
    const best = w.matched.slice().sort((a, b) => b.idf - a.idf).slice(0, 4);
    why.push('words: ' + best.map((m) => m.q + (m.own ? '' : ' (in its reasons)')).join(', '));
  }
  if (sig.regions > 0) why.push('code: touches the named area (' + sig.regions.toFixed(2) + ')');
  if (sig.topic) why.push('topic: ' + topicName(ix, n.topic));
  else if (sig.affinity >= 0.5) why.push('topic: ' + topicName(ix, n.topic) + ', where the best matches are');
  if (sig.link > 0 && via) {
    why.push('linked: ' + (via.type.startsWith('by:')
      ? label(ix, via.to) + ' ' + via.type.slice(3) + ' it'
      : 'it ' + via.type + ' ' + label(ix, via.to)));
  }
  if (sig.active) why.push('active in the goal');
  const out = {
    id: n.layer === 'commit' ? n.short : n.id,
    ref: n.id,
    layer: n.layer, kind: n.kind,
    outcome: n.outcome || undefined,
    /* A thought and the commit it settled are one route: said, so a caller
     * can fold them and the evaluation counts either as the commit. */
    commit: n.commit ? n.commit.slice(0, 8) : undefined,
    text: cap(n.text),
    topic: n.topic ? topicName(ix, n.topic) : undefined,
    score: +score.toFixed(3),
    signals: Object.fromEntries(Object.entries(sig).filter(([, v]) => v > 0).map(([k, v]) => [k, +v.toFixed(3)])),
    why
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const topicName = (ix, id) => (ix.topics.get(id) || { title: id }).title;
const label = (ix, id) => { const n = ix.nodes.get(id); return n && n.layer === 'commit' ? n.short : id; };
