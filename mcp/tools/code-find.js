/*
 * Code first (t-acba23f1c4, t-e688562831, t-904520206d): code is the project's
 * truth and always present, so a question enters at the code it is about, and
 * the reasons are reached FROM that code - git blame names the commits that
 * wrote its lines as they are now, their messages say why, and the thoughts
 * they settled say what was weighed. No ranking guess sits between a line and
 * its reasons.
 *
 *   regions   every declaration at HEAD with the comment above it - functions,
 *             classes, handlers, a heading's section of a doc - small enough to
 *             read whole; a long one is cut at blank lines
 *   own       a region's words: its code split at camelCase and snake_case, its
 *             comments, and adjacent pairs, so "path knowledge" matches as one
 *   why       the words of what made it: messages of the commits that wrote a
 *             real share of its lines, the thoughts they settled and those
 *             thoughts' topics - how "path knowledge" finds path-recorder.js,
 *             whose code never says it (every means, t-e688562831)
 *
 * The answer carries the lines themselves (t-109b96e570 lost: naming a file
 * makes the agent read all of it): the comment and declaration, then the lines
 * that hold the question's words with a little context, cut to a few dozen.
 *
 * Everything is computed from git at HEAD and cached per HEAD in the temp dir,
 * like the commit index: a new commit rebuilds it, nothing here is state.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tokenize, parseMessage } from './git-extract.js';
import { stem, buildRankIndex, rank, statusOf, summaryOf } from './rank.js';
import { loadThoughts } from './thoughts.js';
import { loadTopics } from './topics.js';

const SCHEMA = 1;
const CODE_EXT = /\.(m?js|cjs|jsx|tsx?|py|go|rs|java|rb|php|cs|css|scss)$/i;
const DOC_EXT = /\.(md|markdown)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.gitx)\//;
const MAX_FILE_LINES = 6000;
const REGION_MAX = 120;      // a region longer than this is cut at blank lines
const CHUNK = 60;
const WHY_SHARE = 0.2;       // a commit's words count for a region it wrote this share of
const WHY_LINES = 10;        // ... or this many lines of
const WHY_WEIGHT = 0.5;      // a word only in the why counts half
const LINES_KEEP = 30;       // lines shown per region at most
const CONTEXT = 2;           // lines around a line that holds a question's word

const git = (repoDir, args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/* Words as the rest of GitX counts them, after taking identifiers apart:
 * domainByKind is "domain by kind", path_recorder "path recorder". */
export function termsOf(text) {
  const split = String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const u = tokenize(split).map(stem);
  const out = new Set(u);
  for (let i = 1; i < u.length; i++) out.add(u[i - 1] + '_' + u[i]);
  return out;
}

/* Where a region starts, per kind of file. Indented up to a few spaces, so
 * functions inside a module wrapper (monitor.js is one IIFE) are regions of
 * their own; a tool handler's case is one too. */
