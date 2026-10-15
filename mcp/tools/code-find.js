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
import { NO_CONSOLE } from './no-console.js';
import { tokenize, parseMessage } from './git-extract.js';
import { ASKING } from './learn.js';
import { stem, buildRankIndex, rank, statusOf, summaryOf } from './rank.js';
import { loadThoughts } from './thoughts.js';
import { loadTopics } from './topics.js';
import { staleOf } from './stale.js';
import { hotCode, rejectedIndex, historyOf, attachedWords } from '../thermal/thermal.js';

/* 3: regions split after the regex-literal fix (bd2133f) - a cache from
 * before it kept serving code-find.js as one region named STARTS.
 * 4: large hand-written files are indexed (see generated below) - a cache
 * from before would keep serving them as absent. */
const SCHEMA = 4;
const CODE_EXT = /\.(m?js|cjs|jsx|tsx?|py|go|rs|java|rb|php|cs|css|scss|html?|vue|svelte)$/i;
const DOC_EXT = /\.(md|markdown)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.gitx)\//;
/* A file is left out for being generated, not for being long. A 6,000-line
 * cap set when GitX's own largest file had 1,444 lines dropped ter-manager's
 * public/app.js - 13,410 lines, most of that project's logic - so code search
 * there could not find the tiling engine at all (15 October). Code is cut into
 * function-sized regions, so a long file costs index time, not answer size.
 * What is left out instead: minified or bundled output - very long lines, or
 * a bundler's or generator's mark near the top - and a safety cap far above
 * any hand-written file. */
const MAX_FILE_LINES = 100000;
const LONG_LINE = 2000;          // a hand-written line is never this long; a minified bundle's are
const GENERATED = /(@generated|do not edit|auto-?generated|webpackBootstrap|sourceMappingURL=|\/\*! For license)/i;
function generated(lines) {
  if (lines.some((l) => l.length > LONG_LINE)) return true;
  return GENERATED.test(lines.slice(0, 15).join('\n'));
}
const REGION_MAX = 120;      // a region longer than this is cut at blank lines
const CHUNK = 60;
const WHY_SHARE = 0.2;       // a commit's words count for a region it wrote this share of
const WHY_LINES = 3;         // ... or this many lines of: a small fix spread over several
                             // regions still made each of them (one of 23 lines in two
                             // files was 20% of no region, and taught none its words)
const WHY_WEIGHT = 0.5;      // a word only in the why counts half
const LINES_KEEP = 30;       // lines shown per region at most
const CONTEXT = 2;           // lines around a line that holds a question's word
const SENTENCE_MAX = 8;      // lines a comment sentence may span when it comes whole

const git = (repoDir, args) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/* Words as the rest of GitX counts them, after taking identifiers apart:
 * domainByKind is "domain by kind", path_recorder "path recorder". */
export function termsOf(text) {
  const split = String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const u = tokenize(split).map(stem);
  const out = new Set(u);
  for (let i = 1; i < u.length; i++) out.add(u[i - 1] + '_' + u[i]);
  return out;
}

/* The words of a question worth searching code for. Code is weighed by how
 * rare a word is in code, and the words people talk in are rare there: "yes",
 * "doing" and "should have" weighed more than "flag" or "question", and "it
 * gets the rules... buried deep" landed on a wallpaper function by "get",
 * "top" and "deep" (the owner's own questions, tune2 on the bench). So the
 * asking words the learner already drops (ASKING) and the words of talk below
 * go, and so does every pair holding one - "should_have" said nothing either. */
const TALK = new Set(('yes no ok okay right sure so but if then than now also any all some have has had having being been be ' +
  'doing done get gets got getting make makes made making take takes took actually really like lets let say says said ' +
  'maybe whether based again come comes coming go goes going went put see look looks kind lot able possible ' +
  'i im we you they he she my our your their me us them its it s t d ll ve re nt dont didnt doesnt isnt wont cant ' +
  'didn doesn isn wasn aren weren hasn haven couldn wouldn shouldn won ' +
  'and or of to in on at by for with from as into the a an just even ever already').split(' ').map(stem));
export function questionTerms(text) {
  const drop = (w) => ASKING.has(w) || TALK.has(w);
  const out = new Set();
  for (const w of termsOf(text)) if (!w.split('_').some(drop)) out.add(w);
  return out;
}

/* Where a region starts, per kind of file. Indented up to a few spaces, so
 * functions inside a module wrapper (monitor.js is one IIFE) are regions of
 * their own; a tool handler's case is one too. */
