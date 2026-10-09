/*
 * A question's pool (t-2c70a44885): GitX keeps the agent's stack between
 * calls, so a follow-up is one more ordinary gitx_related call that updates
 * the same stack instead of starting over.
 *
 *   new or follow-up   a question is a follow-up when its rare words were in
 *                      what GitX gave for the current question - the agent
 *                      read them there - or when it has no rare word of its
 *                      own and only narrows; otherwise it is new, and says why.
 *                      new: true forces a new question; add / drop refine the
 *                      current one with no question at all
 *   words              each round the older words keep half their weight and
 *                      the newest come in at full (Rocchio's update, with
 *                      the original question as the anchor fading slowly);
 *                      a dropped word leaves and sinks what holds it
 *   change list        after the first round only what changed is sent: new
 *                      map entries, entries hidden by the new words, entries
 *                      back from an earlier round (named, not resent), new
 *                      code lines of a function already given, new thoughts.
 *                      Nothing given in this question is given twice
 *   kept pools         a new question sets the current pool aside; the last
 *                      two are kept, and a question that continues one of
 *                      them goes back to it
 *
 * In memory, per server process - one agent session. Nothing here is written.
 */

import { buildCodeIndex, termsOf, questionTerms, idfOf, RARE_SHARE, codeFirst, rankIndexFor } from './code-find.js';
import { learnFor } from './walk-learn.js';
import { stem } from './rank.js';

const POOLS_KEPT = 2;
const OLDER = 0.5;           // each round an older word keeps this share of its weight
const FADED = 0.2;           // below this it leaves the pool
const ANCHOR = 0.25;         // the first question's words never fall below this: without it
                             // they were gone by the third round and the pool forgot its subject

export const newSessions = () => new Map();      // repoDir -> { pool, kept }

/* Words as the agent wrote them, by the stem GitX counts. */
function spellings(text, into = new Map()) {
  for (const raw of String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || []) {
    const w = stem(raw.toLowerCase());
    if (!into.has(w)) into.set(w, raw.toLowerCase());
  }
  return into;
}
const termsOfList = (list) => [...new Set((Array.isArray(list) ? list : list ? [list] : []).flatMap((w) => [...termsOf(String(w))]))];

/* Is this question a follow-up of the pool? `shared` says it was decided by
 * words the pool holds - not merely by having no rare word of its own. */
function followUp(cx, query, pool) {
  const spell = spellings(query);
  const terms = [...questionTerms(query)].filter((w) => !w.includes('_'));
  const rare = terms.filter((w) => (cx.df.get(w) || 0) <= cx.regions.length * RARE_SHARE);
  const say = (ws) => ws.map((w) => '"' + (spell.get(w) || w) + '"').join(', ');
  if (!rare.length) return { follow: true, shared: false, why: 'no rare word of its own: it narrows "' + pool.first + '"' };
  const known = (w) => pool.sentTerms.has(w) || pool.weights.has(w);
  const total = rare.reduce((s, w) => s + idfOf(cx, w), 0);
  const shared = rare.filter(known);
  if (shared.reduce((s, w) => s + idfOf(cx, w), 0) >= total / 2) {
    return { follow: true, shared: true, why: say(shared) + (shared.length > 1 ? ' were' : ' was') + ' in what GitX gave for "' + pool.first + '"' };
  }
  return { follow: false, shared: false, why: say(rare.filter((w) => !known(w))) + ' appears nowhere in what GitX gave for "' + pool.first + '"' };
}

const freshPool = (first) => ({
  id: ++poolIds, first, anchor: new Set([...questionTerms(first)]), round: 0, weights: new Map(), avoid: new Set(), spell: new Map(),
  sent: new Map(),           // id -> round it was first given (trees, thoughts, commits, context, docs)
  sentLines: new Map(),      // function ref -> Set of line numbers given
  sentTerms: new Set(),      // every word given, for telling a follow-up
  shown: new Map(),          // map entry key -> round last visible
  visible: new Set()         // map entry keys visible after the last round
});