const STARTS = {
  code: /^\s{0,4}(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+[\w$]+|class\s+[\w$]+|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\(|function|[\w$]+\s*=>|new\s|\{|\[)|[\w$]+\s*\([^)]*\)\s*\{\s*$)|^\s{0,6}case\s+['"][\w-]+['"]\s*:|^\s{0,4}(?:async\s+)?def\s+\w+|^\s{0,4}class\s+\w+|^(?:func|fn|pub fn|impl)\s/,
  css: /^(?:@media|@keyframes|[^\s@}/*][^{;]*\{\s*$)/,
  doc: /^#{1,4}\s/
};
const COMMENT = /^\s*(?:\/\*|\*|\/\/|#(?!#)|<!--)/;
const nameOf = (line) => line.trim().replace(/\s*\{\s*$/, '').slice(0, 90);

function splitFile(file, lines) {
  const kind = DOC_EXT.test(file) ? 'doc' : /\.s?css$/i.test(file) ? 'css' : 'code';
  const starts = STARTS[kind];
  const out = [];
  let from = 0, name = kind === 'doc' ? path.basename(file) : '(top of file)';
  const cut = (to, nm) => {
    if (to <= from) return;
    /* Too long to read whole: cut at blank lines near every CHUNK lines. */
    if (to - from > REGION_MAX) {
      let a = from;
      while (a < to) {
        let b = Math.min(to, a + CHUNK);
        if (b < to) { let k = b; while (k < Math.min(to, b + 20) && lines[k].trim() !== '') k++; b = k < to ? k + 1 : to; }
        out.push({ file, kind, name: nm + (a > from ? ' (cont.)' : ''), from: a + 1, to: b });
        a = b;
      }
    } else out.push({ file, kind, name: nm, from: from + 1, to });
  };
  for (let i = 0; i < lines.length; i++) {
    if (!starts.test(lines[i])) continue;
    /* The comment above a declaration belongs to it - it says why. */
    let s = i;
    if (kind !== 'doc') while (s > from && COMMENT.test(lines[s - 1])) s--;
    if (s > from) { cut(s, name); from = s; }
    name = kind === 'doc' ? path.basename(file) + ' ' + lines[i].replace(/^#+\s*/, '').slice(0, 80) : nameOf(lines[i]);
  }
  cut(lines.length, name);
  return out;
}

/* Who wrote each line at HEAD: one blame per file. */
function blameFile(repoDir, file) {
  const out = [];
  let raw;
  try { raw = git(repoDir, ['blame', '--porcelain', 'HEAD', '--', file]); } catch (_) { return out; }
  let cur = null;
  for (const l of raw.split('\n')) {
    const m = l.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (m) { cur = m[1]; out[Number(m[2]) - 1] = cur; }
  }
  return out;
}

function cacheFile(repoDir, head) {
  const key = crypto.createHash('sha1').update(path.resolve(repoDir) + ':' + head + ':' + SCHEMA).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'gitx-code', key + '.json');
}

/* Every region at HEAD, with who wrote it. Cached per HEAD. */
export function codeRegions(repoDir) {
  const head = git(repoDir, ['rev-parse', 'HEAD']).trim();
  const file = cacheFile(repoDir, head);
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.head === head) return c; } catch (_) { /* build it */ }
  const files = git(repoDir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')
    .filter((f) => f && !SKIP.test(f) && (CODE_EXT.test(f) || DOC_EXT.test(f)) && !/\.min\./.test(f));
  const regions = [];
  for (const f of files) {
    let text;
    try { text = git(repoDir, ['show', 'HEAD:' + f]); } catch (_) { continue; }
    const lines = text.split('\n');
    if (lines.length > MAX_FILE_LINES) continue;
    const blame = blameFile(repoDir, f);
    for (const r of splitFile(f, lines)) {
      const commits = {};
      for (let i = r.from - 1; i < r.to; i++) if (blame[i]) commits[blame[i].slice(0, 12)] = (commits[blame[i].slice(0, 12)] || 0) + 1;
      regions.push({ ...r, commits, text: lines.slice(r.from - 1, r.to).join('\n') });
    }
  }
  const built = { head, at: new Date().toISOString(), regions };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(built)); } catch (_) { /* uncached is fine */ }
  return built;
}

/* What made the code: each commit's message and the thoughts it settled, by
 * short hash. A settled thought is under the commit it resulted in. */
function reasons(repoDir) {
  const commits = new Map();
  const REC = '\x1e', FLD = '\x1f';
  const raw = git(repoDir, ['log', '--format=' + REC + '%H' + FLD + '%s' + FLD + '%b' + FLD + '%as']);
  for (const rec of raw.split(REC).filter(Boolean)) {
    const [hash, subject, body, date] = rec.split(FLD);
    const msg = parseMessage(subject, body);
    commits.set(hash.trim().slice(0, 12), { hash: hash.trim(), subject, body: msg.body || '', date: (date || '').trim(), thoughts: [] });
  }
  const topics = new Map(loadTopics(repoDir).topics.map((t) => [t.id, t.title]));
  const settled = loadThoughts(repoDir).thoughts;
  for (const t of settled) {
    const h = t.resulted_in && t.resulted_in.commit;
    const c = h && commits.get(h.slice(0, 12));
    if (c) c.thoughts.push(t);
  }
  return { commits, topics, settled, waiting: loadThoughts(repoDir, { store: 'context' }).thoughts };
}

/* The index searched: each region's own words and why words, and how rare
 * each word is over the regions. Built per call from the cached regions; the
 * words are cheap beside the blame. */
