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
 */

import fs from 'node:fs';
import path from 'node:path';
import { readPaths, pathsHome } from './path-recorder.js';
import { keyOf, ASKING } from './learn.js';
import { termsOf } from './code-find.js';

const DECAY = 0.98;          // per day of a path's age
const USED = 1;              // opened or expanded
const CITED = 2;             // cited from the stack when recording
const LEFT = 0.25;           // shown in the answer and not opened
const LEARN_MIN = 1.5;       // a word is learned once paths worth this much added it (two recent)
const KEY_OVERLAP = 0.5;     // keys match when they share this share of the larger one
const PATHS_READ = 5000;

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
  const sig = folderSig(dir);
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
    const added = new Set(), used = new Map(), names = new Map();
    for (const s of p.path || []) {
      if (s.kind === 'refine' && s.asked) {
        for (const part of String(s.asked).split(/\s+/)) {
          if (part.startsWith('-')) continue;
          for (const w of termsOf(part.replace(/^\+/, ''))) if (!w.includes('_') && !asked.has(w) && !ASKING.has(w)) added.add(w);
        }
      }
      if (s.kind === 'open' && s.node) { const k = nodeKey(s.node); if (k) { used.set(k, Math.max(used.get(k) || 0, USED)); names.set(k, s.node.text || s.node.id); } }
      if (s.kind === 'declare') for (const c of s.cited_in_stack || []) used.set(String(c), CITED);
    }
    const shown = new Map();
    for (const n of (p.stack && p.stack.nodes) || []) if (n.role === 'result') { const k = nodeKey(n); if (k) { shown.set(k, 1); if (!names.has(k)) names.set(k, n.text || n.id); } }
    out.push({ id: p.id, at: p.at, key, weight, added: [...added], used, shown, names });
  }
  cache.set(dir, { sig, walks: out });
  return out;
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
  const words = new Map(), nodes = new Map(), names = new Map();
  for (const w of like) {
    for (const t of w.added) words.set(t, (words.get(t) || 0) + w.weight);
    for (const [k, v] of w.used) { const e = nodes.get(k) || { a: 0, b: 0 }; e.a += v * w.weight; nodes.set(k, e); }
    for (const k of w.shown.keys()) if (!w.used.has(k)) { const e = nodes.get(k) || { a: 0, b: 0 }; e.b += LEFT * w.weight; nodes.set(k, e); }
    for (const [k, n] of w.names) names.set(k, n);
  }
  const mean = (e) => (e.a + 1) / (e.a + e.b + 2);
  const use = new Map([...nodes].map(([k, e]) => [k, { mean: mean(e), a: e.a, b: e.b }]));
  const used = [...nodes].filter(([, e]) => e.a > 0).sort((x, y) => mean(y[1]) - mean(x[1]) || y[1].a - x[1].a);
  return {
    paths: like.length,
    newest: like.map((w) => w.at).sort().pop(),
    words: [...words].filter(([, v]) => v >= LEARN_MIN).sort((a, b) => b[1] - a[1]).map(([t]) => t),
    use,
    read: used.slice(0, 5).map(([k, e]) => {
      /* A thought or a commit by its id first, so it can be opened. */
      const name = String(names.get(k) || k).replace(/\s+/g, ' ').slice(0, 120);
      const what = k.includes('::') ? name : (name.startsWith(k) ? name : k + ' ' + name);
      return { what, key: k, opened: Math.round(e.a * 10) / 10 + ' of ' + like.length + ' walks' };
    })
  };
}
