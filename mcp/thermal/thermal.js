/*
 * Thermal vision - the 4th Dimension, v2.
 *
 * Path learning (walk-learn.js) remembers which nodes a QUESTION led to, keyed
 * by the question's rare words: ask again in the same words and the route
 * comes back; ask in other words and nothing does. On the held-out set it
 * learned routes for repeated wording and learned no word at all (0 of 14),
 * because agents reword in their own reasoning and then read files, which
 * the word learner never saw.
 *
 * Here the memory is the CODE, not the question. Code at HEAD is the present
 * truth, so what agents did becomes heat on the lines they used, and the
 * words that brought them there attach to those lines:
 *
 *   heat     every line an agent expanded, read, cited or edited, weighted by
 *            the event - a whole-file read spreads toward the lines holding
 *            the question's words, since it does not say which lines mattered
 *   words    the distinctive words of the agent's whole chain of questions
 *            attach to the regions and thoughts it used; a rewording that
 *            found the answer teaches the first wording too
 *   links    two words attached to the same code are linked THROUGH it: ask
 *            with one, and the region comes back, and so do the regions and
 *            thoughts the other word is attached to - word -> region -> word,
 *            learned from evidence, not from a synonym list
 *   identity a line is (the commit that wrote it, its line number in that
 *            commit), the identity git blame gives, so heat follows a line
 *            when code around it moves and dies when the line is rewritten
 *
 * What it feeds the answer: learned use for the nodes the question's words
 * are attached to, words to widen the search with, the hottest lines of each
 * tree in place of a generic cut, and, per tree, the reasons behind the hot
 * lines - feature or passing commits, what each settled, the ideas that lost
 * to it, and older commits on those lines from git log -L.
 *
 * Read from the walk folder on every call and kept until something in it
 * changes. Nothing here writes: hook.js and the path recorder do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NO_CONSOLE } from '../tools/no-console.js';
import { readPaths, pathsHome, repoKey } from '../tools/path-recorder.js';
import { buildCodeIndex, questionTerms, termsOf, shortName, rankIndexFor } from '../tools/code-find.js';
import { searches, walkForEvent } from '../tools/search-chain.js';

const DAY = 86400000;
const DECAY = 0.98;              // per day of an event's age, as path learning
const READ_AFTER = 10 * 60000;   // a read this long after an agent's last question still belongs to it
const CITE_AFTER = 60 * 60000;   // a final answer cites what the whole session found
const EV = { expand: 1, read: 1, edit: 2, cite: 2, open: 1, shown: 0.25 };
const SPREAD_HIT = 1, SPREAD_OTHER = 0.15;   // a whole-file read: lines holding the words, and the rest
const RANGE_REGIONS = 3;         // a read across more functions than this attaches less to each
const RARE = 0.12;               // a word attaches only if it is in at most this share of regions
const MIN_A = 0.9, MIN_MEAN = 0.6;   // evidence before a word counts for a node
const EXPAND_W = 0.4, EXPAND_MAX = 6;
const HOT_LINES = 22;

const git = (cwd, args) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const norm = (p) => path.resolve(String(p || '').replace(/^\/([a-z])\//i, (_, d) => d + ':/')).toLowerCase();
const age = (at) => DECAY ** Math.max(0, (Date.now() - Date.parse(at)) / DAY);
const regionKey = (r) => r.file + '::' + shortName(r);

/* ------------------------------------------------------------ line identity */

/* git blame with where each line was born: line i -> "<commit12>:<line in it>". */
const blames = new Map();
function blameIds(repoDir, rev, file) {
  const key = rev + '\0' + file;
  if (blames.has(key)) return blames.get(key);
  const out = [];
  try {
    for (const l of git(repoDir, ['blame', '--porcelain', rev, '--', file]).split('\n')) {
      const m = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
      if (m) out[Number(m[3]) - 1] = m[1].slice(0, 12) + ':' + m[2];
    }
  } catch (_) { /* a file that is gone */ }
  blames.set(key, out);
  return out;
}

