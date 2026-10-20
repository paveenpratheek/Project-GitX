/*
 * The map as interconnected nodes: each section of GitX.md is a node, and
 * GitX links the nodes from the code itself, so a question gets a stack -
 * the sections its words land on and the sections linked to those - rather
 * than one section or the whole map.
 *
 * One section per question was cheap and fast and less accurate: readers
 * given only the section they opened (or none, when no index title matched
 * the question) lost to readers given the whole map, who could follow a
 * question across links, areas, file drops and the pointer handler. The
 * whole map cost 22k more tokens a question. A stack keeps what the whole
 * map gave - everything a question touches, connected - at about the cost
 * of the parts (docs/word-graph-plan.md).
 *
 * Every link says why it exists (t-dae10242a7), and every reason is one GitX
 * can check in the code, so no agent invents the structure:
 *   same code    both sections own the same function
 *   uses         a function one section owns calls a name another owns
 *   shared state both name the same state field
 *   mentioned    one section's text names a function the other owns
 * A section owns the names on its Grep: line (else every name it gives).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { termsOf, questionTerms, shortName } from './code-find.js';
import { mapPath, regionsFor, sectionsOf, bodyOf } from './gitx-map.js';

const NAME = /[A-Za-z_$][\w$-]*[\w$]/g;
const namesIn = (text) => {
  const out = new Set();
  for (const m of String(text).matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].includes('::') ? m[1].split('::').slice(1).join('::') : m[1];
    for (const n of span.matchAll(NAME)) if (n[0].length >= 4 && !/\.(js|css|html|md|json|py)$/i.test(n[0])) out.add(n[0].replace(/^state\./, ''));
  }
  return out;
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map();   // dir -> { sig, graph }

/* The nodes and their links, rebuilt when the map or the code changes. */
export function mapGraph(dir, file = mapPath(dir)) {
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  const regions = regionsFor(dir).filter((r) => r.kind !== 'doc');
  const sig = crypto.createHash('sha1').update(text).update(String(regions.length) + ':' + regions.reduce((n, r) => n + r.to, 0)).digest('hex');
  const hit = cache.get(dir);
  if (hit && hit.sig === sig) return hit.graph;

  const body = bodyOf(text);
  const lines = body.split('\n');
  const shift = text.split('\n').length - lines.length;   // body line k is file line k + shift
  const secs = sectionsOf(body).filter((x) => !x.kind && (x.level === 3 || !/^features\b/i.test(x.title)));
  const defs = new Map();
  /* What the code defines, by name - not a region that starts with a statement (if, for). */
  const STATEMENT = /^(if|for|while|switch|try|catch|else|return|do|body|html|head)$/;
  for (const r of regions) { const n = shortName(r); if (!n || STATEMENT.test(n)) continue; if (!defs.has(n)) defs.set(n, []); defs.get(n).push(r); }

  const nodes = secs.map((s, i) => {
    const t = lines.slice(s.from - 1, s.to).join('\n');
    const grep = /^Grep:\s*(.+)$/m.exec(t);
    const all = namesIn(t);
    const own = grep ? namesIn(grep[1]) : all;
    const ownFns = [...own].filter((n) => defs.has(n));
    return {
      id: 's' + i, title: s.title, from: s.from + shift, to: s.to + shift, text: t,
      own: new Set(ownFns), mentions: new Set([...all].filter((n) => defs.has(n) && !own.has(n))),
      fields: new Set([...all].filter((n) => !defs.has(n))),
      terms: termsOf(s.title + ' ' + t), title_terms: termsOf(s.title)
    };
  });

  /* A name most sections own, call or name is the app's spine - state,
   * render, scheduleRender, drawGrid - not a relation: counted as links it
   * tied all 19 of file-fabric's sections to each other (143 links) and
   * every question pulled in nearly the whole map. */
  const calls = (n, m) => (defs.get(n) || []).some((r) => new RegExp('\\b' + esc(m) + '\\b').test(r.text));
  const spread = new Map();
  for (const n of nodes) {
    const touched = new Set([...n.own, ...n.mentions, ...n.fields]);
    for (const m of defs.keys()) if (!touched.has(m) && [...n.own].some((o) => o !== m && calls(o, m))) touched.add(m);
    for (const m of touched) spread.set(m, (spread.get(m) || 0) + 1);
  }
  const SPINE = Math.max(3, Math.ceil(nodes.length * 0.25));
  const spine = (m) => (spread.get(m) || 0) > SPINE;
  /* Sections that are lists of everything (Open leads) are entered by their
   * words, never pulled in by links. */
  const listy = (n) => /^open leads|^leads\b|^unread/i.test(n.title);

  const links = [];
  for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
    if (i === j) continue;
    const a = nodes[i], b = nodes[j];
    if (listy(a) || listy(b)) continue;
    const why = [];
    if (i < j) for (const n of a.own) if (b.own.has(n) && !spine(n)) why.push({ type: 'same code', name: n });
    /* a uses b: a function a owns calls a name b owns. */
    const uses = new Set();
    for (const n of a.own) for (const r of defs.get(n) || []) for (const m of b.own) {
      if (a.own.has(m) || uses.has(m) || spine(m)) continue;
      if (new RegExp('\\b' + esc(m) + '\\b').test(r.text)) uses.add(m);
    }
    for (const m of uses) why.push({ type: 'uses', name: m });
    for (const n of a.mentions) if (b.own.has(n) && !spine(n)) why.push({ type: 'mentioned', name: n });
    if (i < j) for (const f of a.fields) if (b.fields.has(f) && !spine(f)) why.push({ type: 'shared state', name: f });
    if (!why.length) continue;
    const W = { 'same code': 1, uses: 0.5, mentioned: 0.5, 'shared state': 0.3 };
    const weight = Math.min(1, why.reduce((s, x) => s + W[x.type], 0) / 2);
    links.push({ from: a.id, to: b.id, weight: Math.round(weight * 100) / 100, why: why.slice(0, 6) });
    /* Same code and shared state run both ways. */
    if (i < j && why.some((x) => x.type === 'same code' || x.type === 'shared state')) {
      const back = why.filter((x) => x.type === 'same code' || x.type === 'shared state');
      links.push({ from: b.id, to: a.id, weight: Math.min(1, back.reduce((s, x) => s + W[x.type], 0) / 2), why: back.slice(0, 6) });
    }
  }
  /* Two links between the same pair, one each way of i<j and j>i: keep the stronger. */
  const best = new Map();
  for (const l of links) { const k = l.from + '>' + l.to; if (!best.has(k) || best.get(k).weight < l.weight) best.set(k, l); }
  const graph = { file, nodes, links: [...best.values()], spine: [...spread].filter(([m]) => spine(m)).map(([m]) => m) };
  cache.set(dir, { sig, graph });
  return graph;
}