export function buildCodeIndex(repoDir) {
  const { head, regions } = codeRegions(repoDir);
  const why = reasons(repoDir);
  const df = new Map();
  for (const r of regions) {
    r.own = termsOf(r.text);
    r.why = new Set();
    const n = r.to - r.from + 1;
    for (const [c, k] of Object.entries(r.commits)) {
      if (k < WHY_LINES && k / n < WHY_SHARE) continue;
      const cm = why.commits.get(c);
      if (!cm) continue;
      for (const w of termsOf(cm.subject + ' ' + cm.body)) if (!r.own.has(w)) r.why.add(w);
      for (const t of cm.thoughts) {
        for (const w of termsOf(t.text + ' ' + (why.topics.get(t.topic) || ''))) if (!r.own.has(w)) r.why.add(w);
      }
    }
    for (const w of new Set([...r.own, ...r.why])) df.set(w, (df.get(w) || 0) + 1);
  }
  return { repoDir, head, regions, df, ...why };
}

const idfOf = (ix, w) => Math.log((ix.regions.length + 1) / ((ix.df.get(w) || 0) + 0.5));

/* The regions a question is about, best first: the share of the question's
 * weight a region holds, a word in its own text counting fully and one only
 * in what made it counting half. `carry` is the previous question's rare
 * words (t-71baf0316b), at half weight. */
export function findCode(ix, text, { carry = [], limit = 6, near = 0.5 } = {}) {
  const asked = [...termsOf(text)].filter((w) => ix.df.has(w) || !w.includes('_'));
  const q = new Map(asked.map((w) => [w, idfOf(ix, w)]));
  for (const w of carry) if (!q.has(w) && ix.df.has(w)) q.set(w, idfOf(ix, w) * 0.5);
  const total = [...q.values()].reduce((s, x) => s + x, 0);
  if (!total) return { terms: [], found: [] };
  const scored = [];
  for (const r of ix.regions) {
    let s = 0;
    const hit = [];
    for (const [w, weight] of q) {
      if (r.own.has(w)) { s += weight; hit.push(w); } else if (r.why.has(w)) { s += weight * WHY_WEIGHT; hit.push(w + '*'); }
    }
    if (s > 0) scored.push({ r, score: s / total, hit });
  }
  scored.sort((a, b) => b.score - a.score || (a.r.to - a.r.from) - (b.r.to - b.r.from));
  const best = scored.length ? scored[0].score : 0;
  return { terms: [...q.keys()], found: scored.filter((x) => x.score >= best * near).slice(0, limit) };
}

/* The lines of a region worth reading for this question: its first lines and
 * its declaration, then every line holding one of the question's words with
 * a little context, comments included - a long header comment is read by
 * the same rule as code, or the part that answers is cut for the part that
 * happens to sit nearest the declaration. Gaps marked; the lines holding
 * most of the question's words are kept first when there are too many. */
export function linesFor(region, terms) {
  const lines = region.text.split('\n');
  const want = new Set(terms.filter((w) => !w.includes('_')));
  const pairs = new Set(terms.filter((w) => w.includes('_')));
  let decl = 0;
  while (decl < lines.length && COMMENT.test(lines[decl])) decl++;
  const weight = lines.map((l) => { const t = termsOf(l); let s = 0; for (const w of t) s += want.has(w) ? 1 : pairs.has(w) ? 2 : 0; return s; });
  const keep = new Map();                     // line -> how much it is worth keeping
  const add = (i, v) => { if (i >= 0 && i < lines.length) keep.set(i, Math.max(keep.get(i) || 0, v)); };
  for (let i = 0; i < Math.min(2, lines.length); i++) add(i, 100);
  add(Math.min(decl, lines.length - 1), 100);
  for (let i = 0; i < lines.length; i++) if (weight[i]) for (let k = i - CONTEXT; k <= i + CONTEXT; k++) add(k, weight[i] * 10 - Math.abs(k - i));
  if (keep.size <= 3) for (let i = decl; i < Math.min(lines.length, decl + 16); i++) add(i, 1);
  const idx = [...keep].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, LINES_KEEP).map(([i]) => i).sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const i of idx) {
    if (prev >= 0 && i > prev + 1) out.push('  …');
    out.push(String(region.from + i).padStart(5) + '  ' + lines[i]);
    prev = i;
  }
  if (idx.length && idx[idx.length - 1] < lines.length - 1) out.push('  …');
  return out.join('\n');
}

