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
import { loadThoughts } from './thoughts.js';
import { loadTopics, loadGoal, domainOf } from './topics.js';
import { tokenize } from './git-extract.js';
import { regionsFromPaths, coverageScore, regionScore } from './retrieval.js';

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
        topic: t.topic || null, domain: domainOf(t), commit: commit || null
      });
      for (const l of t.links || []) link(t.id, l.to, l.type);
      for (const f of t.forces || []) for (const id of f.cites || []) link(t.id, id, 'cites');
      if (commit) link(t.id, commit, 'settled-by');
    }
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
  const N = [...ix.nodes.values()].filter(alive).length || 1;

  /* ① words, with the idf of what each query word stands for among live nodes.
   * `also` is secondary text - a draft's reasons beside its sentence - and
   * counts at the weight a node's own reasons do. One stem is one word however
   * many forms of it the query uses. */
  const shown = new Map();       // stem -> the word as the query wrote it
  const want = new Map();        // stem -> 1 for the text, REST for `also`
  for (const [src, weight] of [[query.also, REST], [text, 1]]) {
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

/* gitx_related: the engine as an agent asks it. One list over commits, the
 * thought graph and the context graph, each result with its status first,
 * its whole sentence - never cut, since a fragment reads as a finished
 * statement (t-ee4606572d) - why it ranked, and the call that reads it in
 * full. An empty answer says which kind of empty it is, as GitX's other
 * readers do. */
const RELATED_DEFAULT = 8;
const RELATED_MAX = 25;
const LAYER_NAME = { commit: 'commit', thought: 'thought graph', context: 'context graph' };

export function related(repoDir, args = {}) {
  const query = String(args.query || '').trim();
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  if (!query && !ids.length && !paths.length) {
    return { error: 'Give a query (your words), ids you are on, or paths you work in - there is nothing to relate to.' };
  }
  const layers = Array.isArray(args.layers) && args.layers.length
    ? args.layers.map((l) => ({ 'thought graph': 'thought', 'context graph': 'context', commits: 'commit' }[l] || l))
    : null;
  const limit = Math.max(1, Math.min(RELATED_MAX, Number(args.limit) || RELATED_DEFAULT));

  const t0 = Date.now();
  const ix = buildRankIndex(repoDir);
  const indexMs = Date.now() - t0;
  const count = { commits: 0, settled: 0, waiting: 0 };
  for (const n of ix.nodes.values()) count[{ commit: 'commits', thought: 'settled', context: 'waiting' }[n.layer]]++;
  const unknown = ids.filter((id) => !ix.nodes.has(id) && ![...ix.nodes.values()].some((n) => n.short && id.length >= 7 && n.id.startsWith(id)));
  const named = ids.map((id) => ix.nodes.has(id) ? id : ([...ix.nodes.values()].find((n) => n.short && id.length >= 7 && n.id.startsWith(id)) || {}).id).filter(Boolean);

  const list = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : null);
  const filters = { layers, outcome: list(args.outcome), kind: list(args.kind), limit };
  const t1 = Date.now();
  const out = rank(ix, { text: query, ids: named, paths, topic: args.topic || null, ...filters });
  /* For GitX Monitor only (t-0156b1d6c5): what GitX did with the question and
   * the layers it arranged the answer in. server.js takes this off before the
   * answer reaches the agent, so it costs the agent nothing. */
  const _monitor = {
    phases: {
      processing: { nodes: ix.nodes.size, ...count, ms: indexMs },
      search: { words: out.words, unmatched: out.unmatched, ids: named, paths, topic: args.topic || null },
      results: { candidates: out.candidates, matched: out.matched, signals: out.signals, ms: Date.now() - t1 },
      filtering: { layers: layers || 'all', outcome: filters.outcome, kind: filters.kind, limit, returned: out.results.length }
    },
    stack: stackOf(ix, out.results)
  };
  const head = {
    searched: count,
    asked: out.words.length ? out.words.join(' ') : undefined,
    not_in_the_graph: out.unmatched.length ? out.unmatched : undefined,
    unknown_ids: unknown.length ? unknown : undefined
  };
  if (!out.results.length) {
    return prune({
      ...head, results: [],
      nothing_on_record: 'Nothing in the commits, the settled thoughts or the waiting ones relates to this. That is not evidence it was never considered - only that nothing recorded says so in these words. Try other words, or name a file with paths.',
      _monitor
    });
  }
  return prune({
    _monitor,
    ...head,
    matched: out.matched,
    returned: out.results.length,
    results: out.results.map((r) => {
      const n = ix.nodes.get(r.ref);
      return prune({
        id: r.id,
        hash: n.layer === 'commit' ? n.short : undefined,
        status: statusOf(ix, n),
        text: n.text,
        held_back_by: n.outcome === 'rejected' && n.held.length ? n.held : undefined,
        topic: r.topic,
        in: LAYER_NAME[n.layer],
        why: r.why.join(' · '),
        read: n.layer === 'commit' ? 'gitx_graph_commit hash ' + n.short : 'gitx_thought id ' + n.id
      });
    }),
    how_to_use: 'Results are pointers, best first across commits, settled reasoning and thinking still waiting. Read the status before the text: an OPEN QUESTION is not decided, ACCEPTED - NOT BUILT is decided but not in the code, and a REJECTED idea is not to be proposed again without answering what held it back. Read a result in full with the call in its "read" field before relying on anything it does not show.'
  });
}

function prune(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/* The answer arranged in the layers, for GitX Monitor: every result in its
 * layer, the commit each settled result was carried out in (shown as reached
 * through it, since the result names it), and the links between all of them.
 * L1 stays empty until the hook event log can see the agent read code. */
function stackOf(ix, results) {
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
  for (const node of nodes) for (const k of Object.keys(node)) if (node[k] === undefined) delete node[k];
  return { nodes, links };
}

/* What a node is, in capitals, first - the detail a hasty reader gets wrong
 * most is taking an open question for a decision or a rejected idea for the
 * plan (t-ee4606572d). A thought another supersedes says so before anything. */
export function statusOf(ix, n) {
  if (n.layer === 'commit') return 'COMMIT ' + n.created;
  const by = (ix.adj.get(n.id) || []).find((e) => e.type === 'by:supersedes');
  if (by) return 'SUPERSEDED by ' + by.to;
  const built = n.commit ? ' in ' + n.commit.slice(0, 7) : '';
  if (n.outcome === 'open') return 'OPEN QUESTION';
  if (n.outcome === 'rejected') return 'REJECTED';
  if (n.outcome === 'stashed') return 'STASHED';
  if (n.kind === 'learned') return 'RULE';
  if (n.kind === 'finding') return n.layer === 'thought' ? 'FINDING, SETTLED' : 'FINDING';
  if (n.layer === 'thought') return 'SETTLED' + built;
  return n.kind === 'cost' ? 'COST ACCEPTED - NOT BUILT' : 'ACCEPTED - NOT BUILT';
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
