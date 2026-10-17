/*
 * Agent marks (docs/agent-marks-plan.md): what agents learned about a
 * repository's code, left on the code they learned it from, so a repository
 * with no GitX record builds one from the work agents already do.
 *
 *   a mark     a note on a code region (or a thought or commit), with its
 *              evidence, its links to other marks, and who confirmed or
 *              contradicted it
 *   standing   INFERRED (an agent worked it out), CITED (a final answer cited
 *              code the search had not shown), FROM <file> (a statement in
 *              the repository's own agent files). Never a decision: a mark
 *              enters the decided record only when a thought cites it
 *   anchor     line identity - the commit that wrote each line and its line
 *              in that commit, from git blame - as thermal vision anchors
 *              heat, so a mark follows code that moves and is retired when
 *              its lines are rewritten. A FROM mark is retired when its
 *              statement leaves the file
 *   trust      Beta evidence as learned use: a = 1 for its maker plus each
 *              confirmation, b = each contradiction, every count x 0.98 per
 *              day of age; shown while a >= 0.9 and mean >= 0.6. A FROM mark
 *              does not fade - the file still says it
 *
 * Stored in the GitX data folder, <data>/marks/<repo key>/m-*.json, beside
 * walks and heat: owner-only, never inside a repository, and the same for
 * every clone, since a repository is known by its first commit. Without a
 * data folder, <repo>/.gitx/marks (git-ignored with the rest of .gitx).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildCodeIndex, shortName, questionTerms } from './code-find.js';
import { repoKey } from './path-recorder.js';
import { NO_CONSOLE } from './no-console.js';

const DECAY = 0.98;
const DAY = 86400000;
export const SHOW_A = 0.9, SHOW_MEAN = 0.6;   // the learned-use bar (code-find.js)
const ALIVE_SHARE = 0.5;     // a mark lives while this share of its anchored lines survives
export const NOTE_MAX = 400;
export const SHOWN = 6;      // marks beside one answer

const git = (cwd, args) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const norm = (t) => String(t || '').replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const cleanNote = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > NOTE_MAX ? s.slice(0, NOTE_MAX - 1) + '…' : s; };

export function marksHome(repoDir, dataDir) {
  return dataDir ? path.join(dataDir, 'marks', repoKey(repoDir)) : path.join(repoDir, '.gitx', 'marks');
}

/* ------------------------------------------------------------ the store */

