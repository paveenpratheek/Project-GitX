/*
 * What every recorded walk teaches the next agent (step 6 of t-4c167bea08).
 * learn.js learns only from declared paths (t-eef3ec6b17), and agents rarely
 * declare, so nothing was ever learned; every GitX call is recorded now
 * (t-459c928c01), and what an agent did after asking says what it needed:
 *
 *   vocabulary   the words it added while refining - a question asked in
 *                the agent's words reaches code written in other words once
 *                an earlier agent made the step ("size" to "height")
 *   use          what it opened - a function expanded, a thought or commit
 *                read - and what it cited when it recorded; what it was
 *                shown and left counts a little against
 *
 * Per question key - the question's rare words, as keyOf makes it - with the
 * keys of earlier questions matched by overlap, so a rewording still finds
 * them. Counts are Beta evidence, a = used and b = shown and left, each
 * multiplied by DECAY per day of age, so a route nobody took for a month
 * counts for about half and a feature rebuilt since stops being pointed at
 * (t-11190c437f: a learned route is a hint, never the answer). The mean
 * (a + 1) / (a + b + 2) orders; nothing is hidden by it.
 *
 * Read from the path files on every call, kept until one of them changes.
 *
 * Two things the first learning rounds missed (t-6d46b4df16), both here:
 *   chains    an agent that asks, rewords and then opens the answer did all
 *             of it for its first question - the opens were filed under the
 *             rewording, and the next agent asking in the first words matched
 *             a walk with nothing used in it. One agent's walks within
 *             CHAIN_GAP of each other share what was used, and the earlier
 *             ones learn the later questions' words as words added - when
 *             they are about the same thing (search-chain.js): an agent
 *             working through a list asks unrelated questions minutes apart.
 *   reads     what the agent read with its own tools, from hook.js: a thought
 *             file is that thought, a range of a code file the functions it
 *             covers - counted like an open for the walk it happened in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readPaths, pathsHome } from './path-recorder.js';
import { keyOf, ASKING } from './learn.js';
import { termsOf, questionTerms, buildCodeIndex, shortName } from './code-find.js';
import { repoKey } from './path-recorder.js';
import { searches, walkForEvent } from './search-chain.js';

const DECAY = 0.98;          // per day of a path's age
const USED = 1;              // opened or expanded
const CITED = 2;             // cited from the stack when recording
const MARKED = 2;            // marked by the agent as where the answer was (gitx_mark) - a citation, not a look
const LEFT = 0.25;           // shown in the answer and not opened
const LEARN_MIN = 1.5;       // a word is learned once paths worth this much added it (two recent)
const KEY_OVERLAP = 0.5;     // keys match when they share this share of the larger one
const PATHS_READ = 5000;
const READ = 1;              // read with the agent's own tools, through hook.js
const READ_AFTER = 10 * 60 * 1000;  // reads this long after an agent's last walk still belong to it
const WHOLE_FILE = 3;       // a read with no range counts for a file of at most this many functions

/* A code node's name that survives line shifts: the file and the function. */
export function codeKey(id, text) {
  const file = String(id).replace(/^code:/, '').replace(/:\d+$/, '');
  const name = String(text || '').split(' · ')[1];
  return file + '::' + (name ? name.replace(/\s+\d+-\d+$/, '') : '');
}
const nodeKey = (n) => (n && String(n.id).startsWith('code:') ? codeKey(n.id, n.text) : n ? String(n.id) : null);

const cache = new Map();     // paths folder -> { sig, walks }
function folderSig(dir) {
  let n = 0, newest = 0;
  try { for (const f of fs.readdirSync(dir)) { n++; const s = fs.statSync(path.join(dir, f)); if (s.mtimeMs > newest) newest = s.mtimeMs; } } catch (_) { return 'none'; }
  return n + ':' + newest;
}