/* The line numbers in a block of numbered lines. */
const linesIn = (code) => new Set((String(code || '').match(/^\s*(\d+)  /gm) || []).map((s) => Number(s.trim())));
const keyOf = (ring, e) => ring + ': ' + String(e).replace(/ \(tree below\)$/, '');

/* Mark everything in an answer as given in this round. */
function remember(pool, answer) {
  const r = pool.round;
  const give = (id) => { if (!pool.sent.has(id)) pool.sent.set(id, r); };
  for (const t of answer.trees || []) {
    give('tree:' + t.ref);
    const set = pool.sentLines.get(t.ref) || new Set();
    for (const n of linesIn(t.code || t.new_lines)) set.add(n);
    pool.sentLines.set(t.ref, set);
    for (const w of t.written_by || []) { give('commit:' + w.commit); for (const s of w.settled || []) give(s.id); }
    for (const o of t.open || []) give(o.id);
  }
  for (const d of answer.thinking || []) give('doc:' + d.doc);
  for (const c of answer.context || []) give(c.id);
  for (const c of answer.decided || []) give(c.id);
  for (const w of termsOf(JSON.stringify(answer))) pool.sentTerms.add(w);
}

/* A follow-up's answer: only what changed since the last round. */
function changesOf(pool, full) {
  const r = pool.round;
  const seen = (id) => (pool.sent.has(id) ? pool.sent.get(id) : null);
  const now = new Map();
  if (full.map) for (const ring of ['core', 'wiring', 'surface']) for (const e of full.map[ring] || []) now.set(keyOf(ring, e), e);
  const added = [], back = [];
  for (const [k] of now) {
    if (pool.visible.has(k)) continue;
    if (pool.shown.has(k)) back.push(k + ' (shown in round ' + pool.shown.get(k) + ')');
    else added.push(k);
  }
  const hidden = [...pool.visible].filter((k) => !now.has(k));
  const trees = (full.trees || []).map((t) => {
    if (seen('tree:' + t.ref) === null) return t;
    const before = pool.sentLines.get(t.ref) || new Set();
    const fresh = String(t.code || '').split('\n').filter((l) => { const m = l.match(/^\s*(\d+)  /); return m && !before.has(Number(m[1])); });
    const written = (t.written_by || []).map((w) => {
      const settled = (w.settled || []).filter((s) => !s.see && seen(s.id) === null);
      if (seen('commit:' + w.commit) !== null && !settled.length) return null;
      return { ...w, why: seen('commit:' + w.commit) !== null ? undefined : w.why, settled: settled.length ? settled : undefined };
    }).filter(Boolean);
    const open = (t.open || []).filter((o) => seen(o.id) === null);
    if (!fresh.length && !written.length && !open.length) return { function: t.function, ref: t.ref, given_in: 'round ' + seen('tree:' + t.ref) };
    return { function: t.function, ref: t.ref, new_lines: fresh.length ? fresh.join('\n') : undefined, written_by: written.length ? written : undefined, open: open.length ? open : undefined, given_in: 'round ' + seen('tree:' + t.ref) + ', new parts only' };
  });
  const context = (full.context || []).filter((c) => seen(c.id) === null);
  const decided = (full.decided || []).filter((c) => seen(c.id) === null);
  const contextKept = (full.context || []).length - context.length;
  const thinking = (full.thinking || []).filter((d) => seen('doc:' + d.doc) === null);
  for (const k of now.keys()) pool.shown.set(k, r);
  pool.visible = new Set(now.keys());
  /* In the order the full answer chose: context first when it leads (code-find.js). */
  const contextOut = { decided: decided.length ? decided : undefined, context: context.length ? context : undefined, context_kept: contextKept || undefined };
  return {
    lead: full.lead,
    ...(full.lead ? contextOut : {}),
    no_code: full.no_code,
    map: full.map ? {
      feature: full.map.feature,
      new: added.length ? added : undefined,
      back: back.length ? back : undefined,
      hidden: hidden.length ? hidden : undefined,
      kept: now.size - added.length - back.length,
      words: full.map.words
    } : undefined,
    trees: trees.length ? trees : undefined,
    thinking: thinking.length ? thinking : undefined,
    summaries: full.summaries,
    ...(full.lead ? {} : contextOut)
  };
}