const storeCache = new Map();     // home -> { sig, marks }
function sigOf(dir) {
  let n = 0, newest = 0;
  try { for (const f of fs.readdirSync(dir)) { n++; const m = fs.statSync(path.join(dir, f)).mtimeMs; if (m > newest) newest = m; } } catch (_) { return 'none'; }
  return n + ':' + newest;
}
export function loadMarks(repoDir, dataDir) {
  const home = marksHome(repoDir, dataDir);
  const sig = sigOf(home);
  const hit = storeCache.get(home);
  if (hit && hit.sig === sig) return hit.marks;
  const marks = [];
  try {
    for (const f of fs.readdirSync(home)) {
      if (!/^m-[0-9a-f]{10}\.json$/.test(f)) continue;
      try { marks.push(JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'))); } catch (_) { /* a half-written file: skipped */ }
    }
  } catch (_) { /* none yet */ }
  storeCache.set(home, { sig, marks });
  return marks;
}
export function saveMark(repoDir, dataDir, mark) {
  const home = marksHome(repoDir, dataDir);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, mark.id + '.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(mark, null, 1) + '\n');
  fs.renameSync(tmp, file);
  storeCache.delete(home);
  return mark;
}
const idOf = (...parts) => 'm-' + crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10);

/* ------------------------------------------------------------ anchors */

/* Every line of a file at HEAD as the identity git blame gives it - the
 * commit that wrote it and its line there - cached per HEAD and file. A
 * line not committed yet has no identity. */
const blameCache = new Map();
function headOf(repoDir) { try { return git(repoDir, ['rev-parse', 'HEAD']).trim(); } catch (_) { return null; } }
function blameOf(repoDir, file) {
  const head = headOf(repoDir);
  const k = repoDir + '|' + head + '|' + file;
  if (blameCache.has(k)) return blameCache.get(k);
  const byLine = [];                 // current line (1-based) -> 'commit7:orig'
  try {
    const out = git(repoDir, ['blame', '--porcelain', 'HEAD', '--', file]);
    for (const l of out.split('\n')) {
      const m = l.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
      if (m) byLine[Number(m[3])] = /^0+$/.test(m[1]) ? null : m[1].slice(0, 7) + ':' + m[2];
    }
  } catch (_) { /* not in HEAD */ }
  const at = new Map();
  byLine.forEach((id, line) => { if (id) at.set(id, line); });
  const v = { byLine, at };
  blameCache.set(k, v);
  return v;
}

const regionKey = (r) => r.file + '::' + shortName(r);
const entryOf = (r) => r.file + ' · ' + shortName(r) + ' ' + r.from + '-' + r.to;

/* The anchor for a region now: its lines' identities. */
export function anchorOf(repoDir, r) {
  const b = blameOf(repoDir, r.file);
  const ids = [];
  for (let i = r.from; i <= r.to; i++) if (b.byLine[i]) ids.push(b.byLine[i]);
  return { file: r.file, region: regionKey(r), from: r.from, to: r.to, lines: ids };
}

/* Where a code mark is now, or that it is retired: the region holding most
 * of its surviving lines, while at least half of them survive. Lines not
 * committed when it was made are found again by its region's name. */
export function placeOf(repoDir, mark, cx = buildCodeIndex(repoDir)) {
  const a = mark.anchor;
  if (!a || !a.file) return null;
  const code = cx.regions.filter((r) => r.file === a.file && r.kind !== 'doc');
  if (!a.lines || !a.lines.length) {
    const r = code.find((x) => regionKey(x) === a.region);
    return r ? { r, alive: true } : { alive: false, why: 'its function is gone' };
  }
  const b = blameOf(repoDir, a.file);
  const now = a.lines.map((id) => b.at.get(id)).filter(Boolean);
  if (now.length < a.lines.length * ALIVE_SHARE) return { alive: false, why: (a.lines.length - now.length) + ' of its ' + a.lines.length + ' lines rewritten' };
  const votes = new Map();
  for (const line of now) { const r = code.find((x) => x.from <= line && line <= x.to); if (r) votes.set(r, (votes.get(r) || 0) + 1); }
  const r = [...votes].sort((x, y) => y[1] - x[1])[0];
  return r ? { r: r[0], alive: true } : { alive: false, why: 'its lines are no longer in a function' };
}

/* A FROM mark lives while its file still says it. */
function statementAlive(repoDir, mark) {
  const s = mark.source || {};
  try { return norm(fs.readFileSync(path.join(repoDir, s.file), 'utf8')).includes(s.said); } catch (_) { return false; }
}

/* ------------------------------------------------------------ trust */

const age = (iso, now) => Math.max(0, (now - Date.parse(iso)) / DAY);
export function trustOf(mark, now = Date.now()) {
  const fades = mark.standing !== 'from';
  const w = (iso) => (fades ? DECAY ** age(iso, now) : 1);
  const a = w(mark.created) + (mark.confirmed || []).reduce((s, c) => s + w(c.at), 0);
  const b = (mark.contradicted || []).reduce((s, c) => s + w(c.at), 0);
  const mean = (a + 1) / (a + b + 2);
  return { a, b, mean, shown: a >= SHOW_A && mean >= SHOW_MEAN };
}

export function statusOf(mark, life, trust) {
  if (life && !life.alive) return 'RETIRED - ' + life.why;
  const c = (mark.confirmed || []).length, x = (mark.contradicted || []).length;
  /* Weak for one of two reasons, said apart: contradicted as much as it was
   * backed, or nobody has confirmed it for days. */
  const weak = !trust || trust.shown ? '' : trust.mean < SHOW_MEAN && x ? ' - contested' : ' - weak, not confirmed recently';
  const tail = (c ? ', confirmed by ' + c : '') + (x ? ', contradicted by ' + x : '') + weak;
  if (mark.standing === 'from') return 'FROM ' + mark.source.file + (mark.source.section ? ', "' + mark.source.section + '"' : '') + tail;
  if (mark.standing === 'cited') return 'INFERRED - cited in an answer to "' + String(mark.question || '').slice(0, 60) + '"' + tail;
  return 'INFERRED by an agent' + (mark.evidence && mark.evidence.read ? ' from ' + mark.evidence.read : '') + tail;
}

/* What every reader shows of a mark. */
export function viewOf(repoDir, mark, cx) {
  const life = mark.standing === 'from' && mark.source
    ? (statementAlive(repoDir, mark) ? placeOf(repoDir, mark, cx) || { alive: true } : { alive: false, why: 'the statement left ' + mark.source.file })
    : mark.anchor && mark.anchor.file ? placeOf(repoDir, mark, cx) : { alive: true };
  const trust = trustOf(mark);
  return {
    id: mark.id,
    at: life && life.r ? entryOf(life.r) : mark.anchor ? (mark.anchor.ref || mark.anchor.region) : null,
    note: mark.note || undefined,
    status: statusOf(mark, life, trust),
    links: mark.links && mark.links.length ? mark.links.map((l) => l.as + ' ' + l.to) : undefined,
    _alive: !!(life && life.alive), _shown: trust.shown, _region: life && life.r ? regionKey(life.r) : mark.anchor ? mark.anchor.region || mark.anchor.ref : null, _file: life && life.r ? life.r.file : mark.anchor ? mark.anchor.file : null
  };
}
export const publicView = (v) => ({ id: v.id, at: v.at, note: v.note, status: v.status, links: v.links });

/* ------------------------------------------------------------ writing */

/* A mark on code (a region from the code index), or on a thought or commit
 * (ref), unless an identical one is there already. */
export function createMark(repoDir, dataDir, { r = null, ref = null, note = '', standing = 'inferred', by = null, question = null, evidence = null, source = null, links = [] }) {
  const anchor = r ? anchorOf(repoDir, r) : ref ? { ref } : null;
  const where = anchor ? anchor.region || anchor.ref : '';
  const id = idOf(repoKey(repoDir), where, norm(note), standing === 'from' && source ? source.file + '#' + source.said : '', standing === 'cited' ? String(question || '') : '');
  const have = loadMarks(repoDir, dataDir).find((m) => m.id === id);
  if (have) return { mark: have, existed: true };
  const mark = {
    schema: 'gitx.mark/0', id, created: new Date().toISOString(), standing, by, question: question || undefined,
    anchor, note: cleanNote(note) || undefined, evidence: evidence || undefined, source: source || undefined,
    links: links.length ? links : undefined, confirmed: [], contradicted: []
  };
  saveMark(repoDir, dataDir, mark);
  return { mark, existed: false };
}

export function judgeMark(repoDir, dataDir, id, verdict, { by = null, note = '' } = {}) {
  const mark = loadMarks(repoDir, dataDir).find((m) => m.id === id);
  if (!mark) return { error: 'no mark ' + id };
  const list = verdict === 'contradict' ? 'contradicted' : 'confirmed';
  mark[list] = [...(mark[list] || []), { by, at: new Date().toISOString(), note: note ? cleanNote(note) : undefined }];
  saveMark(repoDir, dataDir, mark);
  return { mark };
}

export function linkMark(repoDir, dataDir, id, links) {
  const mark = loadMarks(repoDir, dataDir).find((m) => m.id === id);
  if (!mark) return { error: 'no mark ' + id };
  const have = new Set((mark.links || []).map((l) => l.as + ' ' + l.to));
  mark.links = [...(mark.links || []), ...links.filter((l) => !have.has(l.as + ' ' + l.to))];
  saveMark(repoDir, dataDir, mark);
  return { mark };
}

/* ------------------------------------------------------------ finding */

/* Every mark as readers see it now, live ones only unless asked. */
export function liveMarks(repoDir, dataDir, { all = false } = {}) {
  const cx = buildCodeIndex(repoDir);
  return loadMarks(repoDir, dataDir).map((m) => ({ m, v: viewOf(repoDir, m, cx) })).filter((x) => all || (x.v._alive && x.v._shown));
}

/* The marks on some code: region keys (file::name) or whole files. */
export function marksOn(repoDir, dataDir, { regions = [], files = [] } = {}) {
  const R = new Set(regions), F = new Set(files);
  return liveMarks(repoDir, dataDir).filter(({ v }) => R.has(v._region) || F.has(v._file)).map(({ v }) => v);
}

/* The marks whose notes hold a question's words, by idf over the notes. */
export function marksFor(repoDir, dataDir, query, { limit = SHOWN } = {}) {
  const live = liveMarks(repoDir, dataDir).filter(({ v }) => v.note);
  if (!live.length) return [];
  const docs = live.map(({ v }) => new Set(questionTerms(v.note + ' ' + (v.at || ''))));
  const df = new Map();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const q = [...new Set(questionTerms(String(query || '')))];
  const idf = (w) => Math.log((docs.length + 1) / ((df.get(w) || 0) + 0.5));
  const total = q.reduce((s, w) => s + idf(w), 0) || 1;
  return live.map(({ v }, i) => ({ v, s: q.reduce((s, w) => s + (docs[i].has(w) ? idf(w) : 0), 0) / total }))
    .filter((x) => x.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.v);
}

/* ------------------------------------------------------------ seeding */

/* The files a repository keeps for agents and readers, read first by an
 * agent arriving at it. */
export const AGENT_FILES = [/^CLAUDE\.md$/i, /^AGENTS\.md$/i, /^README\.md$/i, /^\.claude\/.+\.md$/i, /^\.agents?\/.+\.md$/i, /^\.github\/copilot-instructions\.md$/i];
export function agentFiles(repoDir) {
  let tracked = [];
  try { tracked = git(repoDir, ['ls-files']).split('\n').filter(Boolean); } catch (_) { return []; }
  const extra = [];
  for (const d of ['.claude', '.agent', '.agents']) {
    const walk = (dir) => { let es = []; try { es = fs.readdirSync(path.join(repoDir, dir), { withFileTypes: true }); } catch (_) { return; } for (const e of es) { const rel = dir + '/' + e.name; if (e.isDirectory()) walk(rel); else extra.push(rel); } };
    walk(d);
  }
  return [...new Set([...tracked, ...extra])].filter((f) => AGENT_FILES.some((re) => re.test(f)));
}

/* Statements in those files that name code become FROM marks on it: a
 * paragraph or list item, its section heading, and every name in backticks
 * or written as a call that is one region's name (or one region's in a file
 * the statement also names). Statements naming no code are counted and left
 * to the agent. Idempotent: the same statement on the same code is one mark. */
export function seedFromAgentFiles(repoDir, dataDir, { by = null } = {}) {
  const cx = buildCodeIndex(repoDir);
  const code = cx.regions.filter((r) => r.kind !== 'doc');
  const byName = new Map();
  for (const r of code) { const n = shortName(r); if (!byName.has(n)) byName.set(n, []); byName.get(n).push(r); }
  const out = { files: [], made: 0, already: 0, statements: 0, no_code: 0, ambiguous: 0 };
  for (const file of agentFiles(repoDir)) {
    let text; try { text = fs.readFileSync(path.join(repoDir, file), 'utf8'); } catch (_) { continue; }
    out.files.push(file);
    let section = '';
    const blocks = [];
    let cur = [];
    const flush = () => { if (cur.length) blocks.push({ section, text: cur.join('\n') }); cur = []; };
    let fence = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) { fence = !fence; flush(); continue; }
      if (fence) continue;
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) { flush(); section = h[1].replace(/[`*]/g, '').trim(); continue; }
      if (!line.trim() || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^\s*\*\*\d+\./.test(line)) flush();
      if (line.trim()) cur.push(line);
    }
    flush();
    for (const b of blocks) {
      const said = norm(b.text);
      if (said.length < 40) continue;
      out.statements++;
      const files = new Set([...b.text.matchAll(/[\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html|go|rs)\b/g)].map((m) => m[0].split('/').pop()));
      const names = new Set();
      for (const m of b.text.matchAll(/`([^`\n]{2,80})`/g)) {
        const t = m[1].trim();
        const call = t.match(/^([A-Za-z_$][\w$]*)\s*\(/);
        if (call) names.add(call[1]); else if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        const qual = t.match(/::([A-Za-z_$][\w$]*)$/); if (qual) names.add(qual[1]);
      }
      for (const m of b.text.matchAll(/\b([A-Za-z_$][\w$]{3,})\(\)/g)) names.add(m[1]);
      let hit = 0;
      for (const n of names) {
        let rs = byName.get(n) || [];
        if (rs.length > 1 && files.size) rs = rs.filter((r) => files.has(r.file.split('/').pop()));
        if (!rs.length) continue;
        if (rs.length > 3) { out.ambiguous++; continue; }
        for (const r of rs) {
          hit++;
          const note = b.text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
          const res = createMark(repoDir, dataDir, { r, note, standing: 'from', by, source: { file, section: b.section, said: said.slice(0, 160) } });
          if (res.existed) out.already++; else out.made++;
        }
      }
      if (!hit) out.no_code++;
    }
  }
  return out;
}

/* ------------------------------------------------------------ in answers */

/* The marks beside a search answer: those on the code it landed on - its
 * trees and its map - then those whose notes hold the question's words. */
export function marksForAnswer(repoDir, dataDir, answer, query) {
  if (!loadMarks(repoDir, dataDir).length) return [];
  const cx = buildCodeIndex(repoDir);
  const code = cx.regions.filter((r) => r.kind !== 'doc');
  const keys = new Set();
  for (const t of (answer && answer.trees) || []) {
    const m = String(t.ref || '').match(/^(.*):(\d+)$/);
    const r = m && code.find((x) => x.file === m[1] && x.from <= Number(m[2]) && Number(m[2]) <= x.to);
    if (r) keys.add(regionKey(r));
  }
  const map = (answer && answer.map) || {};
  for (const e of [...(map.core || []), ...(map.wiring || []), ...(map.surface || [])]) {
    const m = String(e).match(/^(\S+) · .* (\d+)-(\d+)/);
    const r = m && code.find((x) => x.file.split('/').pop() === m[1] && x.from === Number(m[2]));
    if (r) keys.add(regionKey(r));
  }
  const out = [], seen = new Set();
  for (const v of [...marksOn(repoDir, dataDir, { regions: [...keys] }), ...marksFor(repoDir, dataDir, query)]) {
    if (seen.has(v.id) || out.length >= SHOWN) continue;
    seen.add(v.id); out.push(publicView(v));
  }
  return out;
}

/* When the agent's own tools are the faster way (the owner's transport
 * analogy, 17 October): GitX found no code, or the question asks where a
 * name is that the code has. */
const CODE_LIKE = /\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]+|[\w-]+\.(?:m?js|ts|py|css|html))\b/g;
export function walkHint(repoDir, query, lenses, answer) {
  if (answer && answer.no_code) return 'GitX found no code about this: search the code yourself (Grep) for the names you expect - and gitx_mark what you find, so the next agent finds it here.';
  const ls = [].concat(lenses || []);
  const where = (ls.includes('where') && !ls.some((l) => ['why', 'what', 'when'].includes(l))) || /^\s*where\b/i.test(String(query || ''));
  if (!where) return undefined;
  const cx = buildCodeIndex(repoDir);
  const names = new Set(cx.regions.filter((r) => r.kind !== 'doc').map((r) => shortName(r)));
  const files = new Set(cx.regions.map((r) => r.file.split('/').pop()));
  const hit = [...new Set(String(query || '').match(CODE_LIKE) || [])].filter((t) => names.has(t) || files.has(t));
  return hit.length ? 'a name lookup: grep for ' + hit.slice(0, 3).join(', ') + ' - faster than GitX for where a name is' : undefined;
}