/* Lines recorded at another HEAD, moved to where they are now - or dropped,
 * when they were rewritten since: new code, so the old evidence is not about it. */
function toCurrent(repoDir, head, evHead, file, lines) {
  if (!evHead || evHead === head) return lines;
  const then = blameIds(repoDir, evHead, file), now = blameIds(repoDir, head, file);
  const where = new Map(now.map((id, i) => [id, i + 1]));
  return lines.map((n) => where.get(then[n - 1])).filter(Boolean);
}

/* ------------------------------------------------------------ the evidence */

function jsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; }
}

/* The words a walk teaches: the distinctive ones of its question and of the
 * questions its agent asked around it about the same thing, rewordings
 * included (search-chain.js) - not every question of a session. */
const stackNodes = (w) => new Set(((w.stack && w.stack.nodes) || []).filter((n) => n.role === 'result').map((n) => String(n.id)));
const askedWords = (w, rare) => { const out = new Set(); for (const s of [w.question.query, ...(w.path || []).filter((x) => x.kind === 'refine').map((x) => x.asked)]) for (const t of questionTerms(s || '')) if (!t.includes('_') && rare(t)) out.add(t); return out; };
function chainWords(walks, rare) {
  const byAgent = new Map();
  for (const w of walks) { const a = (w.agent && w.agent.id) || w.id; if (!byAgent.has(a)) byAgent.set(a, []); byAgent.get(a).push(w); }
  for (const ws of byAgent.values()) {
    ws.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const group of searches(ws.map((w) => ({ w, at: w.at, words: askedWords(w, rare), nodes: stackNodes(w) }))).map((g) => g.map((x) => x.w))) {
      const words = new Set();
      for (const w of group) for (const s of [w.question.query, ...(w.path || []).filter((x) => x.kind === 'refine').map((x) => x.asked)]) for (const t of questionTerms(s || '')) if (!t.includes('_')) words.add(t);
      for (const w of group) w._words = words;
    }
  }
}

/* The walk an event made outside GitX belongs to (search-chain.js): the same
 * repository folder, the latest question within the window before it that
 * the event relates to. */
function walkFor(walks, ev, window, relates) {
  const repo = norm(ev.repo);
  return walkForEvent(walks.filter((w) => norm(w.repo) === repo), ev.at, window, relates);
}

/* ------------------------------------------------------------ the model */

const models = new Map();
function folderSig(dir) {
  let n = 0, newest = 0;
  try { for (const f of fs.readdirSync(dir)) { n++; const s = fs.statSync(path.join(dir, f)); if (s.mtimeMs > newest) newest = s.mtimeMs; } } catch (_) { return '-'; }
  return n + ':' + newest;
}