/* The pool's words after a call, without touching the pool: a question in
 * the chain ages the older words - the first question's never below the
 * anchor - and comes in at full weight; an add or a drop only adjusts. */
function nextWeights(pool, q, add, drop) {
  const weights = new Map(pool.weights), avoid = new Set(pool.avoid);
  if (pool.round > 0 && q) {
    for (const [w, m] of weights) {
      const n = pool.anchor.has(w) ? Math.max(ANCHOR, m * OLDER) : m * OLDER;
      if (n < FADED) weights.delete(w); else weights.set(w, n);
    }
  }
  for (const w of [...questionTerms(q), ...termsOfList(add)]) { weights.set(w, 1); avoid.delete(w); }
  for (const w of termsOfList(drop)) { weights.delete(w); avoid.add(w); }
  return { weights, avoid };
}

/* Searching the suggested words before the agent picks one (step 5 of
 * t-4c167bea08). After an answer, the follow-up for each of the first
 * AHEAD_WORDS suggested words is worked out in the background, one per turn
 * of the event loop so a real call is never kept waiting behind all of
 * them. Kept per pool and round, and used only if the code index is still
 * the same object - a commit or a thought written meanwhile makes it stale. */
const AHEAD_WORDS = 3;
const ahead = new Map();          // pool id:round:word:paths -> { stamp, cf }
let poolIds = 0;
const aheadKey = (pool, q, paths) => pool.id + ':' + pool.round + ':' + String(q || '').trim().toLowerCase() + ':' + JSON.stringify(paths || []);

export function prefetch(sessions, repoDir, { words = AHEAD_WORDS, onDone = null } = {}) {
  const s = sessions.get(repoDir);
  const pool = s && s.pool;
  if (!pool || !pool.suggested || !pool.suggested.length) return;
  const round = pool.round;
  const todo = pool.suggested.slice(0, words);
  const t0 = Date.now();
  let done = 0;
  const next = () => {
    if (s.pool !== pool || pool.round !== round || !todo.length) { if (onDone) onDone({ done, ms: Date.now() - t0 }); return; }
    const word = todo.shift();
    try {
      const cx = buildCodeIndex(repoDir);
      const { weights, avoid } = nextWeights(pool, word, null, null);
      ahead.set(aheadKey(pool, word, pool.paths), { stamp: cx, cf: codeFirst(repoDir, { query: word, weights, avoid, paths: pool.paths, use: pool.learned ? pool.learned.use : null }) });
      done++;
    } catch (_) { /* worked out when asked instead */ }
    setImmediate(next);
  };
  setImmediate(next);
}

/* One gitx_related call through the session's pool. */
const LEARNED = 0.5;         // a learned word's weight: it widens the search, never decides it