/* What GitX holds about a repository, and which of the three states it is
 * in (docs/agent-marks-plan.md). */
export function recordOf(repoDir, dataDir) {
  let commits = 0, reasoned = 0;
  try { commits = Number(git(repoDir, ['rev-list', '--count', 'HEAD']).trim()) || 0; } catch (_) {}
  try { reasoned = (git(repoDir, ['log', '--format=%B']).match(/^GitX-Thoughts:/gm) || []).length; } catch (_) {}
  const count = (d) => { try { return fs.readdirSync(path.join(repoDir, '.gitx', d)).filter((f) => f.endsWith('.json')).length; } catch (_) { return 0; } };
  const settled = count('thoughts'), waiting = count(path.join('context', 'thoughts')), topics = count(path.join('context', 'topics'));
  const live = liveMarks(repoDir, dataDir);
  const by = (s) => live.filter(({ m }) => m.standing === s).length;
  const state = topics && reasoned >= commits * 0.2 ? 'recorded the GitX way' : settled + waiting ? 'recorded but not linked' : 'bare - no GitX record yet';
  return {
    state,
    record: { commits, commits_naming_thoughts: reasoned, thoughts_settled: settled, thoughts_waiting: waiting, topics },
    marks: { live: live.length, from_agent_files: by('from'), inferred: by('inferred'), cited: by('cited') }
  };
}