const STARTS = {
  code: /^\s{0,4}(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+[\w$]+|class\s+[\w$]+|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\(|function|[\w$]+\s*=>|new\s|\{|\[)|[\w$]+\s*\([^)]*\)\s*\{\s*$)|^\s{0,6}case\s+['"][\w-]+['"]\s*:|^\s{0,4}(?:async\s+)?def\s+\w+|^\s{0,4}class\s+\w+|^(?:func|fn|pub fn|impl)\s/,
  css: /^(?:@media|@keyframes|[^\s@}/*][^{;]*\{\s*$)/,
  html: /^\s{0,8}<(?:section|aside|nav|header|main|footer|template|dialog|form|script|style)\b|^\s{0,8}<div[^>]*\bid=/,
  doc: /^#{1,4}\s/
};
const COMMENT = /^\s*(?:\/\*|\*|\/\/|#(?!#)|<!--)/;
const nameOf = (line) => line.trim().replace(/\s*\{\s*$/, '').slice(0, 90);

/* Where each line sits in the braces, for JavaScript-like code and CSS: a
 * declaration starts a region only at the top level - inside nothing but
 * module wrappers such as monitor.js's one IIFE - and a method only directly
 * inside a class. Statements inside a function are part of it: without
 * this, every `const x = (…)` in a body began a region of its own and
 * learnKeys came back as four pieces (t-de9d13a9a0). Strings, template
 * literals and comments are blanked before braces are counted. */
const WRAPPER = /^\s*(?:;?\s*\(\s*(?:async\s*)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)\s*=>)\s*\{|(?:export\s+default\s+)?\{\s*$)/;
const CLASS = /^\s*(?:export\s+)?(?:default\s+)?class\s+[\w$]+/;
const METHOD = /^\s*(?:static\s+|async\s+|get\s+|set\s+)*(?!(?:if|for|while|switch|catch|return|function)\b)[\w$]+\s*\([^)]*\)\s*\{\s*$/;
/* A regular expression literal, where one can begin: after an operator, a
 * bracket, a comma or return. Blanked like a string - STARTS.code holds \{
 * and \[, and counted as braces they opened a block that never closed, so
 * everything in code-find.js after it was one region named STARTS. */
const REGEX_LIT = /(^|[=(,:[!&|?{};]|\breturn)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])+\/[dgimsuy]*/g;
function braceStarts(lines, kind) {
  const starts = new Set();
  const stack = [];                       // 'wrap' | 'class' | 'block' per open brace
  let inBlockComment = false;
  const top = () => stack.every((k) => k === 'wrap');
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (inBlockComment) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2); inBlockComment = false; }
    const raw = lines[i];
    if (kind === 'css') { if (top() && STARTS.css.test(raw)) starts.add(i); }
    else if ((top() && STARTS.code.test(raw) && !/^\s{0,6}case\s/.test(raw)) || (stack.length && stack[stack.length - 1] === 'class' && stack.slice(0, -1).every((k) => k === 'wrap') && METHOD.test(raw))) starts.add(i);
    const clean = l.replace(REGEX_LIT, '$1""').replace(/\/\*.*?\*\//g, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    const open = clean.indexOf('/*');
    const code = open >= 0 ? clean.slice(0, open) : clean;
    if (open >= 0) inBlockComment = true;
    const kindOf = CLASS.test(raw) ? 'class' : top() && WRAPPER.test(raw) && !STARTS.code.test(raw) ? 'wrap' : 'block';
    let first = true;
    for (const ch of code) {
      if (ch === '{') { stack.push(first ? kindOf : 'block'); first = false; }
      else if (ch === '}') stack.pop();
    }
  }
  return starts;
}
/* Python by indentation: def and class at the left edge, methods one level in. */
function indentStarts(lines) {
  const starts = new Set();
  let inClass = false;
  lines.forEach((l, i) => {
    if (/^(?:async\s+)?def\s|^class\s/.test(l)) { starts.add(i); inClass = /^class\s/.test(l); }
    else if (inClass && /^\s{4}(?:async\s+)?def\s/.test(l)) starts.add(i);
    else if (/^\S/.test(l) && l.trim()) inClass = false;
  });
  return starts;
}

export function splitFile(file, lines) {
  const kind = DOC_EXT.test(file) ? 'doc' : /\.s?css$/i.test(file) ? 'css' : /\.(html?|vue|svelte)$/i.test(file) ? 'html' : 'code';
  const starts = kind === 'code' ? (/\.py$/i.test(file) ? indentStarts(lines) : braceStarts(lines, 'code'))
    : kind === 'css' ? braceStarts(lines, 'css') : null;
  const isStart = (i) => (starts ? starts.has(i) : STARTS[kind].test(lines[i]));
  const out = [];
  let from = 0, name = kind === 'doc' ? path.basename(file) : '(top of file)';
  const cut = (to, nm) => {
    if (to <= from) return;
    /* Too long to read whole: cut near every CHUNK lines, at a handler's
     * case where there is one (a tool dispatcher), else at a blank line. */
    if (to - from > REGION_MAX) {
      let a = from;
      while (a < to) {
        let b = Math.min(to, a + CHUNK);
        if (b < to) {
          let k = b;
          const caseAt = (() => { for (let j = b; j < Math.min(to, b + 30); j++) if (/^\s*case\s+['"]/.test(lines[j])) return j; return -1; })();
          if (caseAt >= 0) b = caseAt;
          else { while (k < Math.min(to, b + 20) && lines[k].trim() !== '') k++; b = k < to ? k + 1 : to; }
        }
        const head = /^\s*case\s+['"]([\w-]+)/.exec(lines[a]);
        out.push({ file, kind, name: head ? nm + ' · ' + head[1] : nm + (a > from ? ' (cont.)' : ''), from: a + 1, to: b });
        a = b;
      }
    } else out.push({ file, kind, name: nm, from: from + 1, to });
  };
  for (let i = 0; i < lines.length; i++) {
    if (!isStart(i)) continue;
    /* The comment above a declaration belongs to it - it says why. */
    let s = i;
    if (kind !== 'doc') while (s > from && COMMENT.test(lines[s - 1])) s--;
    if (s > from) { cut(s, name); from = s; }
    name = kind === 'doc' ? path.basename(file) + ' ' + lines[i].replace(/^#+\s*/, '').slice(0, 80) : nameOf(lines[i]);
  }
  cut(lines.length, name);
  return mergeTiny(out);
}

/* A run of one- to three-line declarations - `let opts = {}`, `const esc =
 * …` - is one region: alone, a single word in a one-liner scored like a
 * whole function holding the question. */
const TINY = 3;
function mergeTiny(regions) {
  const out = [];
  for (const r of regions) {
    const prev = out[out.length - 1];
    const small = (x) => x.to - x.from + 1 <= TINY;
    if (prev && small(r) && small(prev) || prev && prev.merged && small(r)) {
      prev.to = r.to;
      if (!prev.merged) { prev.name += ' …'; prev.merged = true; }
    } else out.push({ ...r });
  }
  return out.map(({ merged, ...r }) => r);
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

const repoKeyOf = (repoDir) => crypto.createHash('sha1').update(path.resolve(repoDir) + ':' + SCHEMA).digest('hex').slice(0, 16);
const cacheDir = () => path.join(os.tmpdir(), 'gitx-code');
const cacheFile = (repoDir, head) => path.join(cacheDir(), repoKeyOf(repoDir) + '-' + head.slice(0, 12) + '.json');
const lastFile = (repoDir) => path.join(cacheDir(), repoKeyOf(repoDir) + '-last.txt');

/* Built once and kept (t-2c70a44885): the search itself takes about 10 ms,
 * and rebuilding these took 1.3 s of every call. Regions are kept per HEAD;
 * the words and the thought index also per state of the thought files, since
 * a thought recorded or moved changes what code is about. */
const memory = new Map();       // repoDir -> { head, built, cx, cxSig, rx, rxSig }
const mem = (repoDir) => { if (!memory.has(repoDir)) memory.set(repoDir, {}); return memory.get(repoDir); };

/* The state of the thought graphs and topics: how many files, and the newest
 * change. A few hundred stats, a few milliseconds. */
function thoughtsSig(repoDir) {
  let n = 0, newest = 0;
  for (const d of ['thoughts', 'drafts', 'context/thoughts', 'context/topics']) {
    let names = [];
    try { names = fs.readdirSync(path.join(repoDir, '.gitx', d)); } catch (_) { continue; }
    for (const f of names) {
      try { const s = fs.statSync(path.join(repoDir, '.gitx', d, f)); n++; if (s.mtimeMs > newest) newest = s.mtimeMs; } catch (_) { /* gone meanwhile */ }
    }
  }
  return n + ':' + newest;
}

const codeFiles = (repoDir) => git(repoDir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')
  .filter((f) => f && !SKIP.test(f) && (CODE_EXT.test(f) || DOC_EXT.test(f)) && !/\.min\./.test(f));

function regionsOfFile(repoDir, f) {
  let text;
  try { text = git(repoDir, ['show', 'HEAD:' + f]); } catch (_) { return []; }
  const lines = text.split('\n');
  if (lines.length > MAX_FILE_LINES || generated(lines)) return [];
  const blame = blameFile(repoDir, f);
  return splitFile(f, lines).map((r) => {
    const commits = {};
    for (let i = r.from - 1; i < r.to; i++) if (blame[i]) commits[blame[i].slice(0, 12)] = (commits[blame[i].slice(0, 12)] || 0) + 1;
    return { ...r, commits, text: lines.slice(r.from - 1, r.to).join('\n') };
  });
}

/* Every region at HEAD, with who wrote it - in memory, else on disk, else
 * built. Built from the last HEAD built when there is one: a file the new
 * commits did not touch has the same lines and the same blame, so only the
 * changed files are split and blamed again - blame over every file was
 * 2.8 s of the first question after each commit. */
export function codeRegions(repoDir) {
  const head = git(repoDir, ['rev-parse', 'HEAD']).trim();
  const m = mem(repoDir);
  if (m.head === head && m.built) return m.built;
  const file = cacheFile(repoDir, head);
  let built = null;
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.head === head) built = c; } catch (_) { /* build it */ }
  if (!built) {
    const files = codeFiles(repoDir);
    let reuse = new Map(), changed = null, from = null;
    try {
      /* The last HEAD still in memory first: its regions carry their words
       * already, which would otherwise be worked out again for every file. */
      const prev = m.built || JSON.parse(fs.readFileSync(cacheFile(repoDir, fs.readFileSync(lastFile(repoDir), 'utf8').trim()), 'utf8'));
      from = prev.head;
      changed = new Set(git(repoDir, ['diff', '--name-only', from, head]).split('\n').filter(Boolean));
      for (const r of prev.regions) { if (!reuse.has(r.file)) reuse.set(r.file, []); reuse.get(r.file).push(r); }
    } catch (_) { reuse = new Map(); changed = null; from = null; }
    const regions = [];
    let blamed = 0;
    for (const f of files) {
      if (changed && !changed.has(f) && reuse.has(f)) { regions.push(...reuse.get(f)); continue; }
      regions.push(...regionsOfFile(repoDir, f));
      blamed++;
    }
    built = { head, at: new Date().toISOString(), from: changed ? from : null, blamed, regions };
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      /* Words are memory only: a Set written as JSON reads back as {}. */
      fs.writeFileSync(file, JSON.stringify(built, (k, v) => (k === 'own' || k === 'why' ? undefined : v)));
      fs.writeFileSync(lastFile(repoDir), head);
    } catch (_) { /* uncached is fine */ }
  }
  Object.assign(m, { head, built, cx: null, rx: null });
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

/* The thought and commit index, kept like the code index. */
export function rankIndexFor(repoDir) {
  codeRegions(repoDir);
  const m = mem(repoDir), sig = thoughtsSig(repoDir);
  if (!m.rx || m.rxSig !== sig) { m.rx = buildRankIndex(repoDir); m.rxSig = sig; }
  return m.rx;
}

/* The index searched: each region's own words and why words, and how rare
 * each word is over the regions. Kept in memory for this HEAD and this state
 * of the thoughts; a region's own words are worked out once per HEAD. */
export function buildCodeIndex(repoDir) {
  const { head, regions } = codeRegions(repoDir);
  const m = mem(repoDir), sig = thoughtsSig(repoDir);
  if (m.cx && m.cxSig === sig) return m.cx;
  const why = reasons(repoDir);
  const df = new Map();
  /* A commit's words - its message, the thoughts it settled and their
   * topics - once per commit, not once per region it wrote. */
  const commitWords = new Map();
  const wordsOfCommit = (c, cm) => {
    if (!commitWords.has(c)) commitWords.set(c, termsOf(cm.subject + ' ' + cm.body + ' ' + cm.thoughts.map((t) => t.text + ' ' + (why.topics.get(t.topic) || '')).join(' ')));
    return commitWords.get(c);
  };
  for (const r of regions) {
    if (!r.own) r.own = termsOf(r.text);
    r.why = new Set();
    const n = r.to - r.from + 1;
    for (const [c, k] of Object.entries(r.commits)) {
      if (k < WHY_LINES && k / n < WHY_SHARE) continue;
      const cm = why.commits.get(c);
      if (!cm) continue;
      for (const w of wordsOfCommit(c, cm)) if (!r.own.has(w)) r.why.add(w);
    }
    for (const w of new Set([...r.own, ...r.why])) df.set(w, (df.get(w) || 0) + 1);
  }
  m.cx = { repoDir, head, regions, df, ...why };
  m.cxSig = sig;
  return m.cx;
}

export const idfOf = (ix, w) => Math.log((ix.regions.length + 1) / ((ix.df.get(w) || 0) + 0.5));

/* The regions a question is about, best first: the share of the question's
 * weight a region holds, a word in its own text counting fully and one only
 * in what made it counting half. `carry` is the previous question's rare
 * words (t-71baf0316b), at half weight. */
/* `weights` (term -> multiplier) gives every word its own weight instead -
 * a session's pool (t-2c70a44885): the newest words at 1, older ones halving
 * each round. `avoid` are words the agent dropped: a region holding one
 * loses AVOID_WEIGHT of that word's weight, so what took the answer the
 * wrong way sinks instead of only no longer helping. */
const AVOID_WEIGHT = 0.5;
/* `extra` (thermal, 4th Dimension v2): words linked to the question through
 * code earlier agents used. They add to a region that holds them and are not
 * part of the total: added as question words they diluted it, and a question
 * with code about it came back as having none. */
export function findCode(ix, text, { carry = [], limit = 6, near = 0.5, weights = null, avoid = null, extra = null } = {}) {
  const q = new Map();
  if (weights) { for (const [w, m] of weights) if (m > 0 && (ix.df.has(w) || !w.includes('_'))) q.set(w, idfOf(ix, w) * m); }
  else {
    for (const w of questionTerms(text)) if (ix.df.has(w) || !w.includes('_')) q.set(w, idfOf(ix, w));
    for (const w of carry) if (!q.has(w) && ix.df.has(w)) q.set(w, idfOf(ix, w) * 0.5);
  }
  const total = [...q.values()].reduce((s, x) => s + x, 0);
  if (!total) return { terms: [], found: [] };
  const sink = [...(avoid || [])].filter((w) => ix.df.has(w)).map((w) => [w, idfOf(ix, w) * AVOID_WEIGHT]);
  const scored = [];
  for (const r of ix.regions) {
    let s = 0;
    const hit = [];
    for (const [w, weight] of q) {
      if (r.own.has(w)) { s += weight; hit.push(w); } else if (r.why.has(w)) { s += weight * WHY_WEIGHT; hit.push(w + '*'); }
    }
    for (const [w, weight] of sink) if (r.own.has(w)) s -= weight;
    for (const [w, m] of extra || []) if (!q.has(w) && ix.df.has(w)) { if (r.own.has(w)) { s += idfOf(ix, w) * m; hit.push(w + '~'); } else if (r.why.has(w)) { s += idfOf(ix, w) * m * WHY_WEIGHT; hit.push(w + '~*'); } }
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
/* A thought's text in full: one sentence by the recording rule, capped only
 * as a safety limit (agents re-read cut texts by id - debriefs, 15 October). */
const THOUGHT_TEXT = 600;
/* expand is asked for one function: it comes whole, up to this many lines -
 * cut to its best lines, the part an agent needed was left out (debriefs). */
const EXPAND_LINES = 220;
function fullCode(region) {
  const lines = region.text.split('\n');
  const out = lines.slice(0, EXPAND_LINES).map((l, i) => String(region.from + i).padStart(5) + '  ' + l);
  if (lines.length > EXPAND_LINES) out.push('  … ' + (lines.length - EXPAND_LINES) + ' more lines - read ' + region.file + ':' + (region.from + EXPAND_LINES) + '-' + region.to);
  return out.join('\n');
}

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
  /* A comment line that holds the question's words comes with its whole
   * sentence - back to where the sentence before it ended, on to where it
   * ends, SENTENCE_MAX lines at most - ranked as one by all the words in it.
   * Line by line, topics.js's header gave "a thought's domain follows from
   * its kind and outcome, which keeps" and could cut the promise that
   * follows - an answered question stops being one - which is where its bug
   * shows. Code lines keep a little context each, as before. */
  const text = (i) => String(lines[i] || '').replace(/^\s*(?:\/\*+|\*+\/?|\/\/+|#+)\s?/, '').trim();
  const isComment = (i) => i >= 0 && i < lines.length && COMMENT.test(lines[i]);
  const ends = (i) => !text(i) || /[.?!:]["')\]]?$/.test(text(i));
  for (let i = 0; i < lines.length; i++) {
    if (!weight[i]) continue;
    if (!isComment(i)) { for (let k = i - CONTEXT; k <= i + CONTEXT; k++) add(k, weight[i] * 10 - Math.abs(k - i)); continue; }
    let s = i, e = i;
    while (s > 0 && isComment(s - 1) && !ends(s - 1) && e - s < SENTENCE_MAX - 1) s--;
    while (e < lines.length - 1 && isComment(e + 1) && !ends(e) && e - s < SENTENCE_MAX - 1) e++;
    let sum = 0;
    for (let k = s; k <= e; k++) sum += weight[k];
    for (let k = s; k <= e; k++) add(k, sum * 10);
  }
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
const LEARNED_EXTRA = 2;     // learned waiting thoughts shown beside the word search's, never in place of them
const WHY_CHARS = 320;
const cap = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…'; };

/* Shares of the regions a word may be in: a new subject is told by words in
 * at most RARE_SHARE of them (knowledge 6%, wallpaper 3%, langgraph none,
 * against error at 10% and agent at 71% when measured); what is carried is
 * at most CARRY_SHARE. Counted over own and why words, so the words of
 * commit messages and thoughts make a word common too. */
export const RARE_SHARE = 0.07;
const CARRY_SHARE = 0.15;
const CARRY_MAX = 8;

/* A question is on a new subject when it has rare words of its own - in few
 * regions, or in none - and less than half their weight is in the code the
 * last question landed on or among the words it carried. One with no rare
 * word narrows the last question. */
function newSubject(ix, text, previous, carry) {
  const rare = [...questionTerms(text)].filter((w) => !w.includes('_') && (ix.df.get(w) || 0) <= ix.regions.length * RARE_SHARE);
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
  const own = [...questionTerms(text)].filter((w) => ix.df.has(w) && (w.includes('_') || ix.df.get(w) <= ix.regions.length * CARRY_SHARE))
    .sort((a, b) => idfOf(ix, b) - idfOf(ix, a));
  return [...new Set([...own, ...carried])].slice(0, CARRY_MAX);
}

/* ─────────────────────────────────────────────── the map (t-da800103d5)
 *
 * A feature's answer starts with a map in three rings, before any content:
 *
 *   core     the files that implement it: they hold the question's words
 *            and, as a boost never a requirement (t-a0ac7d5bc9), were
 *            written by commits whose thoughts are in its topic - so code
 *            that only mentions a feature ranks below code that is it
 *   wiring   one hop out of the core (t-33da97ee86): the files importing it
 *            and the lines using what they import or the variables it is
 *            assigned to; and the files sharing its distinctive strings -
 *            event names, URLs, format ids - which no import shows
 *   surface  wiring that lands in front-end files: where it is shown
 *
 * What the core itself imports stays off the map (t-34fbb3011c). Imports and
 * strings are found by pattern (t-de9d13a9a0). Then a tree for the core's
 * best functions - the code, the commits that wrote it with their why, the
 * thoughts they settled, what is still open - and every other entry on the
 * map one expand away. */

const IMPORT_JS = /^\s*import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]/;
const REQUIRE_JS = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/;
const IMPORT_PY = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/;
const DISTINCT = /['"`]([A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|\/api\/[\w/.-]+|[a-z]+\.[a-z]+\/\d+)['"`]/g;
const BROWSER = /^(js|public|web|client|static|frontend|ui)\//;
/* A file's score is its best word match times (OWN_FLOOR + ownership): a file
 * no commit of the topic wrote keeps half its score - ownership is never
 * required - but a file that only mentions the feature falls below one that
 * is it. Added as a bonus instead, code-find.js (words 100%, ownership 11%)
 * still outranked path-recorder.js (58%, 97%) for "path knowledge". */
const OWN_FLOOR = 0.5;
const FUNCTION_MIN = 4;      // a core function has at least this many lines when the file has one
const CORE_NEAR = 0.45;      // a core file scores at least this share of the best
const WIRING_PER_FILE = 3;   // so one file cannot fill the wiring
const CORE_FILES = 4;
const CORE_FUNCTIONS = 8;
const WIRING_SHOWN = 10;
const SURFACE_SHOWN = 4;
const TREES = 2;
const DECIDED_LOOK = 5;      // settled thoughts weighed against the code: the best this many by rank
const DECIDED_FLOOR = 0.3;   // ... that hold at least this share of the question
const DECIDED_SHOWN = 3;
const LEAD_MARGIN = 0.1;      // a waiting thought holding this much more of the question than the code leads, and one tree follows
const LEAD_CLOSE = 0.2;      // ... within this much less, it only comes first, and both trees stay
const WORDS = 8;

/* The name of a region in a word or two: learnKeys, PathRecorder.walk. */
export const shortName = (r) => {
  const m = String(r.name).replace(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?/, '').match(/^(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+|def\s+|static\s+|get\s+|set\s+)?([\w$.-]+)/);
  return m ? m[1] : String(r.name).slice(0, 30);
};
const entry = (r) => r.file.split('/').pop() + ' · ' + shortName(r) + ' ' + r.from + '-' + r.to;

function resolveImport(from, spec, known) {
  if (spec.startsWith('.')) {
    const base = path.posix.join(path.posix.dirname(from), spec);
    for (const c of [base, base + '.js', base + '.mjs', base + '.ts', base + '/index.js', base + '.py']) if (known.has(c)) return c;
    return null;
  }
  const py = spec.replace(/\./g, '/') + '.py';
  return known.has(py) ? py : null;
}
function namesOf(clause) {
  if (!clause) return [];
  const out = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) for (const p of braces[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) out.push(n); }
  for (const s of clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').split(',')) if (/^[\w$]+$/.test(s.trim())) out.push(s.trim());
  return out;
}

/* Every code file at HEAD with its imports and distinctive strings, and who
 * imports whom. Kept per HEAD. */
export function codeGraph(repoDir) {
  const { head, regions } = codeRegions(repoDir);
  const m = mem(repoDir);
  if (m.graph && m.graph.head === head) return m.graph;
  const byFile = new Map();
  for (const r of regions) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  const files = new Map();
  for (const [f, rs] of byFile) {
    if (rs[0].kind === 'doc') continue;
    rs.sort((a, b) => a.from - b.from);
    files.set(f, { regions: rs, lines: rs.map((r) => r.text).join('\n').split('\n'), imports: [], strings: new Set(), browser: BROWSER.test(f) || /\.(html?|s?css|vue|svelte)$/.test(f) });
  }
  const known = new Set(files.keys());
  const importers = new Map();
  const strings = new Map();     // string -> [{ file, line }]
  for (const [f, info] of files) {
    info.lines.forEach((l, i) => {
      let mm, target = null, names = [];
      if ((mm = IMPORT_JS.exec(l)) || (mm = REQUIRE_JS.exec(l))) { target = resolveImport(f, mm[2], known); names = namesOf(mm[1]); }
      else if (/\.py$/.test(f) && (mm = IMPORT_PY.exec(l))) { target = resolveImport(f, mm[1].startsWith('.') ? './' + mm[1].replace(/^\.+/, '') : mm[1], known); names = mm[2].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()); }
      if (target && target !== f) {
        info.imports.push({ target, names, line: i + 1 });
        if (!importers.has(target)) importers.set(target, []);
        importers.get(target).push({ file: f, names, line: i + 1 });
      }
      for (const s of stringsIn(l)) {
        info.strings.add(s);
        if (!strings.has(s)) strings.set(s, []);
        strings.get(s).push({ file: f, line: i + 1 });
      }
    });
  }
  m.graph = { head, files, importers, strings };
  return m.graph;
}

/* The distinctive strings on a line - an event name in capitals with an
 * underscore, a URL path under /api/ (up to its query), a format id like
 * gitx.path/0 - indexed once per HEAD, so finding who else uses one is a
 * lookup, not a scan of every file per question. */
function stringsIn(line) {
  const out = new Set();
  for (const s of line.matchAll(DISTINCT)) out.add(s[1]);
  for (const s of line.matchAll(/['"`](\/api\/[\w/.-]+)/g)) out.add(s[1]);
  return out;
}

const regionAt = (info, line) => info.regions.find((r) => line >= r.from && line <= r.to) || null;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Where an importer uses what it imported: the names themselves, and the
 * variables they are assigned to - `const paths = new PathRecorder(…)` makes
 * every `paths.` a use (paths.onCall at the end of each tool call). */
function usesIn(info, names, importLine) {
  const vars = new Set();
  const named = names.map((n) => new RegExp('\\b' + escapeRe(n) + '\\b'));
  info.lines.forEach((l) => {
    for (const n of names) {
      const v = l.match(new RegExp('(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:await\\s+)?(?:new\\s+)?' + escapeRe(n) + '\\b'));
      if (v) vars.add(v[1]);
    }
  });
  const viaVar = [...vars].map((v) => new RegExp('\\b' + escapeRe(v) + '\\s*[.(]'));
  const out = [];
  info.lines.forEach((l, i) => {
    if (i + 1 === importLine) return;
    if (named.some((re) => re.test(l)) || viaVar.some((re) => re.test(l))) out.push(i + 1);
  });
  return out;
}

/* The topic a question is about: one whose title is all in the question
 * ("path knowledge"), else the one the best regions' commits settled most
 * thoughts in. */
function topicOf(cx, query, scored) {
  const q = questionTerms(query);
  for (const [id, title] of cx.topics) {
    const tt = [...termsOf(title)].filter((w) => !w.includes('_'));
    if (tt.length && tt.every((w) => q.has(w))) return id;
  }
  const votes = new Map();
  for (const { r, score } of scored.slice(0, 6)) {
    const n = r.to - r.from + 1;
    for (const [c, k] of Object.entries(r.commits)) {
      const cm = cx.commits.get(c);
      if (!cm || k / n < WHY_SHARE) continue;
      for (const t of cm.thoughts) if (t.topic) votes.set(t.topic, (votes.get(t.topic) || 0) + score * k / n);
    }
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/* The share of a file's lines written by commits whose settled thoughts are
 * in the topic - a commit settling thoughts in two topics counts for each in
 * proportion; a commit settling none counts for no topic. */
function ownershipOf(cx, regions, topic) {
  if (!topic) return 0;
  let mine = 0, all = 0;
  for (const r of regions) {
    for (const [c, k] of Object.entries(r.commits)) {
      all += k;
      const cm = cx.commits.get(c);
      if (!cm || !cm.thoughts.length) continue;
      mine += k * cm.thoughts.filter((t) => t.topic === topic).length / cm.thoughts.length;
    }
  }
  return all ? mine / all : 0;
}

/* The feature's own words, as written: what the core's comments and names
 * say that the question did not, rarest first - suggested words for the next
 * question. From comments and identifiers only, and never the language's own
 * words: taken from whole lines they were "what", "class", "span". */
const MONTHS = /^(?:january|february|march|april|may|june|july|august|september|october|november|december)$/;
const NOT_WORDS = new Set(('what when where which while with that this those these from into have will would could should about there their ' +
  'class const function return continue import export default async await break case catch else false finally true null undefined ' +
  'typeof instanceof void delete throw switch extends static super yield span button div input label style script json string number ' +
  'object array length push slice filter map join split replace match test value values keys entries args other each every some ' +
  'first last next prev item items list data info text name file line lines').split(' '));
function wordsOfCore(cx, coreRegions, asked) {
  const count = new Map(), spelled = new Map();
  for (const r of coreRegions) {
    const said = String(r.text).split('\n').map((l) => {
      const c = l.match(/(?:\/\/|\/\*|^\s*\*|#)(.*)$/);
      const names = (l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ').match(/[A-Za-z_$][\w$]*/g) || []).filter((n) => /[a-z][A-Z]|_/.test(n));
      return (c ? c[1] : '') + ' ' + names.join(' ');
    }).join(' ');
    /* toISOString is "to ISO String", not "isostring". */
    for (const raw of said.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').match(/[A-Za-z][A-Za-z0-9]{3,}/g) || []) {
      const lower = raw.toLowerCase();
      const w = stem(lower);
      if (NOT_WORDS.has(lower) || MONTHS.test(lower) || /\d/.test(raw) || asked.has(w) || !cx.df.has(w)) continue;
      count.set(w, (count.get(w) || 0) + 1);
      if (!spelled.has(w)) spelled.set(w, raw.toLowerCase());
    }
  }
  return [...count].filter(([w, n]) => n >= 2 && (cx.df.get(w) || 0) <= cx.regions.length * CARRY_SHARE)
    .sort((a, b) => b[1] * idfOf(cx, b[0]) - a[1] * idfOf(cx, a[0])).slice(0, WORDS).map(([w]) => spelled.get(w));
}

export function buildMap(repoDir, cx, query, terms, scored, use = null) {
  const g = codeGraph(repoDir);
  const topic = topicOf(cx, query, scored);
  const byFile = new Map();
  for (const x of scored) {
    if (x.r.kind === 'doc') continue;
    if (!byFile.has(x.r.file)) byFile.set(x.r.file, []);
    byFile.get(x.r.file).push(x);
  }
  const files = [...byFile].map(([f, xs]) => {
    const info = g.files.get(f);
    const own = info ? ownershipOf(cx, info.regions, topic) : 0;
    return { f, xs, best: xs[0].score, own, score: xs[0].score * (OWN_FLOOR + own) };
  }).sort((a, b) => b.score - a.score);
  const top = files.length ? files[0].score : 0;
  const near = files.filter((x) => x.score >= top * CORE_NEAR).slice(0, CORE_FILES);
  /* A file holding a function earlier agents used for questions like this
   * comes in too, after the rest - the hint widens the map. */
  for (const x of files) if (!near.includes(x) && x.xs.some((y) => y.hit.includes('learned'))) near.push(x);
  /* A front-end file among them is where the feature is shown - surface,
   * not core (monitor.js for path knowledge) - unless the feature lives only
   * in the front end, when there is no other core. */
  const isBrowser = (f) => !!(g.files.get(f) || {}).browser;
  const coreFiles = near.some((x) => !isBrowser(x.f)) ? near.filter((x) => !isBrowser(x.f)) : near;
  const shownAt = near.filter((x) => !coreFiles.includes(x));
  /* Each core file's functions that hold the question, real functions before
   * two-line helpers; then one from each file in turn, so one file cannot
   * fill the map while the next has only its helpers on it. */
  /* Within a core file a function ranks by its words and by how much of it
   * the feature's commits wrote, and a real function before a one-liner: by
   * words alone path-recorder.js showed pathsHome, localAppData and warn,
   * which say "path", and none of PathRecorder's methods, which do not. */
  const lines = (r) => r.to - r.from + 1;
  const wordOf = new Map(scored.map((x) => [x.r, x]));
  const perFile = coreFiles.map((cf) => {
    const info = g.files.get(cf.f);
    const all = (info ? info.regions : cf.xs.map((x) => x.r)).map((r) => {
      const w = wordOf.get(r);
      const own = ownershipOf(cx, [r], topic);
      const size = 0.6 + 0.4 * Math.min(1, lines(r) / 30);
      /* Used by earlier agents asking this: up to half again; left alone by
       * them: down to half. No evidence: unchanged. */
      const learned = use && use.get(r.file + '::' + shortName(r));
      const lift = learned ? 0.5 + learned.mean : 1;
      return { r, score: w ? w.score : 0, hit: w ? w.hit : [], own, rankBy: ((w ? w.score : 0) + own) * size * lift };
    }).filter((x) => x.score > 0 || x.own >= 0.5);
    const max = Math.max(0, ...all.map((x) => x.rankBy));
    return all.filter((x) => x.rankBy >= max * 0.5)
      .sort((a, b) => (lines(b.r) >= FUNCTION_MIN) - (lines(a.r) >= FUNCTION_MIN) || b.rankBy - a.rankBy)
      .map((x) => ({ ...x, fileOwn: cf.own, fileScore: cf.score }));
  });
  const coreShown = [];
  for (let i = 0; coreShown.length < CORE_FUNCTIONS && perFile.some((l) => l[i]); i++) {
    for (const l of perFile) if (l[i] && coreShown.length < CORE_FUNCTIONS) coreShown.push(l[i]);
  }

  /* Wiring and surface: one hop out of the core files. */
  const coreSet = new Set(coreFiles.map((x) => x.f));
  const hits = new Map();        // file -> Map(regionKey -> { r, lines:Set, via:Set })
  const hit = (file, line, via) => {
    const info = g.files.get(file);
    const r = info && regionAt(info, line);
    if (!r) return;
    if (!hits.has(file)) hits.set(file, new Map());
    const k = r.from;
    const e = hits.get(file).get(k) || { r, lines: new Set(), via: new Set() };
    e.lines.add(line); e.via.add(via);
    hits.get(file).set(k, e);
  };
  for (const cf of coreFiles) {
    for (const imp of g.importers.get(cf.f) || []) {
      if (coreSet.has(imp.file)) continue;
      const info = g.files.get(imp.file);
      hit(imp.file, imp.line, 'imports ' + imp.names.join(', '));
      for (const ln of usesIn(info, imp.names, imp.line)) hit(imp.file, ln, 'uses ' + imp.names[0]);
    }
    for (const s of (g.files.get(cf.f) || { strings: new Set() }).strings) {
      for (const at of g.strings.get(s) || []) if (!coreSet.has(at.file)) hit(at.file, at.line, '"' + s + '"');
    }
  }
  const ring = (browser) => [...hits].filter(([f]) => !!(g.files.get(f) || {}).browser === browser)
    .map(([f, regs]) => [f, [...regs.values()].sort((a, b) => b.lines.size - a.lines.size)])
    .sort((a, b) => b[1].reduce((s, e) => s + e.lines.size, 0) - a[1].reduce((s, e) => s + e.lines.size, 0));
  const fmt = (e) => entry(e.r) + ' - ' + [...e.via].slice(0, 2).join('; ') + ' (line' + (e.lines.size > 1 ? 's ' : ' ') + [...e.lines].sort((a, b) => a - b).slice(0, 4).join(', ') + ')';
  const wiring = ring(false).flatMap(([, es]) => es.slice(0, WIRING_PER_FILE)).slice(0, WIRING_SHOWN);
  const surface = [
    ...shownAt.map((x) => x.f.split('/').pop() + ' - holds the question itself: ' + x.xs.slice(0, 2).map((y) => shortName(y.r) + ' ' + y.r.from + '-' + y.r.to).join(', ')),
    ...ring(true).filter(([f]) => !shownAt.some((x) => x.f === f)).map(([f, es]) => f.split('/').pop() + ' - ' + [...new Set(es.flatMap((e) => [...e.via]))].slice(0, 2).join('; ') + ' (' + es.length + ' place' + (es.length === 1 ? '' : 's') + ')')
  ].slice(0, SURFACE_SHOWN);

  return {
    topic,
    topicTitle: topic ? cx.topics.get(topic) : null,
    coreFiles,
    core: coreShown,
    /* Where trees come from: each near file's best function, in file score
     * order - a front-end file among them too, since its commits can hold
     * the answer (the Context Map's design thoughts are e35f9a2's, which
     * wrote context-map.js). */
    treeOrder: near.map((nf) => {
      const pf = perFile[coreFiles.indexOf(nf)];
      return pf && pf.length ? pf[0].r : nf.xs[0].r;
    }),
    wiring,
    wiringText: wiring.map(fmt),
    surface,
    words: wordsOfCore(cx, coreShown.map((x) => x.r), new Set(terms)),
    regions: [...coreShown.map((x) => x.r), ...wiring.map((e) => e.r)]
  };
}

/* One region as a tree (t-904520206d): its lines, the commits git blame
 * names for them with their why, the thoughts each settled - nearest the
 * question first - and what is still open about them. A commit or thought
 * already given in an earlier tree is named, not repeated. */
/* Is a thought about the question? It shares one of the question's
 * distinctive words - in at most ABOUT_SHARE of what GitX holds: domain,
 * goal, waiting, not context, graph or thought, which every thought here
 * says. Rank scores could not tell: the topic-summary thoughts scored above
 * the domain rule on context, graph and the shared topic. A thought earlier
 * agents used for questions like this is about it too. Null when the
 * question has no distinctive word: then nothing is filtered. */
const ABOUT_SHARE = 0.12;
const ABOUT_RANK = 60;       // a fallback thought must rank in the top this many for the question
function aboutTest(rx, query, order) {
  const n = rx.nodes.size;
  const distinct = new Set(tokenize(String(query || '')).map(stem).filter((w) => !ASKING.has(w) && ((rx.postings.get(w) || { size: 0 }).size) <= n * ABOUT_SHARE));
  if (!distinct.size) return null;
  return (t) => (order && order.get(t.id) < 0) || tokenize(t.text).map(stem).some((w) => distinct.has(w));
}

/* `thermal` (4th Dimension v2, thermal/thermal.js): the heat model, the
 * words asked and the words linked to them. With it a tree shows its
 * hottest lines, tells a feature commit from one passing through, names
 * the ideas that lost to what each commit settled, and adds the older
 * commits on those lines. */
function treeOf(cx, rx, r, terms, order, seen, { commitsShown = 2, thoughtsShown = 3, about = null, thermal = null, full = false } = {}) {
  const statusFor = (id) => { const n = rx.nodes.get(id); return n ? statusOf(rx, n) : null; };
  const n = r.to - r.from + 1;
  /* Which commits: the one that wrote most of it, and then those whose
   * thoughts are nearest the question - by lines alone, 342eec6, which
   * wrote few of promote.js's lines but settled the rule asked about, was
   * left out. */
  const near = (c) => { const cm = cx.commits.get(c); const best = cm ? Math.min(999, ...cm.thoughts.map((t) => (order.has(t.id) ? order.get(t.id) : 999))) : 999; return best < 20 ? 1 : best < 60 ? 0.5 : 0; };
  /* Only the thoughts about the question (`about`): a commit that wrote the
   * code also settled thoughts on other things - topics.js's header carries
   * the topic-summary commit, and its summary thoughts came with every
   * question landing there. A second commit comes only with something about
   * the question; the first always, its other thoughts counted, not shown. */
  const isAbout = (t) => !about || about(t);
  const byLines = Object.entries(r.commits).sort((a, b) => b[1] - a[1]);
  const relevant = (c) => { const cm = cx.commits.get(c); return !!cm && cm.thoughts.some(isAbout); };
  const picked = [byLines[0], ...byLines.slice(1).filter(([c]) => relevant(c)).sort((a, b) => (near(b[0]) + b[1] / n) - (near(a[0]) + a[1] / n))].filter(Boolean).slice(0, commitsShown);
  const written = picked.map(([c, k]) => {
    const cm = cx.commits.get(c);
    if (!cm) return null;
    const short = c.slice(0, 7);
    if (seen.commits.has(short)) return { commit: short, wrote: k + ' of ' + n + ' lines', see: seen.commits.get(short) };
    seen.commits.set(short, shortName(r));
    const byOrder = (a, b) => (order.has(a.id) ? order.get(a.id) : 999) - (order.has(b.id) ? order.get(b.id) : 999);
    let ts = cm.thoughts.filter(isAbout).sort(byOrder);
    /* Nothing above the cut: the one the question's words rank best, if it
     * ranks at all - the commit wrote the code the question landed on, and an
     * empty tree lost the rule that a thought pointing back stays waiting,
     * which says it in words every thought here uses. */
    if (!ts.length) { const best = cm.thoughts.slice().sort(byOrder)[0]; if (best && order.has(best.id) && order.get(best.id) < ABOUT_RANK) ts = [best]; }
    const elsewhere = cm.thoughts.length - ts.length;
    return {
      commit: short, date: cm.date, wrote: k + ' of ' + n + ' lines', subject: cap(cm.subject, 110),
      /* A commit that wrote little of this code was made for something else: named,
       * its reasons left to that feature - the same rule that decides why words. */
      role: thermal ? (k >= WHY_LINES || k / n >= WHY_SHARE ? 'feature' : 'passing') : undefined,
      why: cm.body && !(thermal && k < WHY_LINES && k / n < WHY_SHARE) ? cap(cm.body, 260) : undefined,
      settled: ts.length ? ts.slice(0, thoughtsShown).map((t) => {
        if (seen.thoughts.has(t.id)) return { id: t.id, see: seen.thoughts.get(t.id) };
        seen.thoughts.set(t.id, shortName(r));
        const lost = thermal ? (thermal.rejected.get(t.id) || []).slice(0, 2) : [];
        return { id: t.id, status: statusFor(t.id), text: t.text, ...staleOf(cx.repoDir, statusFor(t.id), t.text), rejected: lost.length ? lost : undefined };
      }) : undefined,
      more_settled: ts.length > thoughtsShown ? ts.slice(thoughtsShown).map((t) => t.id).join(', ') : undefined,
      on_other_things: elsewhere ? elsewhere + ' more thought' + (elsewhere === 1 ? '' : 's') + ' it settled, not about this question' : undefined
    };
  }).filter(Boolean);
  /* Still open about it: waiting thoughts that link to what these commits
   * settled - continuing, refining or questioning it. */
  const settledIds = new Set(written.flatMap((w) => (w.settled || []).map((s) => s.id)));
  for (const [c] of Object.entries(r.commits)) { const cm = cx.commits.get(c); if (cm) for (const t of cm.thoughts) settledIds.add(t.id); }
  const open = cx.waiting.filter((t) => (t.links || []).some((l) => settledIds.has(l.to)) || (t.forces || []).some((f) => (f.cites || []).some((x) => settledIds.has(x))))
    .sort((a, b) => (order.has(a.id) ? order.get(a.id) : 999) - (order.has(b.id) ? order.get(b.id) : 999))
    .slice(0, 3).map((t) => ({ id: t.id, status: statusFor(t.id), text: cap(t.text, THOUGHT_TEXT), ...staleOf(cx.repoDir, statusFor(t.id), t.text) }));
  const hot = thermal ? hotCode(thermal.model, r, thermal.words, thermal.expand) : null;
  /* Older commits on these lines - where superseded and rejected ideas attached
   * to earlier versions are. Only when agents have been here: it costs a git log -L. */
  const history = hot ? historyOf(cx.repoDir, r.file, r.from, r.to, new Set(Object.keys(r.commits))).map((h) => {
    const cm = [...cx.commits.values()].find((c) => c.hash.startsWith(h.commit));
    const ts = cm ? cm.thoughts.filter((t) => !thermal.about || thermal.about(t)).slice(0, 2) : [];
    return { ...h, settled: ts.length ? ts.map((t) => ({ id: t.id, status: statusFor(t.id), text: cap(t.text, THOUGHT_TEXT), rejected: (thermal.rejected.get(t.id) || []).slice(0, 1).length ? (thermal.rejected.get(t.id) || []).slice(0, 1) : undefined })) : undefined };
  }) : [];
  return { function: entry(r), ref: r.file + ':' + r.from, heat: hot ? hot.heat : undefined, code: full ? fullCode(r) : hot ? hot.code : linesFor(r, terms), written_by: written, open: open.length ? open : undefined, history: history.length ? history : undefined };
}

/* A question answered from the code down, map first (t-da800103d5):
 *
 *   map       core, wiring, surface and the feature's words - whole
 *             functions with line ranges, before any content
 *   trees     the core's best functions as trees: code, the commits that
 *             wrote it and why, the thoughts they settled, what is open
 *   thinking  doc sections the question landed in
 *   context   beside the stack (t-a078ddeea8): what is still waiting, by
 *             the words - for when the agent works on it
 *
 * Every map entry opens with expand. With no region holding enough of the
 * question there is no code yet (t-6c82966c3a). `carry` is the previous
 * question's rare words and `previous` the regions it landed in: the words
 * ride along at half weight unless this question is on a new subject
 * (newSubject). `paths` keeps the code to those files when any holds some
 * of the question. */
/* `use` is what earlier agents' walks of questions like this one used
 * (walk-learn.js): key -> { mean, a, b }. A function they clearly used joins
 * the search even when the question's words miss it, ranks higher in the
 * map, and their thoughts come first in their commits - a hint that widens
 * what is found and orders it, never what is hidden (t-11190c437f). */
/* USED_A was 1, and a use fades by DECAY per day from the moment it is
 * recorded, so one agent's use was worth 0.99998 seconds later and never
 * counted - every node needed two agents, and the learning rounds on the
 * held-out set learned almost nothing. At 0.9 one recent use counts, and
 * after about five days it needs a second agent to stay. */
const USED_MEAN = 0.6, USED_A = 0.9;
const learnedUse = (v) => v && v.a >= USED_A && v.mean >= USED_MEAN;
export function codeFirst(repoDir, { query, carry = [], previous = [], paths = [], weights = null, avoid = null, use = null, thermal = null } = {}) {
  const t0 = Date.now();
  const cx = buildCodeIndex(repoDir);
  const rx = rankIndexFor(repoDir);
  const within = (paths || []).map((p) => String(p).split('::')[0].replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  const search = (opts) => {
    const res = findCode(cx, query, { ...opts, weights, avoid, limit: 400, near: 0, extra: thermal ? thermal.expand : null });
    if (!within.length) return res;
    const inside = res.found.filter(({ r }) => within.some((p) => r.file === p || r.file.startsWith(p.replace(/\/?$/, '/'))));
    return { terms: res.terms, found: inside.length ? inside : res.found };
  };
  /* A follow-up or a new subject (t-71baf0316b) - decided by the session's
   * pool when it passes weights (session-pool.js). */
  const carried = !weights && carry.length && !newSubject(cx, query, previous, carry) ? carry : [];
  const { terms, found } = search({ carry: carried });
  const tSearch = Date.now() - t0;
  const wordBest = found.length ? found[0].score : 0;
  /* Functions earlier agents used for questions like this, found or not. */
  const learnedHere = [];
  if (use) {
    const byKey = new Map(cx.regions.map((r) => [r.file + '::' + shortName(r), r]));
    for (const [k, v] of use) {
      const r = learnedUse(v) && byKey.get(k);
      if (!r) continue;
      const have = found.find((x) => x.r === r);
      if (have) have.hit.push('learned');
      else learnedHere.push({ r, score: Math.max(NO_CODE, wordBest * 0.6), hit: ['learned'] });
    }
    found.push(...learnedHere);
    found.sort((a, b) => b.score - a.score);
  }
  const best = found.length ? found[0].score : 0;
  const noCode = best < NO_CODE;
  const words = weights ? [...weights].filter(([w, m]) => m >= 0.5 && !w.includes('_')).map(([w]) => w).join(' ')
    : carried.length ? query + ' ' + carried.join(' ') : query;
  const settledRanked = rank(rx, { text: words, layers: ['thought'], limit: 200 }).results;
  const order = new Map(settledRanked.map((r, i) => [r.id, i]));
  for (const [k, v] of use || []) if (k.startsWith('t-') && learnedUse(v)) order.set(k, -1 - v.a);
  const statusFor = (id) => { const n = rx.nodes.get(id); return n ? statusOf(rx, n) : null; };
  /* The context layer is found by words alone; what agents asking questions
   * like this did reorders it (t-9299c80214). A waiting thought they opened
   * or cited rises, one they were shown and left sinks, by CONTEXT_SHIFT
   * places for every half of the mean away from even. Given in full, a thought
   * is rarely opened, so being left weighs on all alike - what separates the
   * stale from the useful is which ones get opened or cited. */
  const CONTEXT_SHIFT = 10;
  const found20 = rank(rx, { text: words, layers: ['context'], limit: 20 }).results;
  const context = use ? found20.map((x, i) => { const v = use.get(x.id); return { x, k: i + (v ? (0.5 - v.mean) * 2 * CONTEXT_SHIFT : 0) }; }).sort((a, b) => a.k - b.k).map((y) => y.x) : found20;

  /* Which layer leads (t-69b4d53d80). Code first is right when the answer is
   * in code; but asked "what did we decide", 11 of the owner's 18 questions
   * were answered only by a waiting thought, and that came last, under 2-3k
   * tokens of trees that did not answer it. So each waiting thought is scored
   * as a region is - the share of the question's weight its words hold, its
   * text in full and its reasons at WHY_WEIGHT - and when the best holds
   * LEAD_MARGIN more of the question than the best code, the context comes
   * first and one tree, not TREES, follows it: the code it would touch. */
  const qw = new Map(terms.filter((w) => !w.includes('_')).map((w) => [w, idfOf(cx, w) * (weights ? (weights.get(w) || 0) : carried.includes(w) ? 0.5 : 1)]));
  const qTotal = [...qw.values()].reduce((s, x) => s + x, 0);
  const shareOf = (t) => {
    if (!qTotal) return 0;
    const node = rx.nodes.get(t.id) || t;
    const own = termsOf(t.text || '');
    /* Thermal: the words that led agents to this thought are its words too. */
    if (thermal) for (const w of attachedWords(thermal.model, t.id)) own.add(w);
    const why = termsOf((node.forces || []).map((f) => f.text || '').join(' '));
    let s = 0;
    for (const [w, x] of qw) s += own.has(w) ? x : why.has(w) ? x * WHY_WEIGHT : 0;
    return s / qTotal;
  };
  /* No code holds the question's words - but a commit's message may say it
   * in them, and the code that commit wrote may still stand under other
   * words (t-54404c22ee: "the sidebar changes its size" found no code, while
   * 5d27166's message says the sidebar kept "one height" and 23 of its lines
   * stand). Those commits come with the code they still own, and their
   * words are offered for the next question. */
  const byMessage = noCode ? rank(rx, { text: words, layers: ['commit'], limit: 3 }).results.map((x) => {
    const cm = [...cx.commits.values()].find((c) => c.hash.startsWith(String(x.id).slice(0, 7)));
    if (!cm) return null;
    const c12 = cm.hash.slice(0, 12);
    const owns = cx.regions.filter((r) => (r.commits[c12] || 0) >= WHY_LINES).sort((a, b) => b.commits[c12] - a.commits[c12]);
    return { commit: cm.hash.slice(0, 7), date: cm.date, subject: cap(cm.subject, 110), why: cm.body ? cap(cm.body, 260) : undefined, still_in: owns.length ? owns.slice(0, 4).map((r) => entry(r) + ' (' + r.commits[c12] + ' lines)') : undefined, _cm: cm };
  }).filter((x) => x && x.still_in) : [];
  const messageWords = byMessage.length ? (() => {
    const asked = new Set(terms), seenW = new Set(), out = [];
    for (const m of byMessage) for (const raw of (m._cm.subject + ' ' + m._cm.body).match(/[A-Za-z][A-Za-z]{3,}/g) || []) {
      const lower = raw.toLowerCase(), w = stem(lower);
      if (asked.has(w) || seenW.has(w) || NOT_WORDS.has(lower) || !cx.df.has(w) || cx.df.get(w) > cx.regions.length * CARRY_SHARE) continue;
      seenW.add(w); out.push(lower);
    }
    return out.slice(0, WORDS);
  })() : [];

  /* Settled thoughts compete for the top too. They used to reach an answer
   * only inside a tree, under the code that settled them - so when the code
   * search went wrong, the thought ranked first for the question was never
   * shown ("so it get the rules... buried in deep", tune2). The best of the
   * settled and the waiting is what the code is weighed against. */
  const decidedCandidates = settledRanked.slice(0, DECIDED_LOOK).map((t) => ({ t, share: shareOf(t) })).filter((x) => x.share >= DECIDED_FLOOR);
  /* Thermal (4th Dimension v2): a thought earlier agents' words are attached
   * to joins the answer itself, not only its order. Asked in other words the
   * search can miss it, and naming an id the agent must open again is a turn
   * the agent pays for. */
  /* Beside the word search's own, never in place of it: learned thoughts used
   * to go to the front without limit, and words an agent working through a
   * list had attached to many thoughts pushed the one the question asked for
   * out of the five shown (held-out, two wordings, three answers lost). Now
   * the strongest LEARNED_EXTRA not already shown join after them. */
  const learnedCtx = [];
  if (thermal) for (const [k, v] of [...(use || [])].sort((a, b) => b[1].a - a[1].a)) {
    if (!k.startsWith('t-') || !learnedUse(v)) continue;
    const n = rx.nodes.get(k);
    if (!n) continue;
    if (n.layer === 'context') {
      if (learnedCtx.length >= LEARNED_EXTRA || context.slice(0, CONTEXT_SHOWN).some((x) => x.id === k)) continue;
      const i = context.findIndex((x) => x.id === k);
      learnedCtx.push(i >= 0 ? context.splice(i, 1)[0] : { id: k, text: n.text, topic: n.topic });
    } else if (!decidedCandidates.some((x) => x.t.id === k)) decidedCandidates.push({ t: { id: k, text: n.text }, share: Math.max(DECIDED_FLOOR, shareOf({ id: k, text: n.text })) });
  }
  if (learnedCtx.length) context.splice(Math.min(CONTEXT_SHOWN, context.length), 0, ...learnedCtx);
  const shownCtx = CONTEXT_SHOWN + learnedCtx.length;
  const contextBest = Math.max(0, ...context.slice(0, shownCtx).map(shareOf), ...decidedCandidates.map((x) => x.share));
  /* With no code, the commits whose messages say it are what the code side
   * has - c-sidebar's answer is one, and the context led over it on the
   * code score alone. */
  const messageBest = byMessage.length ? Math.max(...byMessage.map((m) => shareOf({ text: m._cm.subject + ' ' + m._cm.body }))) : 0;
  const contextLeads = !byMessage.length && contextBest > Math.max(best, messageBest) + LEAD_MARGIN;
  /* Close is enough to come first, not to cut: moving the context above the
   * trees costs no tokens, while dropping a tree lost two of the 13 facts
   * on the bench. The few commits found by message, with no code, stay first. */
  const contextFirst = contextLeads || (!byMessage.length && contextBest >= Math.max(best, messageBest) - LEAD_CLOSE);
  for (const m of byMessage) delete m._cm;

  const map = noCode ? null : buildMap(repoDir, cx, words || query, terms, found.filter((x) => x.score >= best * 0.3), use);
  const docs = noCode ? [] : spread(found.filter(({ r }) => r.kind === 'doc'), DOCS_SHOWN).filter((x) => x.score >= best * 0.5);
  const seen = { commits: new Map(), thoughts: new Map() };
  /* Trees from different files and different commits: two written by one
   * commit share their reasons, and the second said only "see the first". */
  const treeRegions = [];
  const topCommit = (r) => (Object.entries(r.commits).sort((a, b) => b[1] - a[1])[0] || [''])[0];
  for (const r0 of map ? map.treeOrder : []) {
    if (treeRegions.length >= (contextLeads ? 1 : TREES)) break;
    if (treeRegions.some((r) => r.file === r0.file || topCommit(r) === topCommit(r0))) continue;
    treeRegions.push(r0);
  }
  const about = aboutTest(rx, words, order);
  const th = thermal ? { ...thermal, about, rejected: rejectedIndex(cx) } : null;
  const trees = treeRegions.map((r) => treeOf(cx, rx, r, terms, order, seen, { about, thermal: th }));
  const summary = map && map.topic ? summaryOf(rx, map.topic) : null;


  /* What is decided about it and not already in a tree, best share first. */
  const decided = decidedCandidates.filter((x) => !seen.thoughts.has(x.t.id)).sort((a, b) => b.share - a.share).slice(0, DECIDED_SHOWN).map((x) => x.t);
  const contextOut = {
    decided: decided.length ? decided.map((t) => ({ id: t.id, status: statusFor(t.id), text: t.text })) : undefined,
    context: context.slice(0, shownCtx).map((r) => ({ id: r.id, status: statusFor(r.id), text: r.text, topic: r.topic ? (rx.topics.get(r.topic) || {}).title : undefined })),
    more_context: context.length > shownCtx ? context.length - shownCtx + ' more waiting thoughts hold these words - gitx_thought outcome or topic lists them' : undefined
  };
  const out = {
    asked: query,
    carried: carried.length ? carried : undefined,
    lead: contextFirst ? 'thinking - a thought holds ' + Math.round(contextBest * 100) + '% of the question, the closest code ' + Math.round(best * 100) + '%: what is decided or discussed comes first, the code it would touch after it' : undefined,
    ...(contextFirst ? contextOut : {}),
    no_code: noCode ? 'No code at HEAD is about this' + (best ? ' (the closest region holds ' + Math.round(best * 100) + '% of the question)' : '') + (byMessage.length ? ' in these words. Commits whose messages match are below with the code they still own - expand one, or ask again with one of their words.' : ' - it is not built yet, or not in these words. What is decided or discussed is in context below: plans, not code.') : undefined,
    commits_by_message: byMessage.length ? byMessage : undefined,
    next_words: messageWords.length ? messageWords : undefined,
    map: map ? {
      feature: map.topicTitle || undefined,
      core: map.core.map((x) => entry(x.r) + (treeRegions.includes(x.r) ? ' (tree below)' : '')),
      wiring: map.wiringText.length ? map.wiringText : undefined,
      surface: map.surface.length ? map.surface : undefined,
      words: map.words.length ? map.words : undefined,
      open_any: 'gitx_search { expand: "<a name from the map>" } gives that function as a tree; a word from words as your next query narrows this one'
    } : undefined,
    trees: trees.length ? trees : undefined,
    thinking: docs.length ? docs.map(({ r, score }) => ({ doc: r.file + ' :: ' + cap(r.name, 70), lines: r.from + '-' + r.to, matched: Math.round(score * 100) + '%', text: linesFor(r, terms) })) : undefined,
    summaries: summary ? [summary] : undefined,
    ...(contextFirst ? {} : contextOut)
  };

  /* For GitX Monitor and the path recorder (t-6a7335ce0a): the core and the
   * wiring as code, the trees' commits and thoughts, the docs and context. */
  const nodes = [], links = [], c8 = (c) => c.slice(0, 8);
  const codeId = (r) => (r.kind === 'doc' ? 'doc:' : 'code:') + r.file + ':' + r.from;
  if (map) {
    map.core.forEach((x, i) => nodes.push({ id: codeId(x.r), layer: 'code', role: 'result', rank: i + 1, kind: 'code', status: 'CORE ' + Math.round(x.score * 100) + '%', text: entry(x.r), commits: [] }));
    map.wiring.forEach((e) => { if (!nodes.some((n) => n.id === codeId(e.r))) nodes.push({ id: codeId(e.r), layer: 'code', role: 'edge', kind: 'code', status: 'WIRING', text: entry(e.r), commits: [] }); });
  }
  for (const t of trees) for (const w of t.written_by) {
    if (w.see) continue;
    const full = [...cx.commits.values()].find((cm) => cm.hash.startsWith(w.commit));
    const id = full ? c8(full.hash) : w.commit;
    if (!nodes.some((n) => n.id === id)) nodes.push({ id, layer: 'commit', role: 'result', status: 'COMMIT ' + (w.date || ''), text: w.subject });
    const from = nodes.find((n) => n.layer === 'code' && n.text === t.function);
    if (from) { links.push([from.id, 'written-by', id]); from.commits.push(id); }
    for (const s of w.settled || []) {
      if (s.see) continue;
      nodes.push({ id: s.id, layer: 'thought', role: 'result', status: s.status, text: cap(s.text, 160) });
      links.push([id, 'settled', s.id]);
    }
  }
  docs.forEach(({ r }, i) => nodes.push({ id: codeId(r), layer: 'thought', role: 'result', rank: i + 1, kind: 'doc', status: 'DOC', text: cap(r.name, 120) }));
  decided.forEach((t, i) => nodes.push({ id: t.id, layer: 'thought', role: 'result', rank: i + 1, status: statusFor(t.id), text: cap(t.text, 160) }));
  context.slice(0, shownCtx).forEach((r, i) => nodes.push({ id: r.id, layer: 'context', role: 'result', rank: i + 1, kind: r.kind, status: statusFor(r.id), text: cap(r.text, 160) }));
  const monitor = {
    phases: {
      mode: 'code',
      processing: { regions: cx.regions.length, commits: cx.commits.size, settled: cx.settled.length, waiting: cx.waiting.length, ms: tSearch },
      search: { words: terms.filter((w) => !w.includes('_')), carried: carried.length ? carried : undefined, best: Math.round(best * 100), no_code: noCode || undefined },
      results: { code: map ? map.core.length : 0, wiring: map ? map.wiring.length : 0, surface: map ? map.surface.length : 0, docs: docs.length, commits: nodes.filter((n) => n.layer === 'commit').length, thoughts: nodes.filter((n) => n.layer === 'thought' && n.kind !== 'doc').length, context: context.length, ms: Date.now() - t0 },
      filtering: { returned: nodes.length }
    },
    stack: { nodes, links }
  };
  return {
    answer: out,
    monitor,
    map,
    carry: rareTerms(cx, query, carried),
    landed: map ? map.core.map((x) => x.r.file + ':' + x.r.from) : [],
    ms: Date.now() - t0
  };
}

/* An exact lookup - "which tools are there", "what is the default" - answered
 * with where, not with an essay. Asked in words, both of those missed on the
 * held-out set and one grep each answered them in about 200 tokens; the agent
 * can now ask GitX the same way and get each line with the function it sits
 * in, and the thoughts that say it, by id. `text` is matched as written,
 * ignoring case, or as a regular expression when given as /…/flags. */
const FIND_LINES = 25, FIND_THOUGHTS = 8;
export function findText(repoDir, text, { paths = [] } = {}) {
  const cx = buildCodeIndex(repoDir);
  const re = (() => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(String(text));
    if (m) { try { return new RegExp(m[1], m[2].replace('g', '')); } catch (_) {} }
    return new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  })();
  const within = (paths || []).map((p) => String(p).split('::')[0].replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  const inside = (f) => !within.length || within.some((p) => f === p || f.startsWith(p.replace(/\/?$/, '/')));
  const lines = [];
  let total = 0;
  for (const r of cx.regions) {
    if (!inside(r.file)) continue;
    r.text.split('\n').forEach((l, i) => {
      if (!re.test(l)) return;
      total++;
      if (lines.length < FIND_LINES) lines.push({ at: r.file + ':' + (r.from + i), in: shortName(r), line: l.trim().slice(0, 160) });
    });
  }
  const thoughts = [...cx.settled, ...cx.waiting].filter((t) => re.test(t.text || ''));
  return {
    find: String(text),
    lines,
    more_lines: total > lines.length ? (total - lines.length) + ' more lines match - narrow it, or give paths' : undefined,
    thoughts: thoughts.length ? thoughts.slice(0, FIND_THOUGHTS).map((t) => ({ id: t.id, text: cap(t.text, THOUGHT_TEXT) })) : undefined,
    more_thoughts: thoughts.length > FIND_THOUGHTS ? thoughts.length - FIND_THOUGHTS + ' more thoughts say it' : undefined,
    next: lines.length ? 'expand a function from in, or Read the file at the line' : 'nothing at HEAD says this - ask in words with query'
  };
}

/* One function as a tree, by the name the map gave it - `learnKeys`,
 * `learn.js · learnKeys`, `PathRecorder.walk` - or by file:line. The
 * question's words pick the lines shown; without them, its start. */
export function expandRegion(repoDir, name, { query = '' } = {}) {
  const cx = buildCodeIndex(repoDir);
  const rx = rankIndexFor(repoDir);
  const want = String(name).replace(/\s+\d+-\d+$/, '').trim();
  const [fileHint, fnHint] = want.includes(' · ') ? want.split(' · ') : [null, want];
  const at = want.match(/^(.+):(\d+)$/);
  const candidates = cx.regions.filter((r) => {
    if (r.kind === 'doc') return false;
    if (at) return r.file.endsWith(at[1]) && Number(at[2]) >= r.from && Number(at[2]) <= r.to;
    return shortName(r) === fnHint && (!fileHint || r.file.endsWith(fileHint));
  });
  if (!candidates.length) return { error: 'No function "' + name + '" at HEAD - give a name exactly as the map wrote it, or file:line.' };
  const terms = [...termsOf(query)];
  const order = new Map(rank(rx, { text: query || shortName(candidates[0]), layers: ['thought'], limit: 200 }).results.map((r, i) => [r.id, i]));
  const seen = { commits: new Map(), thoughts: new Map() };
  const about = query ? aboutTest(rx, query, order) : null;
  return { expanded: candidates.slice(0, 2).map((r) => treeOf(cx, rx, r, terms, order, seen, { commitsShown: 3, thoughtsShown: 4, about, full: true })) };
}

/* Everything a question needs, built now - for the server to call when HEAD
 * may have moved, so the first question after a commit does not wait for the
 * rebuild (about 1.8 s). A no-op costing one git call when nothing changed. */
export function warm(repoDir) {
  buildCodeIndex(repoDir);
  rankIndexFor(repoDir);
}