export function thermalFor(repoDir, dataDir) {
  if (!dataDir) return null;
  const head = git(repoDir, ['rev-parse', 'HEAD']).trim();
  const key = repoKey(repoDir);
  const sig = [head, folderSig(pathsHome(repoDir, dataDir)), folderSig(path.join(dataDir, 'reads')), folderSig(path.join(dataDir, 'thermal'))].join('|');
  const hit = models.get(repoDir + '|' + dataDir);
  if (hit && hit.sig === sig) return hit.model;

  const cx = buildCodeIndex(repoDir);
  const rare = (w) => (cx.df.get(w) || 0) <= cx.regions.length * RARE;
  const byFile = new Map();
  for (const r of cx.regions) { if (r.kind === 'doc') continue; if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  const resolveFile = (f) => {
    const s = String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (byFile.has(s)) return s;
    const hits = [...byFile.keys()].filter((k) => k.endsWith('/' + s) || k === s);
    return hits.length === 1 ? hits[0] : null;
  };
  const regionAt = (file, line) => (byFile.get(file) || []).find((r) => line >= r.from && line <= r.to) || null;

  const walks = readPaths(repoDir, dataDir, 5000).filter((p) => !p.started_by && p.question && p.question.query);
  chainWords(walks, rare);
  /* Does an event relate to a walk: a thought in its answer or holding its
   * words, a file its answer pointed into, code holding its words. */
  let rx = null;
  const thoughtWords = (id) => { if (!rx) { try { rx = rankIndexFor(repoDir); } catch (_) { rx = { nodes: new Map() }; } } const n = rx.nodes.get(id); return n ? n.own : new Set(); };
  const answerFiles = (w) => new Set([...stackNodes(w)].filter((id) => id.startsWith('code:')).map((id) => resolveFile(id.slice(5, id.lastIndexOf(':')))).filter(Boolean));
  const relatesThought = (w, id) => stackNodes(w).has(id) || [...(w._words || [])].some((t) => thoughtWords(id).has(t));
  const relatesCode = (w, fileIn, from, to) => {
    const file = resolveFile(fileIn);
    if (!file) return false;
    if (answerFiles(w).has(file)) return true;
    const regs = (byFile.get(file) || []).filter((r) => !from || (r.to >= from && r.from <= (to || from)));
    return regs.some((r) => [...(w._words || [])].some((t) => rare(t) && r.own && r.own.has(t)));
  };

  const vocab = new Map();        // node key -> Map(word -> { a, b })
  const heat = new Map();         // file -> Map(line -> [{ w, words }])
  const used = new Map();         // walk id -> Set(node keys used)
  const attach = (node, words, a, b = 0) => {
    if (!vocab.has(node)) vocab.set(node, new Map());
    const v = vocab.get(node);
    for (const w of words) { if (!rare(w)) continue; const e = v.get(w) || { a: 0, b: 0 }; e.a += a; e.b += b; v.set(w, e); }
  };
  const warm = (file, lines, w, words) => {
    if (!heat.has(file)) heat.set(file, new Map());
    const h = heat.get(file);
    for (const n of lines) { if (!h.has(n)) h.set(n, []); h.get(n).push({ w, words }); }
  };
  const use = (walk, node) => { if (!used.has(walk.id)) used.set(walk.id, new Set()); used.get(walk.id).add(node); };
  const range = (from, to) => { const out = []; for (let n = from; n <= to; n++) out.push(n); return out; };

  /* One code event: lines warmed, words attached to the regions they cover. */
  const codeEvent = (walk, kind, fileIn, from, to, evHead, at) => {
    const file = resolveFile(fileIn);
    if (!file || !walk._words || !walk._words.size) return;
    const f = age(at), words = walk._words, base = EV[kind] * f;
    const regs = byFile.get(file) || [];
    if (!from) {                                   // a whole file: spread toward the question's words
      const text = (() => { try { return git(repoDir, ['show', 'HEAD:' + file]).split('\n'); } catch (_) { return []; } })();
      const hits = [];
      text.forEach((l, i) => { if ([...termsOf(l)].some((t) => words.has(t))) hits.push(i + 1); });
      warm(file, hits, base * SPREAD_HIT, words);
      const per = new Map();
      for (const n of hits) { const r = regionAt(file, n); if (r) per.set(r, (per.get(r) || 0) + 1); }
      const most = Math.max(1, ...per.values());
      for (const [r, k] of per) { attach(regionKey(r), words, base * (k / most)); use(walk, regionKey(r)); }
      warm(file, range(1, text.length).filter((n) => !hits.includes(n)), base * SPREAD_OTHER, words);
      return;
    }
    const lines = toCurrent(repoDir, head, evHead, file, range(from, Math.min(to || from, from + 400)));
    if (!lines.length) return;
    warm(file, lines, base, words);
    const touched = regs.filter((r) => lines.some((n) => n >= r.from && n <= r.to));
    const share = touched.length > RANGE_REGIONS ? RANGE_REGIONS / touched.length : 1;
    for (const r of touched) { attach(regionKey(r), words, base * share); use(walk, regionKey(r)); }
  };

  /* From the walks: what GitX opened for the agent, and what it showed. */
  for (const w of walks) {
    for (const s of w.path || []) {
      if (s.kind !== 'open' || !s.node) continue;
      const id = String(s.node.id);
      if (id.startsWith('code:')) {
        const rest = id.slice(5), at = rest.lastIndexOf(':');
        const r = regionAt(resolveFile(rest.slice(0, at)), Number(rest.slice(at + 1)));
        if (r) codeEvent(w, 'expand', r.file, r.from, r.to, head, w.at);
      } else if (/^t-[0-9a-f]+$/.test(id)) { attach(id, w._words || [], EV.open * age(w.at)); use(w, id); }
    }
  }
  /* From the read hook and the edit and stop hooks. */
  for (const r of jsonl(path.join(dataDir, 'reads', key + '.jsonl'))) {
    const w = walkFor(walks, r, READ_AFTER, (x) => (r.thought ? relatesThought(x, r.thought) : relatesCode(x, r.file, r.from, r.to)));
    if (!w) continue;
    if (r.thought) { attach(r.thought, w._words || [], EV.read * age(r.at)); use(w, r.thought); }
    else codeEvent(w, 'read', r.file, r.from, r.to, r.head, r.at);
  }
  for (const e of jsonl(path.join(dataDir, 'thermal', key + '.jsonl'))) {
    if (e.kind === 'edit') { const w = walkFor(walks, e, READ_AFTER, (x) => relatesCode(x, e.file, e.from, e.to)); if (w) codeEvent(w, 'edit', e.file, e.from, e.to, e.head, e.at); }
    /* A final answer cites what the session found, question by question: each
     * reference goes to the walk it relates to, not all of them to the last. */
    if (e.kind === 'cite') for (const ref of e.refs || []) {
      const w = walkFor(walks, e, CITE_AFTER, (x) => (ref.id ? relatesThought(x, ref.id) : relatesCode(x, ref.file, ref.line, ref.to || ref.line)));
      if (!w) continue;
      if (ref.id) { attach(ref.id, w._words || [], EV.cite * age(e.at)); use(w, ref.id); continue; }
      const file = resolveFile(ref.file);
      if (!file) continue;
      if (ref.line) codeEvent(w, 'cite', file, ref.line, ref.to || ref.line, e.head, e.at);
      else if (ref.name) { const r = (byFile.get(file) || []).find((x) => shortName(x) === ref.name || shortName(x).endsWith('.' + ref.name)); if (r) codeEvent(w, 'cite', file, r.from, r.to, e.head, e.at); }
    }
  }
  /* Shown and left: what GitX offered that the agent's chain never used. */
  for (const w of walks) {
    const u = used.get(w.id) || new Set();
    for (const n of (w.stack && w.stack.nodes) || []) {
      if (n.role !== 'result') continue;
      let k = null;
      if (String(n.id).startsWith('code:')) { const rest = String(n.id).slice(5), at = rest.lastIndexOf(':'); const r = regionAt(resolveFile(rest.slice(0, at)), Number(rest.slice(at + 1))); if (r) k = regionKey(r); }
      else if (/^t-[0-9a-f]+$/.test(String(n.id))) k = String(n.id);
      if (k && !u.has(k)) attach(k, w._words || [], 0, EV.shown * age(w.at));
    }
  }

  const model = { head, vocab, heat, walks: walks.length, nodes: vocab.size, cx };
  models.set(repoDir + '|' + dataDir, { sig, model });
  return model;
}

/* ------------------------------------------------------------ asking it */

const mean = (e) => (e.a + 1) / (e.a + e.b + 2);
const counts = (e) => e.a >= MIN_A && mean(e) >= MIN_MEAN;

/* What a question's words reach: the nodes they are attached to (as learned
 * use, the shape path learning gives), and the words attached beside them on
 * those nodes, to widen the search - word -> node -> word. */
export function thermalAsk(model, words) {
  if (!model) return null;
  const q = new Set([...words].filter((w) => !w.includes('_')));
  const use = new Map(), linked = new Map(), via = [];
  for (const [node, v] of model.vocab) {
    let a = 0, b = 0, hits = [];
    for (const w of q) { const e = v.get(w); if (e && counts(e)) { a += e.a; b += e.b; hits.push(w); } }
    if (!hits.length) continue;
    use.set(node, { mean: (a + 1) / (a + b + 2), a, b });
    via.push({ node, words: hits });
    for (const [w, e] of v) if (!q.has(w) && counts(e)) linked.set(w, Math.max(linked.get(w) || 0, EXPAND_W * mean(e)));
  }
  const expand = new Map([...linked].sort((x, y) => y[1] - x[1]).slice(0, EXPAND_MAX));
  return { use, expand, via };
}

/* The words that count for a node: attached by enough evidence. */
export function attachedWords(model, node) {
  const v = model && model.vocab.get(node);
  return v ? [...v].filter(([, e]) => counts(e)).map(([w]) => w) : [];
}

/* The hottest lines of a region for this question: heat from events whose
 * words meet the question's (or the words linked to them) counts in full,
 * other heat a fifth, a line holding a question word half. Null when no agent
 * has touched the region - the generic cut is used then. */
export function hotCode(model, region, words, expand) {
  if (!model) return null;
  const h = model.heat.get(region.file);
  if (!h) return null;
  const want = new Set([...words, ...(expand ? expand.keys() : [])].filter((w) => !w.includes('_')));
  const lines = region.text.split('\n');
  const score = lines.map((l, i) => {
    let s = 0;
    for (const e of h.get(region.from + i) || []) s += [...e.words].some((w) => want.has(w)) ? e.w : e.w * 0.2;
    if ([...termsOf(l)].some((t) => want.has(t))) s += 0.5;
    return s;
  });
  const heatMax = Math.max(0, ...lines.map((_, i) => (h.get(region.from + i) || []).reduce((s, e) => s + e.w, 0)));
  if (heatMax <= 0) return null;
  const order = score.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]);
  const keep = new Set([0]);
  for (const [, i] of order) {
    if (keep.size >= HOT_LINES) break;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length && keep.size < HOT_LINES) keep.add(j);
  }
  const idx = [...keep].sort((a, b) => a - b), out = [];
  let prev = -1;
  for (const i of idx) {
    if (prev >= 0 && i > prev + 1) out.push('  …');
    out.push(String(region.from + i).padStart(5) + '  ' + lines[i]);
    prev = i;
  }
  if (idx[idx.length - 1] < lines.length - 1) out.push('  …');
  return { code: out.join('\n'), heat: Math.round(heatMax * 10) / 10 };
}

/* ------------------------------------------------------------ reasons */

/* The ideas that lost to a thought: thoughts linking to it with lost-to. */
export function rejectedIndex(cx) {
  const out = new Map();
  for (const t of [...cx.settled, ...cx.waiting]) for (const l of t.links || []) {
    if (l.type !== 'lost-to') continue;
    if (!out.has(l.to)) out.set(l.to, []);
    out.get(l.to).push({ id: t.id, text: String(t.text || '').slice(0, 160) });
  }
  return out;
}

/* Older commits on a range of lines, beyond the ones that wrote it now:
 * where superseded and rejected ideas attached to earlier versions live. */
export function historyOf(repoDir, file, from, to, exclude = new Set(), limit = 3) {
  let raw = '';
  try { raw = git(repoDir, ['log', '-L', from + ',' + to + ':' + file, '--format=@%h%x1f%as%x1f%s', '-n', '8']); } catch (_) { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.startsWith('@')) continue;
    const [h, date, subject] = l.slice(1).split('\x1f');
    if ([...exclude].some((x) => x.startsWith(h) || h.startsWith(x))) continue;
    out.push({ commit: h, date, subject });
    if (out.length >= limit) break;
  }
  return out;
}