export const INVESTIGATE_HOW = [
  'Use GitX for why something is so, what was decided or rejected, what a part is and how it changed: gitx_search { "query": "<the subject>", "lens": ["what","why"] }. Use your own tools (Grep, Read) for where a named function or file is, or a list of names - a name in the code is one Grep away.',
  'Marks are what earlier agents and this repository\'s own agent files say about specific code; they come back with gitx_search and gitx_find_related on the code they sit on. They are inferred, not decided: check one before relying on it, then confirm or contradict it with gitx_mark.',
  'When you work out something the code does not say plainly - it took reading several places - leave it on that code: gitx_mark { "to": "file:line", "note": "..." }, and link code that belongs together across files. Statements in the agent files that name no code are yours to record as thoughts if they matter (gitx_thought_record, kind learned).'
];

/* ------------------------------------------------------------ automatic */

/* A final answer's citations (hook.js, at Stop) that the agent's latest
 * GitX search had not shown become CITED marks: "this code answered: <the
 * question>". No tokens from the agent - agents did not mark when asked to
 * (0 of 30, t-5dd03954f9). Only after a question asked within the hour: a
 * citation with no search before it says nothing about what GitX missed. */
export async function marksFromCitations(repoDir, dataDir, refs, { by = null, within = 60 * 60000 } = {}) {
  const { readPaths } = await import('./path-recorder.js');
  const { codeKey } = await import('./walk-learn.js');
  const now = Date.now();
  const w = readPaths(repoDir, dataDir, 50)
    .filter((x) => !x.started_by && x.question && x.question.query && now - Date.parse(x.at) < within)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (!w) return { made: 0, why: 'no gitx_search in the last hour' };
  const shown = new Set(((w.stack && w.stack.nodes) || []).filter((n) => String(n.id).startsWith('code:')).map((n) => codeKey(n.id, n.text)));
  const code = buildCodeIndex(repoDir).regions.filter((r) => r.kind !== 'doc');
  const inFile = (r, f) => r.file === f || r.file.endsWith('/' + f) || f.endsWith('/' + r.file);
  let made = 0;
  for (const ref of refs || []) {
    if (!ref.file) continue;
    const r = ref.name ? code.find((x) => inFile(x, ref.file) && (shortName(x) === ref.name || shortName(x).endsWith('.' + ref.name)))
      : code.find((x) => inFile(x, ref.file) && x.from <= ref.line && ref.line <= x.to);
    if (!r || shown.has(regionKey(r))) continue;
    const res = createMark(repoDir, dataDir, { r, standing: 'cited', by, question: w.question.query, evidence: { read: 'cited in the final answer' } });
    if (!res.existed) made++;
  }
  return { made, question: w.question.query };
}