/* The chain from the code down: the commits that wrote it, then the thoughts
 * they settled. */
export function chainOf(ix, found, { commitsPer = 3 } = {}) {
  const commits = new Map();
  for (const { r } of found) {
    const n = r.to - r.from + 1;
    for (const [c, k] of Object.entries(r.commits).sort((a, b) => b[1] - a[1]).slice(0, commitsPer)) {
      const cm = ix.commits.get(c);
      if (!cm) continue;
      const e = commits.get(c) || { ...cm, short: c.slice(0, 7), lines: 0, regions: [] };
      e.lines += k;
      e.regions.push(r.file + ' ' + r.name + ' (' + Math.round((k / n) * 100) + '% of it)');
      commits.set(c, e);
    }
  }
  const thoughts = new Map();
  for (const c of commits.values()) for (const t of c.thoughts) if (!thoughts.has(t.id)) thoughts.set(t.id, { t, commit: c.short });
  return { commits: [...commits.values()].sort((a, b) => b.lines - a.lines), thoughts: [...thoughts.values()] };
}

/* ─────────────────────────────────────────────── the answer, in layers */

const NO_CODE = 0.4;         // below this share of the question no region is about it
const CODE_SHOWN = 4;
const DOCS_SHOWN = 2;
const COMMITS_SHOWN = 6;
const THOUGHTS_SHOWN = 6;
const CONTEXT_SHOWN = 5;
const WHY_CHARS = 320;
const cap = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…'; };

/* Shares of the regions a word may be in: a new subject is told by words in
 * at most RARE_SHARE of them (knowledge 6%, wallpaper 3%, langgraph none,
 * against error at 10% and agent at 71% when measured); what is carried is
 * at most CARRY_SHARE. Counted over own and why words, so the words of
 * commit messages and thoughts make a word common too. */
const RARE_SHARE = 0.07;
const CARRY_SHARE = 0.15;
const CARRY_MAX = 8;

/* A question is on a new subject when it has rare words of its own - in few
 * regions, or in none - and less than half their weight is in the code the
 * last question landed on or among the words it carried. One with no rare
 * word narrows the last question. */
function newSubject(ix, text, previous, carry) {
  const rare = [...termsOf(text)].filter((w) => !w.includes('_') && (ix.df.get(w) || 0) <= ix.regions.length * RARE_SHARE);
  if (!rare.length) return false;
  const keys = new Set(previous);
  const before = ix.regions.filter((r) => keys.has(r.file + ':' + r.from));
  /* By weight, and in the code itself: one rare word met in a commit message
   * under the last answer ("pick") is not the subject ("wallpaper"). */
  const weight = (w) => idfOf(ix, w);
  const total = rare.reduce((s, w) => s + weight(w), 0);
  const shared = rare.filter((w) => carry.includes(w) || before.some((r) => r.own.has(w))).reduce((s, w) => s + weight(w), 0);
  return shared < total / 2;
}

/* The best regions, one per file first so one file cannot fill the answer,
 * then the next best of any file. */
function spread(found, n) {
  const out = [], files = new Set();
  for (const x of found) if (out.length < n && !files.has(x.r.file)) { out.push(x); files.add(x.r.file); }
  for (const x of found) if (out.length < n && !out.includes(x)) out.push(x);
  return out.sort((a, b) => b.score - a.score);
}

/* The words a question passes on (t-71baf0316b): its uncommon words and its
 * pairs the code holds, rarest first, then what it was itself carrying -
 * so a chain of questions keeps the subject it has been narrowing. */
export function rareTerms(ix, text, carried = []) {
  const own = [...termsOf(text)].filter((w) => ix.df.has(w) && (w.includes('_') || ix.df.get(w) <= ix.regions.length * CARRY_SHARE))
    .sort((a, b) => idfOf(ix, b) - idfOf(ix, a));
  return [...new Set([...own, ...carried])].slice(0, CARRY_MAX);
}