/* Every recorded walk that began with a question, reduced to what it teaches. */
function walks(repoDir, dataDir, rx) {
  const dir = pathsHome(repoDir, dataDir);
  const sig = folderSig(dir) + '|' + folderSig(path.join(dataDir || '', 'reads'));
  const hit = cache.get(dir);
  if (hit && hit.sig === sig) return hit.walks;
  const now = Date.now();
  const out = [];
  for (const p of readPaths(repoDir, dataDir, PATHS_READ)) {
    if (p.started_by || !p.question || !p.question.query) continue;
    const key = keyOf(rx, p.question.query);
    if (!key.length) continue;
    const weight = DECAY ** Math.max(0, (now - Date.parse(p.at)) / 86400000);
    const asked = new Set(termsOf(p.question.query));
    const added = new Set(), used = new Map(), names = new Map(), notes = new Map(), marked = new Set();
    for (const s of p.path || []) {
      if (s.kind === 'refine' && s.asked) {
        for (const part of String(s.asked).split(/\s+/)) {
          if (part.startsWith('-')) continue;
          for (const w of termsOf(part.replace(/^\+/, ''))) if (!w.includes('_') && !asked.has(w) && !ASKING.has(w)) added.add(w);
        }
      }
      if (s.kind === 'open' && s.node) { const k = nodeKey(s.node); if (k) { used.set(k, Math.max(used.get(k) || 0, USED)); names.set(k, s.node.text || s.node.id); } }
      if (s.kind === 'declare') for (const c of s.cited_in_stack || []) used.set(String(c), CITED);
      /* A mark counts whether or not the answer showed it: finding it
       * elsewhere is the point (tools/mark.js). */
      if (s.kind === 'mark') for (const m of s.marks || []) {
        used.set(m.key, Math.max(used.get(m.key) || 0, MARKED)); marked.add(m.key);
        if (!names.has(m.key)) names.set(m.key, m.name || m.key);
        if (s.note) notes.set(m.key, s.note);
      }
    }
    const shown = new Map();
    for (const n of (p.stack && p.stack.nodes) || []) if (n.role === 'result') { const k = nodeKey(n); if (k) { shown.set(k, 1); if (!names.has(k)) names.set(k, n.text || n.id); } }
    out.push({ id: p.id, at: p.at, key, weight, added: [...added], used, shown, names, notes, marked, agent: (p.agent && p.agent.id) || null, repo: p.repo || null, asked });
  }
  creditReads(repoDir, dataDir, out);
  chain(out);
  cache.set(dir, { sig, walks: out });
  return out;
}

/* One agent's walks, in order, cut into searches - close in time and about
 * the same thing (search-chain.js): within a search each walk is credited
 * with what the later ones used, and learns their questions' words as its
 * own added words. */
function chain(out) {
  const byAgent = new Map();
  for (const w of out) if (w.agent) { if (!byAgent.has(w.agent)) byAgent.set(w.agent, []); byAgent.get(w.agent).push(w); }
  for (const all of byAgent.values()) {
    all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const ws of searches(all.map((w) => ({ w, at: w.at, words: new Set(w.key), nodes: new Set(w.shown.keys()) }))).map((g) => g.map((x) => x.w))) {
    const own = ws.map((w) => ({ used: new Map(w.used), words: [...questionTerms([...w.asked].join(' '))].filter((t) => !t.includes('_')) }));
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        for (const [k, v] of own[j].used) ws[i].used.set(k, Math.max(ws[i].used.get(k) || 0, v));
        for (const [k, n] of ws[j].names) if (!ws[i].names.has(k)) ws[i].names.set(k, n);
        for (const [k, n] of ws[j].notes) if (!ws[i].notes.has(k)) ws[i].notes.set(k, n);
        for (const k of ws[j].marked) ws[i].marked.add(k);
        for (const t of [...own[j].words, ...ws[j].added]) if (!ws[i].asked.has(t) && !ASKING.has(t) && !ws[i].added.includes(t)) ws[i].added.push(t);
      }
    }
    }
  }
}

/* hook.js's lines for this repository, read once per change of the file. */
const readsCache = new Map();
function readsOf(repoDir, dataDir) {
  const file = path.join(dataDir || '', 'reads', repoKey(repoDir) + '.jsonl');
  let st; try { st = fs.statSync(file); } catch (_) { return []; }
  const hit = readsCache.get(file);
  if (hit && hit.m === st.mtimeMs) return hit.reads;
  const reads = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { try { if (l.trim()) reads.push(JSON.parse(l)); } catch (_) {} }
  readsCache.set(file, { m: st.mtimeMs, reads });
  return reads;
}

/* Each read goes to the walk it belongs to (search-chain.js): the latest
 * walk in the same repository folder, within READ_AFTER before it, that it
 * relates to - the thought or a function in that walk's answer, a file the
 * answer pointed into, or code holding the question's own words. A read that
 * relates to no walk teaches nothing. A thought file is the thought; a code
 * range, the functions it covers at HEAD. */