export function askPooled(sessions, repoDir, { query = '', add = null, drop = null, fresh = false, paths = [], dataDir = null } = {}) {
  const cx = buildCodeIndex(repoDir);
  const s = sessions.get(repoDir) || { pool: null, kept: [] };
  sessions.set(repoDir, s);
  const q = String(query || '').trim();
  let pool = s.pool, kind, why;
  if (fresh || !pool) { kind = 'new'; why = fresh ? 'asked as a new question' : 'the first question of this session'; }
  else if (!q) { kind = 'follow-up'; why = 'words added or dropped'; }
  else { const v = followUp(cx, q, pool); kind = v.follow ? 'follow-up' : 'new'; why = v.why; }
  /* Back to a question set aside, when this one continues it by its words. */
  if (kind === 'new' && q && !fresh) {
    const back = s.kept.find((k) => { const v = followUp(cx, q, k); return v.follow && v.shared; });
    if (back) {
      s.kept = [...s.kept.filter((k) => k !== back), ...(pool ? [pool] : [])].slice(-POOLS_KEPT);
      pool = back; kind = 'follow-up'; why = 'back to "' + back.first + '", asked earlier: ' + followUp(cx, q, back).why;
      s.pool = pool;
    }
  }
  if (kind === 'new') {
    if (pool) s.kept = [...s.kept.filter((k) => k !== pool), pool].slice(-POOLS_KEPT);
    pool = freshPool(q || termsOfList(add).join(' '));
    s.pool = pool;
  }
  spellings(q, pool.spell);
  for (const a of [].concat(add || [])) spellings(a, pool.spell);
  /* Worked out ahead when the agent asks one of the words GitX suggested
   * (t-2c70a44885) - the same weights, the same code index - else now. */
  const key = aheadKey(pool, q, paths);
  const ready = !add && !drop && kind === 'follow-up' ? ahead.get(key) : null;
  Object.assign(pool, nextWeights(pool, q, add, drop));
  /* A new question learns from earlier agents' walks of questions like it
   * (walk-learn.js): the words they added come in at LEARNED, and what they
   * opened is passed to the search, which ranks it higher. */
  if (kind === 'new' && q && dataDir) {
    try { pool.learned = learnFor(repoDir, dataDir, rankIndexFor(repoDir), q); } catch (_) { pool.learned = null; }
    for (const w of (pool.learned && pool.learned.words) || []) if (!pool.weights.has(w)) pool.weights.set(w, LEARNED);
  }
  pool.round++;
  const cf = ready && ready.stamp === cx ? ready.cf : codeFirst(repoDir, { query: q || pool.first, weights: pool.weights, avoid: pool.avoid, paths, use: pool.learned ? pool.learned.use : null });
  const prefetched = !!(ready && ready.stamp === cx);
  for (const k of [...ahead.keys()]) if (k.startsWith(pool.id + ':')) ahead.delete(k);
  let body;
  if (pool.round === 1) {
    body = cf.answer;
    for (const ring of ['core', 'wiring', 'surface']) for (const e of (body.map || {})[ring] || []) { const k = keyOf(ring, e); pool.shown.set(k, 1); pool.visible.add(k); }
  } else body = changesOf(pool, cf.answer);
  remember(pool, body);
  const words = [...pool.weights].filter(([w]) => !w.includes('_')).sort((a, b) => b[1] - a[1])
    .map(([w, m]) => (pool.spell.get(w) || w) + (m < 1 ? ' (' + m + ')' : ''));
  cf.monitor.phases.question = { kind, why, round: pool.round, prefetched: prefetched || undefined };
  pool.suggested = (body.map && body.map.words) || body.next_words || [];
  pool.paths = paths;
  return {
    answer: {
      asked: q || undefined,
      question: kind,
      why,
      round: pool.round,
      words: words.length ? words : undefined,
      dropped: pool.avoid.size ? [...pool.avoid].map((w) => pool.spell.get(w) || w) : undefined,
      ...body,
      asked_first: pool.round > 1 ? pool.first : undefined,
      learned: pool.round === 1 && pool.learned ? {
        from: pool.learned.paths + ' earlier walk' + (pool.learned.paths === 1 ? '' : 's') + ' of questions like this, the newest ' + String(pool.learned.newest).slice(0, 10),
        words_added: pool.learned.words.length ? pool.learned.words : undefined,
        they_read: pool.learned.read.length ? pool.learned.read.map((x) => x.what + ' - ' + x.opened) : undefined,
        note: 'a hint from earlier agents, never the whole answer: the map above is searched fresh'
      } : undefined
    },
    monitor: cf.monitor,
    kind,
    words: [...pool.weights.keys()]
  };
}