/* A question answered from the code down (t-904520206d):
 *
 *   code      the regions at HEAD it is about, as the lines worth reading
 *   commits   the commits git blame names for those lines, with their why
 *   thoughts  what those commits settled, the ones nearest the question in
 *             full; and the docs the question landed in, as thinking
 *   context   beside the stack, not in it (t-a078ddeea8): what is still
 *             waiting - open questions, bugs, rules, plans - by the words
 *
 * With no region holding enough of the question there is no code yet
 * (t-6c82966c3a): the answer says so and the context layer carries it.
 *
 * `carry` is the previous question's rare words and `previous` the regions
 * it landed in: the words ride along at half weight, unless this question is
 * on a new subject (newSubject).
 * `paths` keeps the code to those files and folders when any of them holds
 * some of the question. */
export function codeFirst(repoDir, { query, carry = [], previous = [], paths = [] } = {}) {
  const t0 = Date.now();
  const cx = buildCodeIndex(repoDir);
  const rx = buildRankIndex(repoDir);
  const within = (paths || []).map((p) => String(p).split('::')[0].replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  const search = (opts) => {
    const res = findCode(cx, query, { ...opts, limit: within.length ? 2000 : 30 });
    if (!within.length) return res;
    const inside = res.found.filter(({ r }) => within.some((p) => r.file === p || r.file.startsWith(p.replace(/\/?$/, '/'))));
    return { terms: res.terms, found: (inside.length ? inside : res.found).slice(0, 30) };
  };
  /* A follow-up or a new subject. "errors recorded" after "path knowledge"
   * has no rare word of its own - it narrows the last question, and carries
   * its words. "should we use langgraph" after the wallpaper has one the last
   * question's code never holds - a new subject, and carries nothing. */
  let carried = carry.length && !newSubject(cx, query, previous, carry) ? carry : [];
  const { terms, found } = search({ carry: carried });
  const tSearch = Date.now() - t0;
  const best = found.length ? found[0].score : 0;
  const noCode = best < NO_CODE;
  const code = noCode ? [] : spread(found.filter(({ r }) => r.kind !== 'doc'), CODE_SHOWN);
  const docs = noCode ? [] : spread(found.filter(({ r }) => r.kind === 'doc'), DOCS_SHOWN);

  const chain = chainOf(cx, [...code, ...docs]);
  /* Nearest the question first: rank()'s word order over the settled graph -
   * with the carried words, which are the question's too. */
  const words = carried.length ? query + ' ' + carried.join(' ') : query;
  const order = new Map(rank(rx, { text: words, layers: ['thought'], limit: 100 }).results.map((r, i) => [r.id, i]));
  const thoughts = chain.thoughts.slice().sort((a, b) => (order.has(a.t.id) ? order.get(a.t.id) : 999) - (order.has(b.t.id) ? order.get(b.t.id) : 999));
  const statusFor = (id) => { const n = rx.nodes.get(id); return n ? statusOf(rx, n) : null; };
  const context = rank(rx, { text: words, layers: ['context'], limit: 20 }).results;
  /* The topic most of the shown thoughts are filed under: its summary sits
   * below the code (t-904520206d), read after it, not instead of it. */
  const votes = new Map();
  for (const { t } of thoughts.slice(0, THOUGHTS_SHOWN)) if (t.topic) votes.set(t.topic, (votes.get(t.topic) || 0) + 1);
  const topic = [...votes].sort((a, b) => b[1] - a[1])[0];
  const summary = topic ? summaryOf(rx, topic[0]) : null;

  const out = {
    asked: query,
    carried: carried.length ? carried : undefined,
    no_code: noCode ? 'No code at HEAD is about this' + (best ? ' (the closest region holds ' + Math.round(best * 100) + '% of the question)' : '') + ' - it is not built yet, or not in these words. What is decided or discussed is in context below: plans, not code.' : undefined,
    code: code.map(({ r, score, hit }) => ({
      region: r.file + ' :: ' + r.name, lines: r.from + '-' + r.to, matched: Math.round(score * 100) + '% - ' + hit.join(' '),
      code: linesFor(r, terms)
    })),
    commits: chain.commits.slice(0, COMMITS_SHOWN).map((c) => ({
      commit: c.short, date: c.date, subject: cap(c.subject, 120), why: c.body ? cap(c.body, WHY_CHARS) : undefined,
      wrote: c.regions.join(' · '), read: 'gitx_graph_commit hash ' + c.short
    })),
    more_commits: chain.commits.length > COMMITS_SHOWN ? chain.commits.length - COMMITS_SHOWN : undefined,
    thoughts: [
      ...docs.map(({ r, score }) => ({ doc: r.file + ' :: ' + r.name, lines: r.from + '-' + r.to, matched: Math.round(score * 100) + '%', text: linesFor(r, terms) })),
      ...thoughts.slice(0, THOUGHTS_SHOWN).map(({ t, commit }) => ({ id: t.id, status: statusFor(t.id), text: t.text, settled_in: commit, read: 'gitx_thought id ' + t.id }))
    ],
    summaries: summary ? [summary] : undefined,
    more_thoughts: thoughts.length > THOUGHTS_SHOWN ? thoughts.slice(THOUGHTS_SHOWN).map(({ t }) => t.id).join(', ') : undefined,
    context: context.slice(0, CONTEXT_SHOWN).map((r) => ({ id: r.id, status: statusFor(r.id), text: r.text, topic: r.topic ? (rx.topics.get(r.topic) || {}).title : undefined })),
    more_context: context.length > CONTEXT_SHOWN ? context.length - CONTEXT_SHOWN + ' more waiting thoughts hold these words - gitx_thought outcome or topic lists them' : undefined
  };
  /* For GitX Monitor and the path recorder (t-6a7335ce0a): what the agent was
   * given, as nodes in their layers and the links of the chain between them -
   * code written by commits, commits settling thoughts. Commits by their
   * first eight characters and thoughts by id, as the recorder matches steps. */
  const nodes = [], links = [];
  const shownCommits = chain.commits.slice(0, COMMITS_SHOWN);
  const c8 = (c) => c.hash.slice(0, 8);
  code.forEach(({ r, score }, i) => nodes.push({ id: 'code:' + r.file + ':' + r.from, layer: 'code', role: 'result', rank: i + 1, kind: 'code', status: 'CODE ' + Math.round(score * 100) + '%', text: r.file + ' :: ' + cap(r.name, 60), commits: [] }));
  shownCommits.forEach((c, i) => nodes.push({ id: c8(c), layer: 'commit', role: 'result', rank: i + 1, status: 'COMMIT ' + c.date, text: cap(c.subject, 160) }));
  docs.forEach(({ r }, i) => nodes.push({ id: 'doc:' + r.file + ':' + r.from, layer: 'thought', role: 'result', rank: i + 1, kind: 'doc', status: 'DOC', text: cap(r.name, 120) }));
  thoughts.slice(0, THOUGHTS_SHOWN).forEach(({ t, commit }, i) => nodes.push({ id: t.id, layer: 'thought', role: 'result', rank: docs.length + i + 1, kind: t.kind, status: statusFor(t.id), text: cap(t.text, 160), topic: t.topic ? (rx.topics.get(t.topic) || {}).title : undefined, commit }));
  context.slice(0, CONTEXT_SHOWN).forEach((r, i) => nodes.push({ id: r.id, layer: 'context', role: 'result', rank: i + 1, kind: r.kind, status: statusFor(r.id), text: cap(r.text, 160) }));
  const has = new Set(nodes.map((n) => n.id));
  for (const { r } of [...code, ...docs]) {
    const from = (r.kind === 'doc' ? 'doc:' : 'code:') + r.file + ':' + r.from;
    for (const c of shownCommits) if (r.commits[c.hash.slice(0, 12)]) { links.push([from, 'written-by', c8(c)]); const n = nodes.find((x) => x.id === from); if (n.commits) n.commits.push(c8(c)); }
  }
  for (const c of shownCommits) for (const t of c.thoughts) if (has.has(t.id)) links.push([c8(c), 'settled', t.id]);
  const monitor = {
    phases: {
      mode: 'code',
      processing: { regions: cx.regions.length, commits: cx.commits.size, settled: cx.settled.length, waiting: cx.waiting.length, ms: tSearch },
      search: { words: terms.filter((w) => !w.includes('_')), carried: carried.length ? carried : undefined, best: Math.round(best * 100), no_code: noCode || undefined },
      results: { code: code.length, docs: docs.length, commits: chain.commits.length, thoughts: thoughts.length, context: context.length, ms: Date.now() - t0 },
      filtering: { returned: nodes.length }
    },
    stack: { nodes, links }
  };
  return {
    answer: out,
    monitor,
    carry: rareTerms(cx, query, carried),
    landed: [...code, ...docs].map(({ r }) => r.file + ':' + r.from),
    ms: Date.now() - t0
  };
}
