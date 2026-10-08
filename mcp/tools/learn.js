/*
 * Path knowledge: what GitX learns from how agents walk the stack - the
 * learning half of the 4th Dimension (t-1afbf7e474). Decided 5 October:
 *
 *   t-4f44aa05bb  knowledge is kept per KEY - a question reduced to its
 *                 meaning-bearing words, so "What is 4th Dimension" and "tell
 *                 me about 4th dimension" share one - and each landed path
 *                 adds its words and its route to the key
 *   t-11190c437f  a learned route is a hint and never the answer: every
 *                 search runs fresh, the route is shown as the most walked
 *                 with how many agents took it, and nodes newer than what was
 *                 learned are flagged
 *   t-eef3ec6b17  only a declared path teaches, and only from the nodes it
 *                 used - cited from its own stack, never what it passed
 *                 through - and a word joins a key only once several landed
 *                 paths repeated it
 *
 * Learned on every read from the path files the recorder keeps (one per
 * prompt), never stored apart from them: a path written a moment ago teaches
 * the next search, a path deleted stops teaching, and there is no second
 * copy to drift. A READER - it writes nothing.
 *
 * "Used" is the declare step's cited_in_stack. A declare that cites nothing
 * on its stack teaches nothing: the recorder ties any record to the last
 * question asked, and the first real declared path (4 October) was a record
 * about something else twenty minutes later.
 */

import { readPaths } from './path-recorder.js';
import { tokenize } from './git-extract.js';
import { stem } from './rank.js';

const KEY_RARE = 0.1;    // a word in no more than this share of the graph bears meaning
const LEARN_MIN = 2;     // a word joins a key once this many declared paths repeated it
const PATHS_READ = 5000;

/* How a question is asked, not what it is about. Rarity alone does not drop
 * them: "tell" and "explain" are rare in a graph of decisions, and kept, they
 * split "tell me about 4th dimension" and "explain the 4th dimension" into
 * keys of their own, none of which ever learns anything. */
export const ASKING = new Set(('what whats which who whom whose when where why how is are was were do does did doe can could should would will ' +
  'tell me about explain describe show give list please know want need understand mean means meaning there here this that these those it its ' +
  'thing things way work works working happen happens ' +
  /* commit subjects' type prefixes, and plain words rare only because the
   * graph is small - both were learned as "4th Dimension" words when measured */
  'feat fix refactor docs chore style test perf build part over along within between need each every other ' +
  'more most some only also still just even much many own same').split(' ').map(stem));

/* A question's key: its words the graph holds and holds rarely, as stems,
 * sorted, without the words of asking - "what is the 4th dimension", "tell me
 * about 4th dimension" and "explain the 4th dimension" are all "dimension". */
export function keyOf(ix, text) {
  const stems = [...new Set(tokenize(String(text || '')).map(stem))];
  return stems.filter((s) => {
    if (ASKING.has(s)) return false;
    const p = ix.postings.get(s);
    return p && p.size <= ix.nodes.size * KEY_RARE;
  }).sort();
}

const resolve = (ix, id) => (ix.nodes.has(id) ? id : [...ix.nodes.keys()].find((k) => id.length >= 7 && k.startsWith(id)) || null);

/* Every key learned in this repository: from each declared path that used
 * something, its key, what it used, the route it took there and the rare
 * words of what it used. */
export function learnKeys(ix, repoDir, dataDir) {
  const keys = new Map();
  for (const p of readPaths(repoDir, dataDir, PATHS_READ)) {
    if (p.status !== 'declared') continue;
    const decl = (p.path || []).find((s) => s.kind === 'declare');
    const used = [...new Set(((decl && decl.cited_in_stack) || []).map((id) => resolve(ix, id)).filter(Boolean))];
    if (!used.length) continue;
    const key = keyOf(ix, p.question && p.question.query);
    if (!key.length) continue;
    const name = key.join(' ');
    if (!keys.has(name)) keys.set(name, { key, paths: 0, used: new Map(), routes: new Map(), words: new Map(), newest: '' });
    const k = keys.get(name);
    k.paths++;
    for (const id of used) k.used.set(id, (k.used.get(id) || 0) + 1);
    const route = [];
    for (const s of p.path || []) {
      const id = s.node && s.in_stack ? resolve(ix, String(s.node.id)) || String(s.node.id) : null;
      if (id && route[route.length - 1] !== id) route.push(id);
    }
    if (route.length) { const sig = route.join(' > '); k.routes.set(sig, (k.routes.get(sig) || 0) + 1); }
    /* A word counts once per path, and remembers which used nodes carried it:
     * two paths using the same thought would otherwise make every word of
     * that one thought "repeated" - measured, it learned "over", "along" and
     * "need" for the 4th Dimension. */
    const rare = new Map();
    for (const id of used) {
      for (const w of ix.nodes.get(id).own) {
        const ps = ix.postings.get(w);
        if (!ps || ps.size > ix.nodes.size * KEY_RARE || key.includes(w) || ASKING.has(w)) continue;
        if (!rare.has(w)) rare.set(w, new Set());
        rare.get(w).add(id);
      }
    }
    for (const [w, ids] of rare) {
      const c = k.words.get(w) || { paths: 0, nodes: new Set() };
      c.paths++;
      for (const id of ids) c.nodes.add(id);
      k.words.set(w, c);
    }
    if (String(p.at) > k.newest) k.newest = String(p.at);
  }
  return keys;
}

/* The keys a question matches: all of a key's words in the question's key,
 * or all of the question's in the key. Each with its learned words - those
 * LEARN_MIN declared paths repeated - its most walked route, and the nodes
 * its paths used most. */
export function learnedFor(ix, repoDir, dataDir, text) {
  const q = keyOf(ix, text);
  if (!q.length) return { key: q, matched: [] };
  const matched = [];
  for (const k of learnKeys(ix, repoDir, dataDir).values()) {
    if (!(k.key.every((w) => q.includes(w)) || q.every((w) => k.key.includes(w)))) continue;
    const [route, walked] = [...k.routes].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    matched.push({
      key: k.key.join(' '), paths: k.paths, newest: k.newest,
      /* Repeated by LEARN_MIN declared paths, in LEARN_MIN different nodes they used. */
      words: [...k.words].filter(([, c]) => c.paths >= LEARN_MIN && c.nodes.size >= LEARN_MIN)
        .sort((a, b) => b[1].paths - a[1].paths || b[1].nodes.size - a[1].nodes.size).map(([w]) => w),
      route: route ? route.split(' > ') : [], walked,
      used: [...k.used].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }))
    });
  }
  /* Two keys in one question: what both were used for is the bridge between
   * them (t-4f44aa05bb). */
  const bridge = matched.length > 1
    ? [...new Set(matched.flatMap((m) => m.used.map((u) => u.id)))].filter((id) => matched.filter((m) => m.used.some((u) => u.id === id)).length > 1)
    : [];
  return { key: q, matched, bridge };
}