function creditReads(repoDir, dataDir, out) {
  const reads = readsOf(repoDir, dataDir);
  if (!reads.length) return;
  let regions = null;
  const touchedOf = (r) => {
    if (!regions) { try { regions = buildCodeIndex(repoDir).regions; } catch (_) { regions = []; } }
    const inFile = regions.filter((x) => x.file === r.file && x.kind !== 'doc');
    return { inFile, hit: r.from ? inFile.filter((x) => x.to >= r.from && x.from <= (r.to || r.from + 200)) : inFile.length <= WHOLE_FILE ? inFile : [] };
  };
  const keysOf = (r) => (r.thought ? [r.thought] : touchedOf(r).hit.map((x) => x.file + '::' + shortName(x)));
  const wordsOf = (w) => new Set([...w.key, ...questionTerms([...w.asked].join(' '))].filter((t) => !t.includes('_')));
  const relates = (w, r) => {
    const keys = keysOf(r);
    if (keys.some((k) => w.shown.has(k) || w.used.has(k))) return true;
    if (r.thought) return false;
    if ([...w.shown.keys()].some((k) => k.split('::')[0] === r.file)) return true;
    const words = wordsOf(w), { inFile, hit } = touchedOf(r);
    return (r.from ? hit : inFile).some((x) => [...words].some((t) => x.own && x.own.has(t)));
  };
  const same = (a, b) => !!a && !!b && path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  for (const r of reads) {
    const w = walkForEvent(out.filter((x) => same(r.repo, x.repo)), r.at, READ_AFTER, (x) => relates(x, r));
    if (!w) continue;
    for (const k of keysOf(r)) { w.used.set(k, Math.max(w.used.get(k) || 0, READ)); if (!w.names.has(k)) w.names.set(k, k); }
  }
}

const overlap = (a, b) => { const B = new Set(b); const n = a.filter((w) => B.has(w)).length; return n / Math.max(a.length, b.length); };

/* What earlier walks teach a new question: the words their agents added,
 * learned once LEARN_MIN worth of paths added them, and how much each node
 * was used - with the names to show. Empty when no earlier question is
 * like this one. */
export function learnFor(repoDir, dataDir, rx, query) {
  const key = keyOf(rx, query);
  if (!key.length) return null;
  const like = walks(repoDir, dataDir, rx).filter((w) => overlap(key, w.key) >= KEY_OVERLAP);
  if (!like.length) return null;
  const words = new Map(), nodes = new Map(), names = new Map(), notes = new Map(), marks = new Map();
  for (const w of like) {
    for (const t of w.added) words.set(t, (words.get(t) || 0) + w.weight);
    for (const k of w.marked || []) marks.set(k, (marks.get(k) || 0) + 1);
    for (const [k, n] of w.notes || []) notes.set(k, n);
    for (const [k, v] of w.used) { const e = nodes.get(k) || { a: 0, b: 0 }; e.a += v * w.weight; nodes.set(k, e); }
    for (const k of w.shown.keys()) if (!w.used.has(k)) { const e = nodes.get(k) || { a: 0, b: 0 }; e.b += LEFT * w.weight; nodes.set(k, e); }
    for (const [k, n] of w.names) names.set(k, n);
  }
  const mean = (e) => (e.a + 1) / (e.a + e.b + 2);
  const use = new Map([...nodes].map(([k, e]) => [k, { mean: mean(e), a: e.a, b: e.b, marked: marks.get(k) || 0 }]));
  /* What agents marked as the answer comes before what they only opened or read. */
  const used = [...nodes].filter(([, e]) => e.a > 0).sort((x, y) => (marks.get(y[0]) || 0) - (marks.get(x[0]) || 0) || mean(y[1]) - mean(x[1]) || y[1].a - x[1].a);
  return {
    paths: like.length,
    newest: like.map((w) => w.at).sort().pop(),
    words: [...words].filter(([, v]) => v >= LEARN_MIN).sort((a, b) => b[1] - a[1]).map(([t]) => t),
    use,
    read: used.slice(0, 5).map(([k, e]) => {
      /* A thought or a commit by its id first, so it can be opened. */
      const name = String(names.get(k) || k).replace(/\s+/g, ' ').slice(0, 120);
      const what = k.includes('::') ? name : (name.startsWith(k) ? name : k + ' ' + name);
      return { what, key: k, opened: Math.round(e.a * 10) / 10 + ' of ' + like.length + ' walks', marked: marks.get(k) || undefined, note: notes.get(k) || undefined };
    })
  };
}