/* The stack for a question: the sections its words land on (by how rare
 * each word is across the sections), then the sections linked to those,
 * strongest first, until the budget. */
export const STACK_BUDGET = 12000;     // characters, about 3.3k tokens
const PULL_MIN = 0.5, PULL_MAX = 4;    // only strong links, and a few of them
export function mapStack(dir, query, { budget = STACK_BUDGET, file = mapPath(dir) } = {}) {
  const g = mapGraph(dir, file);
  if (!g || !g.nodes.length) return null;
  const q = [...questionTerms(query)];
  const N = g.nodes.length;
  const df = new Map(q.map((t) => [t, g.nodes.filter((n) => n.terms.has(t)).length]));
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 0.5));
  const scored = g.nodes.map((n) => {
    const hit = q.filter((t) => n.terms.has(t) && df.get(t) < N);
    return { n, score: hit.reduce((s, t) => s + idf(t) * (n.title_terms.has(t) ? 1.5 : 1), 0), hit };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { entries: [], pulled: [], text: '' };
  const top = scored[0].score;
  const entries = scored.filter((x) => x.score >= top * 0.4).slice(0, 4);
  const inStack = new Set(entries.map((x) => x.n.id));
  /* Pulled by links from each entry, weighed by the entry's score. */
  const cand = new Map();
  for (const e of entries) for (const l of g.links.filter((x) => x.from === e.n.id && !inStack.has(x.to) && x.weight >= PULL_MIN)) {
    const s = (e.score / top) * l.weight;
    const c = cand.get(l.to);
    if (!c || c.s < s) cand.set(l.to, { s, from: e.n, link: l });
  }
  const pulled = [...cand.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, PULL_MAX).map(([id, c]) => ({ n: g.nodes.find((x) => x.id === id), ...c }));
  const rel = path.relative(dir, g.file).replace(/\\/g, '/');
  const parts = [];
  let used = 0;
  const add = (n, why) => {
    const block = '### ' + n.title + ' (' + rel + ' lines ' + n.from + '-' + n.to + ') - ' + why + '\n' + n.text.split('\n').slice(1).join('\n').trim();
    if (used + block.length > budget && parts.length) return false;
    parts.push(block); used += block.length; return true;
  };
  const shownEntries = [], shownPulled = [];
  for (const e of entries) if (add(e.n, 'matched: ' + e.hit.slice(0, 5).join(', '))) shownEntries.push(e.n.title);
  for (const p of pulled) {
    if (!add(p.n, 'linked from ' + p.from.title + ': ' + p.link.why.slice(0, 3).map((w) => w.type + ' ' + w.name).join(', '))) break;
    shownPulled.push(p.n.title);
  }
  const left = [...entries.map((e) => e.n.title), ...pulled.map((p) => p.n.title)].filter((t) => !shownEntries.includes(t) && !shownPulled.includes(t));
  return {
    entries: shownEntries, pulled: shownPulled, left,
    text: 'GitX map sections for this question, from ' + rel + ' - where to start, not the answer: check the code. The sections the question\'s words land on come first, then the sections linked to them in the code.' + (left.length ? ' Also linked, not shown (budget): ' + left.join('; ') + '.' : '') + '\n\n' + parts.join('\n\n')
  };
}
