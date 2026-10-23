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
import { buildCodeIndex, shortName, questionTerms, splitFile } from './code-find.js';
import { repoKey } from './path-recorder.js';
import { NO_CONSOLE } from './no-console.js';

const DECAY = 0.98;
const DAY = 86400000;
export const SHOW_A = 0.9, SHOW_MEAN = 0.6;   // the learned-use bar (code-find.js)
const ALIVE_SHARE = 0.5;     // a mark lives while this share of its anchored lines survives
const STALE_KEPT = 0.9;      // below this share kept, its code has changed since it was written
export const NOTE_MAX = 400;
/* A feature's note says what a whole feature does, and at 400 characters 14
 * of a setup agent's 18 were cut mid-sentence (setup bench, 18 October). */
export const FEATURE_NOTE_MAX = 3000;   // written the way the agent wants (owner, 18 October): room, not a brief
export const SHOWN = 6;      // marks beside one answer
const PER_SOURCE = 2;        // of them from any one file or kind, while others wait
const POOL = 24;             // candidates found by words, before ranking picks SHOWN

const git = (cwd, args) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const norm = (t) => String(t || '').replace(/[`*_>#|]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
export const cleanNote = (t, max = NOTE_MAX) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; };

export function marksHome(repoDir, dataDir) {
  return dataDir ? path.join(dataDir, 'marks', repoKey(repoDir)) : path.join(repoDir, '.gitx', 'marks');
}

/* ------------------------------------------------------------ the store */

/* GITX_MARKS=0: no marks at all - none stored, seeded, recorded or shown -
 * so GitX search can be measured without them. */
export const MARKS_OFF = process.env.GITX_MARKS === '0';

const storeCache = new Map();     // home -> { sig, marks }
function sigOf(dir) {
  let n = 0, newest = 0;
  try { for (const f of fs.readdirSync(dir)) { n++; const m = fs.statSync(path.join(dir, f)).mtimeMs; if (m > newest) newest = m; } } catch (_) { return 'none'; }
  return n + ':' + newest;
}
export function loadMarks(repoDir, dataDir) {
  if (MARKS_OFF) return [];
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
  if (MARKS_OFF) return mark;
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
/* HEAD, asked of git at most every few seconds: a reader goes over every
 * mark, and asking per mark cost 530 git calls - 16 s - on file-fabric. */
const heads = new Map();
/* Read from .git itself when it is the plain layout - a file read, and never
 * stale: the few seconds of caching alone missed a commit made just before
 * the next read. A worktree or a packed ref falls back to asking git. */
function headFromDisk(repoDir) {
  try {
    const dir = path.join(repoDir, '.git');
    if (!fs.statSync(dir).isDirectory()) return null;
    const h = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(h)) return h;
    const ref = h.match(/^ref: (\S+)$/);
    if (!ref) return null;
    const v = fs.readFileSync(path.join(dir, ref[1]), 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(v) ? v : null;
  } catch (_) { return null; }
}
function headOf(repoDir) {
  const disk = headFromDisk(repoDir);
  if (disk) return disk;
  const hit = heads.get(repoDir);
  if (hit && Date.now() - hit.at < 3000) return hit.head;
  let head = null;
  try { head = git(repoDir, ['rev-parse', 'HEAD']).trim(); } catch (_) {}
  heads.set(repoDir, { head, at: Date.now() });
  return head;
}
/* The working tree, not HEAD: line numbers come from the code index, which
 * reads the files as they are, and blaming HEAD gave a mark made on
 * uncommitted edits the identities of whatever lines HEAD had at those
 * numbers - an agent's note on the function it had just rewritten read as
 * stale the moment its change was committed (code bench, 18 October). Lines
 * not committed yet have no identity. Cached per HEAD and file state. */
function blameOf(repoDir, file) {
  const head = headOf(repoDir);
  let st = ''; try { const s = fs.statSync(path.join(repoDir, file)); st = s.size + ':' + s.mtimeMs; } catch (_) {}
  const k = repoDir + '|' + head + '|' + file + '|' + st;
  if (blameCache.has(k)) return blameCache.get(k);
  const byLine = [];                 // current line (1-based) -> 'commit7:orig'
  try {
    const out = git(repoDir, ['blame', '--porcelain', '--', file]);
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

/* The code as it is now. GitX's code index is the code at HEAD - search
 * answers in HEAD's lines - but marks are made while an agent codes, on
 * edits not committed yet: a function it just wrote was not in the index,
 * and one it rewrote kept its old lines, so its note landed on the function
 * next door (code bench, 18 October). Files with uncommitted changes, and
 * untracked ones, are split again as they are on disk. */
const dirtyCache = new Map();        // repo|file -> { st, regions }
export function codeNow(repoDir) {
  const base = buildCodeIndex(repoDir).regions;
  let dirty = [];
  try {
    const changed = git(repoDir, ['diff', '--name-only', 'HEAD']).split('\n');
    const added = git(repoDir, ['ls-files', '--others', '--exclude-standard']).split('\n');
    dirty = [...new Set([...changed, ...added].map((f) => f.trim()).filter((f) => f && /\.(?:m?js|cjs|ts|tsx|py|css|html?|go|rs)$/i.test(f)))];
  } catch (_) { return { regions: base }; }
  if (!dirty.length) return { regions: base };
  const now = [];
  for (const f of dirty) {
    const k = repoDir + '|' + f;
    let st; try { const s = fs.statSync(path.join(repoDir, f)); st = s.size + ':' + s.mtimeMs; } catch (_) { continue; }
    let hit = dirtyCache.get(k);
    if (!hit || hit.st !== st) {
      let lines; try { lines = fs.readFileSync(path.join(repoDir, f), 'utf8').replace(/\r\n/g, '\n').split('\n'); } catch (_) { continue; }
      hit = { st, regions: splitFile(f, lines) };
      dirtyCache.set(k, hit);
    }
    now.push(...hit.regions);
  }
  const gone = new Set(dirty);
  return { regions: [...base.filter((r) => !gone.has(r.file)), ...now] };
}

const regionKey = (r) => r.file + '::' + shortName(r);
const entryOf = (r) => r.file + ' · ' + shortName(r) + ' ' + r.from + '-' + r.to;

/* The anchor for a region now: its lines' identities. */
export function anchorOf(repoDir, r) {
  const b = blameOf(repoDir, r.file);
  const ids = [];
  for (let i = r.from; i <= r.to; i++) if (b.byLine[i]) ids.push(b.byLine[i]);
  return { file: r.file, region: regionKey(r), from: r.from, to: r.to, lines: ids, ...(r.range ? { range: true } : {}) };
}

/* The places a mark sits on. A feature lives in several functions, often in
 * several files - the heading sizes file-fabric writes three times over, the
 * wallpaper stamped in index.html and app.js and read in app.css - and one
 * note says what holds them together, so a mark has anchors, not an anchor
 * (gitx.mark/1). Marks written before have the one. */
export const anchorsOf = (mark) => mark.anchors || (mark.anchor ? [mark.anchor] : []);

/* Where one anchor is now, or that it is retired: the region holding most
 * of its surviving lines, while at least half of them survive. Lines not
 * committed when it was made are found again by its region's name. */
export function placeOf(repoDir, a, cx = codeNow(repoDir)) {
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
  if (!r) return { alive: false, why: 'its lines are no longer in a function' };
  /* A range mark is its lines, wherever they are now: named by the function
   * holding its first line, found from every function it touches. */
  if (a.range) {
    const span = { from: Math.min(...now), to: Math.max(...now) };
    const head = code.find((x) => x.from <= span.from && span.from <= x.to) || r[0];
    return { r: head, alive: true, kept: now.length / a.lines.length, span, touches: [...votes.keys()] };
  }
  return { r: r[0], alive: true, kept: now.length / a.lines.length };
}

/* A FROM mark lives while its file still says it. */
/* A FROM mark lives while its file still says it - each file read and
 * normalised once while it is unchanged, not once per mark. */
const said = new Map();
function statementAlive(repoDir, mark) {
  const s = mark.source || {};
  const file = path.join(repoDir, s.file);
  let st; try { st = fs.statSync(file); } catch (_) { return false; }
  let hit = said.get(file);
  if (!hit || hit.m !== st.mtimeMs) { try { hit = { m: st.mtimeMs, text: norm(fs.readFileSync(file, 'utf8')) }; } catch (_) { return false; } said.set(file, hit); }
  return hit.text.includes(s.said);
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
  if (mark.feature) {
    const e = mark.evidence || {};
    return 'INFERRED - feature ' + mark.feature + ', marked by an agent' + (e.unread ? ' without reading the code' : e.unread_parts && e.unread_parts.length ? ' (did not open: ' + e.unread_parts.join(', ') + ')' : '') + tail;
  }
  return 'INFERRED by an agent' + (mark.evidence && mark.evidence.read ? ' from ' + mark.evidence.read : '') + tail;
}

/* What every reader shows of a mark. A mark on several places lives while
 * any of them does, and says which have changed since it was written: "these
 * are the same" goes wrong exactly when one of them changes. */
export function viewOf(repoDir, mark, cx) {
  const anchors = anchorsOf(mark);
  const said = mark.standing !== 'from' || !mark.source || statementAlive(repoDir, mark);
  const lives = anchors.map((a) => !said ? { alive: false, why: 'the statement left ' + mark.source.file } : (a.file && placeOf(repoDir, a, cx)) || { alive: true });
  const alive = anchors.length ? lives.some((l) => l.alive) : said;
  const life = alive ? { alive: true } : { alive: false, why: !said ? 'the statement left ' + mark.source.file : lives.length === 1 ? lives[0].why : 'all ' + lives.length + ' of its places rewritten' };
  const placed = (l, a) => !l.r ? a.ref || a.region : l.span ? l.r.file + ' · ' + shortName(l.r) + ' lines ' + l.span.from + '-' + l.span.to : a.range && !a.lines.length ? l.r.file + ' · ' + shortName(l.r) + ' lines ' + a.from + '-' + a.to : entryOf(l.r);
  const now = anchors.map((a, i) => lives[i].alive ? { at: placed(lives[i], a), region: lives[i].r ? regionKey(lives[i].r) : a.region || a.ref, file: lives[i].r ? lives[i].r.file : a.file } : null);
  const changed = alive ? anchors.filter((_, i) => !lives[i].alive).map((a) => a.region || a.ref) : [];
  const trust = trustOf(mark);
  const at = now.filter(Boolean).map((x) => x.at);
  /* Some of its lines rewritten since it was written, not enough to retire
   * it: it may describe code that is no longer so. file-fabric's journal said
   * the totem indicators were switched off after an agent had turned them
   * back on, and it filled every slot ahead of that agent's note (code bench,
   * 18 October). */
  const stale = alive && lives.some((l) => l.alive && l.kept !== undefined && l.kept < STALE_KEPT);
  return {
    id: mark.id,
    feature: mark.feature || undefined,
    at: at.length === 1 ? at[0] : at.length ? at : anchors.map((a) => a.region || a.ref)[0] || null,
    note: mark.note || undefined,
    status: statusOf(mark, life, trust) + (changed.length ? ' - ' + changed.length + ' of its ' + anchors.length + ' places changed since (' + changed.join(', ') + '): check the rest still hold' : '') + (stale ? ' - its code has changed since this was written: check it' : ''),
    _stale: stale,
    links: mark.links && mark.links.length ? mark.links.map((l) => l.as + ' ' + l.to) : undefined,
    _alive: alive, _shown: trust.shown,
    _regions: [...new Set([...now.filter(Boolean).map((x) => x.region), ...lives.flatMap((l) => (l.alive && l.touches ? l.touches.map(regionKey) : []))])], _files: now.filter(Boolean).map((x) => x.file).filter(Boolean),
    _was: anchors.map((a) => a.region || a.ref),
    _source: mark.source ? mark.source.file : mark.standing + (mark.by ? ' ' + mark.by : '')
  };
}
export const publicView = (v) => ({ id: v.id, feature: v.feature, at: v.at, note: v.note, status: v.status, links: v.links, stacked: v.stacked });

/* ------------------------------------------------------------ writing */

/* A mark on code (regions from the code index), or on thoughts or commits
 * (refs) - one note on every place it is about - unless an identical one is
 * there already. A statement in an agent file is one mark, whatever it names. */
export function createMark(repoDir, dataDir, { r = null, ref = null, rs = null, refs = null, note = '', standing = 'inferred', by = null, question = null, evidence = null, source = null, links = [], known = null, feature = null }) {
  const anchors = [...(rs || (r ? [r] : [])).map((x) => anchorOf(repoDir, x)), ...(refs || (ref ? [ref] : [])).map((x) => ({ ref: x }))];
  const where = anchors.map((a) => a.region || a.ref).sort().join('+');
  const id = standing === 'from' && source ? idOf(repoKey(repoDir), 'from', source.file + '#' + source.said)
    : idOf(repoKey(repoDir), where, norm(note), '', standing === 'cited' ? String(question || '') : '');
  /* known: the ids already written, when a caller writes many at once -
   * reloading every mark per write made seeding quadratic. */
  const have = known ? (known.has(id) ? { id } : null) : loadMarks(repoDir, dataDir).find((m) => m.id === id);
  if (have) return { mark: have, existed: true };
  const mark = {
    schema: 'gitx.mark/1', id, created: new Date().toISOString(), standing, by, question: question || undefined,
    anchors, note: cleanNote(note, feature ? FEATURE_NOTE_MAX : NOTE_MAX) || undefined, evidence: evidence || undefined, source: source || undefined,
    links: links.length ? links : undefined, feature: featureKey(feature) || undefined, confirmed: [], contradicted: []
  };
  saveMark(repoDir, dataDir, mark);
  if (known) known.add(id);
  return { mark, existed: false };
}

/* ------------------------------------------------------------ features */

/* Setup mode (owner, 18 October): an agent assigned to a repository that is
 * not GitX-ready goes through it feature by feature, marks each feature's
 * code range and notes what it does. A mark names its feature, and the
 * parts of one feature are linked: each new part follows the last mark of
 * its feature, so reading any part brings the whole feature back (stacks,
 * "linked"). */
export const featureKey = (f) => String(f || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export function featureMarks(repoDir, dataDir, feature) {
  const k = featureKey(feature);
  if (!k) return [];
  return liveMarks(repoDir, dataDir).filter(({ m }) => m.feature === k)
    .sort((a, b) => String(b.m.created).localeCompare(String(a.m.created))).map(({ v }) => v);
}
/* Every feature marked so far, so a setup agent keeps to its names. */
export function featuresSoFar(repoDir, dataDir) {
  const by = new Map();
  for (const { m, v } of liveMarks(repoDir, dataDir)) if (m.feature) { const f = by.get(m.feature) || { marks: 0, files: new Set() }; f.marks++; for (const x of v._files) f.files.add(x); by.set(m.feature, f); }
  return [...by].sort((a, b) => b[1].marks - a[1].marks).map(([f, x]) => f + ' (' + x.marks + ' marks: ' + [...x.files].join(', ') + ')');
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

/* More places for a mark already written: an agent that found the same
 * thing in other code joins the mark rather than writing a second. */
export function joinMark(repoDir, dataDir, id, regions) {
  const mark = loadMarks(repoDir, dataDir).find((m) => m.id === id);
  if (!mark) return { error: 'no mark ' + id };
  const anchors = anchorsOf(mark);
  const have = new Set(anchors.map((a) => a.region || a.ref));
  const added = regions.filter((r) => !have.has(regionKey(r))).map((r) => anchorOf(repoDir, r));
  if (!added.length) return { mark, added: 0 };
  mark.anchors = [...anchors, ...added];
  delete mark.anchor;
  mark.schema = 'gitx.mark/1';
  saveMark(repoDir, dataDir, mark);
  return { mark, added: added.length };
}

/* ------------------------------------------------------------ finding */

/* Every mark as readers see it now, live ones only unless asked. */
export function liveMarks(repoDir, dataDir, { all = false } = {}) {
  const cx = codeNow(repoDir);
  return loadMarks(repoDir, dataDir).map((m) => ({ m, v: viewOf(repoDir, m, cx) })).filter((x) => all || (x.v._alive && x.v._shown));
}

/* ------------------------------------------------------------ stacks */

/* Marks about one thing, shown as one, when the agents that wrote them did
 * not join them: written from the same statement, cited by one answer,
 * linked by an agent, or the same note on other code. Worked out on
 * reading and never written, so a wrong stack costs nothing to undo - only
 * an agent's join changes a mark. Words two DIFFERENT notes share are not a
 * reason: on file-fabric that is what put service-worker notes on the
 * render loop. */
/* Stacking on its own takes nearly the same note (jaccard); offering an
 * agent a mark to join takes a note that holds most of the shorter one
 * (overlap) - a second agent says less than the first, and the agent judges. */
const SAME_NOTE = 0.8, LIKE_NOTE = 0.6, NOTE_TERMS = 5;
const termsOf = (t) => new Set(questionTerms(String(t || '')));
const shared = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };
const jaccard = (a, b) => { const n = shared(a, b); return n / (a.size + b.size - n || 1); };
const overlap = (a, b) => shared(a, b) / (Math.min(a.size, b.size) || 1);

export function stacksOf(items) {
  const up = items.map((_, i) => i);
  const find = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  const because = new Map();
  const join = (i, j, why) => { const a = find(i), b = find(j); if (a !== b) up[b] = a; for (const k of [i, j]) { if (!because.has(k)) because.set(k, new Set()); because.get(k).add(why); } };
  const first = new Map();
  const key = (k, i, why) => { if (first.has(k)) join(first.get(k), i, why); else first.set(k, i); };
  const index = new Map(items.map(({ m }, i) => [m.id, i]));
  items.forEach(({ m }, i) => {
    if (m.source && m.source.said) key('s\u0000' + m.source.file + '\u0000' + m.source.said, i, 'same statement');
    if (m.standing === 'cited' && m.question) key('q\u0000' + m.question + '\u0000' + (m.by || ''), i, 'cited by one answer');
    for (const l of m.links || []) if (index.has(l.to)) join(i, index.get(l.to), 'linked');
  });
  const terms = items.map(({ m }) => (m.note ? termsOf(m.note) : null));
  for (let i = 0; i < items.length; i++) {
    if (!terms[i] || terms[i].size < NOTE_TERMS) continue;
    for (let j = i + 1; j < items.length; j++) if (terms[j] && terms[j].size >= NOTE_TERMS && jaccard(terms[i], terms[j]) >= SAME_NOTE) join(i, j, 'same note');
  }
  const groups = new Map();
  items.forEach((x, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, { members: [], because: new Set() }); const g = groups.get(r); g.members.push(x); for (const w of because.get(i) || []) g.because.add(w); });
  return [...groups.values()];
}

/* One stack as one mark: the note that says the most, every place any of
 * them is on, and which places have changed since. */
function stackView({ members, because }) {
  const live = members.filter(({ v }) => v._alive);
  if (!live.length) return null;
  const weight = ({ m }) => (m.note ? 4 : 0) + (m.standing === 'cited' ? 0 : 2) + Math.min(trustOf(m).a, 5) / 5;
  const lead = [...live].sort((x, y) => weight(y) - weight(x))[0];
  if (members.length === 1) return lead.v;
  const at = [...new Set(live.flatMap(({ v }) => [].concat(v.at || [])))];
  const here = new Set(live.flatMap(({ v }) => v._regions));
  const gone = [...new Set(members.filter(({ v }) => !v._alive).flatMap(({ v }) => v._was))].filter((r) => !here.has(r));
  const leadNote = norm(lead.v.note);
  return {
    ...lead.v,
    at: at.length === 1 ? at[0] : at,
    status: lead.v.status + (gone.length ? ' - ' + gone.length + ' of its places changed since (' + gone.join(', ') + '): check the rest still hold' : ''),
    stacked: {
      because: [...because],
      with: members.filter((x) => x !== lead).map(({ m, v }) => ({ id: m.id, note: m.note && norm(m.note) !== leadNote ? String(v.note).slice(0, 160) : undefined }))
    },
    _regions: [...here], _files: [...new Set(live.flatMap(({ v }) => v._files))]
  };
}

/* Every mark readers are shown, stacked - asked of every search, so kept
 * for a few seconds while the store and HEAD are unchanged. */
const stackCache = new Map();
export function liveStacks(repoDir, dataDir) {
  const home = marksHome(repoDir, dataDir);
  const k = sigOf(home) + '|' + headOf(repoDir);
  const hit = stackCache.get(home);
  if (hit && hit.k === k && Date.now() - hit.at < 3000) return hit.stacks;
  const shown = liveMarks(repoDir, dataDir, { all: true }).filter(({ v }) => v._shown);
  const stacks = stacksOf(shown).map(stackView).filter(Boolean);
  stackCache.set(home, { k, at: Date.now(), stacks });
  return stacks;
}

/* The marks on some code: region keys (file::name) or whole files. */
export function marksOn(repoDir, dataDir, { regions = [], files = [] } = {}) {
  const R = new Set(regions), F = new Set(files);
  return liveStacks(repoDir, dataDir).filter((v) => v._regions.some((r) => R.has(r)) || v._files.some((f) => F.has(f)));
}

/* What an agent about to mark sees first: the marks on the code it names,
 * and marks elsewhere whose note says much the same - so it confirms or
 * joins one rather than writing a second. */
export function relatedMarks(repoDir, dataDir, { regions = [], note = '' } = {}) {
  const on = marksOn(repoDir, dataDir, { regions });
  const t = termsOf(note);
  if (t.size < NOTE_TERMS) return { on, like: [] };
  const ids = new Set(on.map((v) => v.id));
  const like = liveStacks(repoDir, dataDir).filter((v) => !ids.has(v.id) && v.note && overlap(t, termsOf(v.note)) >= LIKE_NOTE)
    .map((v) => ({ v, s: overlap(t, termsOf(v.note)) })).sort((x, y) => y.s - x.s).slice(0, 3).map((x) => x.v);
  return { on, like };
}

/* The marks whose notes hold a question's words, by idf over the notes. */
/* How well a mark answers a question: single words only, by idf over every
 * note, and a feature's name counts. Word pairs counted against a long note
 * even when they matched nothing - "totems and off-screen totem indicators"
 * scored the setup agent's whole totems note below the bar, and search
 * showed the pointer handlers' marks instead (setup bench v3, 18 October). */
const MATCH = 0.3, FEATURE_HIT = 0.5;
const singles = (t) => [...questionTerms(String(t || ''))].filter((w) => !w.includes('_'));
export function scorerFor(repoDir, dataDir, query) {
  const live = liveStacks(repoDir, dataDir).filter((v) => v.note);
  const docOf = (v) => new Set(singles(v.note + ' ' + [].concat(v.at || []).join(' ') + ' ' + String(v.feature || '').replace(/-/g, ' ')));
  const docs = new Map(live.map((v) => [v.id, docOf(v)]));
  const df = new Map();
  for (const d of docs.values()) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const q = [...new Set(singles(query))];
  const idf = (w) => Math.log((docs.size + 1) / ((df.get(w) || 0) + 0.5));
  const total = q.reduce((s, w) => s + idf(w), 0) || 1;
  const score = (v) => {
    const d = docs.get(v.id) || docOf(v);
    const words = q.reduce((s, w) => s + (d.has(w) ? idf(w) : 0), 0) / total;
    const name = new Set(singles(String(v.feature || '').replace(/-/g, ' ')));
    return words + (q.some((w) => name.has(w)) ? FEATURE_HIT : 0);
  };
  return { live, score };
}
export function marksFor(repoDir, dataDir, query, { limit = SHOWN } = {}) {
  const { live, score } = scorerFor(repoDir, dataDir, query);
  return live.map((v) => ({ v, s: score(v) })).filter((x) => x.s >= MATCH).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.v);
}

/* ------------------------------------------------------------ seeding */

/* The files a repository keeps for agents and readers, read first by an
 * agent arriving at it. */
/* A statement naming more code than this is a list, not about any one. */
const LIST_MAX = 5;
export const AGENT_FILES = [/^CLAUDE\.md$/i, /^AGENTS\.md$/i, /^README\.md$/i, /^\.claude\/.+\.md$/i, /^\.agents?\/.+\.md$/i, /^\.github\/copilot-instructions\.md$/i];
export function agentFiles(repoDir) {
  let tracked = [];
  try { tracked = git(repoDir, ['ls-files']).split('\n').filter(Boolean); } catch (_) { return []; }
  const extra = [];
  for (const d of ['.claude', '.agent', '.agents']) {
    const walk = (dir) => { let es = []; try { es = fs.readdirSync(path.join(repoDir, dir), { withFileTypes: true }); } catch (_) { return; } for (const e of es) { const rel = dir + '/' + e.name; if (e.isDirectory()) walk(rel); else extra.push(rel); } };
    walk(d);
  }
  const all = [...new Set([...tracked, ...extra])];
  /* The named agent files first; then any other markdown the repository
   * tracks - a project keeps its notes for agents under its own names
   * (file-fabric: knowledge/about_code.md, a code map kept for agents). A
   * statement still becomes a mark only if it names code that exists, so
   * prose that names none is skipped wherever it lives. */
  const named = all.filter((f) => AGENT_FILES.some((re) => re.test(f)));
  const docs = all.filter((f) => /\.md$/i.test(f) && !named.includes(f) && !/(^|\/)(node_modules|vendor|dist|build|\.gitx)\//.test(f));
  return [...named, ...docs];
}

/* Statements in those files that name code become FROM marks on it: a
 * paragraph or list item, its section heading, and every name in backticks
 * or written as a call that is one region's name (or one region's in a file
 * the statement also names). Statements naming no code are counted and left
 * to the agent. Idempotent: the same statement on the same code is one mark. */
/* Markdown as statements: a paragraph, a list item or a table row, with the
 * heading it sits under. Agent files are read this way, and so is an
 * agent's own answer - an overview of a project is markdown too. */
export function statementsOf(text) {
  let section = '';
  const blocks = [];
  let cur = [];
  const flush = () => { if (cur.length) blocks.push({ section, text: cur.join('\n') }); cur = []; };
  let fence = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; flush(); continue; }
    if (fence) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); section = h[1].replace(/[`*]/g, '').trim(); continue; }
    /* A table row is a statement of its own: a code map's table names a
     * dozen functions, and as one block every one of them got the same
     * note - the table's header. */
    if (/^\s*\|/.test(line)) { flush(); if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) blocks.push({ section, text: line.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim() }); continue; }
    if (!line.trim() || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^\s*\*\*\d+\./.test(line)) flush();
    if (line.trim()) cur.push(line);
  }
  flush();
  return blocks;
}

const CODE_FILE = /[\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html|go|rs)\b/g;
/* Regions by name. The code index splits a long function into chunks
 * ("(cont.)" - drawDrawings is seven), and a name means the whole function:
 * read as seven regions it was ambiguous and never marked, and drawLinks'
 * three chunks became three places of one mark. */
export const byNameOf = (code) => {
  const m = new Map();
  for (const r of code) {
    const n = shortName(r);
    if (!m.has(n)) m.set(n, []);
    const list = m.get(n);
    const head = /\(cont\.\)/.test(String(r.name)) && list.find((h) => h.file === r.file && h.from <= r.from && h.to + 1 >= r.from);
    if (head) head.to = Math.max(head.to, r.to); else list.push({ ...r });
  }
  return m;
};
const inFile = (r, f) => r.file === f || r.file.endsWith('/' + f) || f.endsWith('/' + r.file);
const wholeOf = (byName, r) => (r && (byName.get(shortName(r)) || []).find((h) => h.file === r.file && h.from <= r.from && r.to <= h.to)) || r;

/* The code a statement names: names in backticks or written as calls, that
 * are one region's name (or one region's in a file the statement also
 * names), file::name and file:line. More than LIST_MAX is a list - a
 * changelog line, a file summary - and says nothing in particular about any
 * of them. */
export function codeNamed(text, code, byName) {
  const files = new Set([...text.matchAll(CODE_FILE)].map((m) => m[0].split('/').pop()));
  const names = new Set();
  /* Every backtick pair, however short: a two-character minimum let `#`
   * pair its closing backtick with the next opening one, and the names
   * after it were read as prose. */
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (t.length < 2 || t.length > 80) continue;
    const call = t.match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (call) names.add(call[1]); else if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
  }
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]{3,})\(\)/g)) names.add(m[1]);
  const targets = [];
  const add = (r) => { if (r && !targets.includes(r)) targets.push(r); };
  let ambiguous = 0;
  for (const m of text.matchAll(/([\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html|go|rs))::([A-Za-z_$][\w$.]*)/g)) {
    names.delete(m[2]);
    add(wholeOf(byName, code.find((x) => inFile(x, m[1]) && (shortName(x) === m[2] || shortName(x).endsWith('.' + m[2])))));
  }
  for (const m of text.matchAll(/([\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html|go|rs))[:#]L?(\d+)\b/g)) {
    const line = Number(m[2]);
    add(wholeOf(byName, code.find((x) => inFile(x, m[1]) && x.from <= line && line <= x.to)));
  }
  for (const n of names) {
    let rs = byName.get(n) || [];
    if (rs.length > 1 && files.size) rs = rs.filter((r) => files.has(r.file.split('/').pop()));
    if (!rs.length) continue;
    if (rs.length > 3) { ambiguous++; continue; }
    for (const r of rs) add(r);
  }
  return { targets, ambiguous, list: targets.length > LIST_MAX };
}

export function seedFromAgentFiles(repoDir, dataDir, { by = null } = {}) {
  const cx = codeNow(repoDir);
  const code = cx.regions.filter((r) => r.kind !== 'doc');
  const byName = byNameOf(code);
  const out = { files: [], made: 0, places: 0, already: 0, statements: 0, no_code: 0, ambiguous: 0, lists: 0 };
  const known = new Set(loadMarks(repoDir, dataDir).map((m) => m.id));
  for (const file of agentFiles(repoDir)) {
    let text; try { text = fs.readFileSync(path.join(repoDir, file), 'utf8'); } catch (_) { continue; }
    out.files.push(file);
    for (const b of statementsOf(text)) {
      const said = norm(b.text);
      if (said.length < 40) continue;
      out.statements++;
      const { targets, ambiguous, list } = codeNamed(b.text, code, byName);
      out.ambiguous += ambiguous;
      if (list) { out.lists++; continue; }
      if (!targets.length) { out.no_code++; continue; }
      /* One statement, one mark, on every piece of code it names. */
      const note = b.text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      const res = createMark(repoDir, dataDir, { rs: targets, note, standing: 'from', by, source: { file, section: b.section, said: said.slice(0, 160) }, known });
      if (res.existed) out.already++; else { out.made++; out.places += targets.length; }
    }
  }
  return out;
}

/* ------------------------------------------------------------ a scan */

/* An agent scanning a repository to understand it - "tell me about this
 * project" - starts with gitx_investigate. That call is stamped, and for the
 * hour after it the agent's final answer is read as its notes: every
 * statement naming code becomes a mark on that code, the statement (under
 * its heading) the note; the first paragraph naming none says what the
 * project is. Agents did not mark when asked (0 of 30, t-5dd03954f9), and an
 * overview already says, place by place, what each part does. Outside a
 * scan an answer is not read: "I fixed X in marks.js" says nothing about
 * what marks.js is. */
const SCAN = 60 * 60000;
const scanFile = (repoDir, dataDir) => path.join(marksHome(repoDir, dataDir), 'scan.json');
export function startScan(repoDir, dataDir, by = null) {
  if (MARKS_OFF) return;
  fs.mkdirSync(marksHome(repoDir, dataDir), { recursive: true });
  fs.writeFileSync(scanFile(repoDir, dataDir), JSON.stringify({ at: new Date().toISOString(), by }) + '\n');
}
function scanning(repoDir, dataDir, now = Date.now()) {
  try { const s = JSON.parse(fs.readFileSync(scanFile(repoDir, dataDir), 'utf8')); return now - Date.parse(s.at) < SCAN ? s : null; } catch (_) { return null; }
}

/* An agent's notes from a scan - its answer, or the batch it marked - as
 * marks: notes on the code they name, and what the project is. */
export function marksFromNotes(repoDir, dataDir, notes, { by = null, read = 'its overview answer', about = null, project = true } = {}) {
  const code = codeNow(repoDir).regions.filter((r) => r.kind !== 'doc');
  const byName = byNameOf(code);
  const known = new Set(loadMarks(repoDir, dataDir).map((m) => m.id));
  const out = { made: 0, places: 0, about: undefined, restated: 0 };
  for (const b of notes) {
    const note = ((b.section ? b.section + ': ' : '') + b.text.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (norm(b.text).length < 40) continue;
    const { targets, list } = codeNamed(b.text, code, byName);
    if (list) continue;
    if (!targets.length) {
      if (project && !about && b.text.length >= 80 && !/^(i|i've|i'll|i'm|we|let me)\b/i.test(b.text.trim())) about = note;
      continue;
    }
    if (!saysMore(b.text, targets)) { out.restated++; continue; }
    const res = createMark(repoDir, dataDir, { rs: targets, note, by, question: 'a scan of the project', evidence: { read }, known });
    if (!res.existed) { out.made++; out.places += targets.length; }
  }
  if (about) { const res = createMark(repoDir, dataDir, { refs: ['project'], note: about, by, evidence: { read }, known }); if (!res.existed) out.about = cleanNote(about); }
  return out;
}

/* At Stop (hook.js), an answer read as the agent's notes:
 *   - a scan's - the first answer after gitx_investigate, which spends the
 *     stamp - every statement naming code;
 *   - a change's - in a repository that is not GitX-ready, the statements
 *     naming code this session changed (edits: [{ file, from, to }] from the
 *     hook's own record). "Fixed the culling margin in drawLinks so links
 *     whose ends are off screen still draw" is the thought behind that code,
 *     and with no GitX record there is nowhere else for it to go (owner, 18
 *     October: a mark is for whatever will help the next agent). In a
 *     GitX-ready repository thoughts and commit trailers carry it. */
export function marksFromAnswer(repoDir, dataDir, text, { by = null, edits = [] } = {}) {
  const scan = scanning(repoDir, dataDir);
  if (scan) { try { fs.unlinkSync(scanFile(repoDir, dataDir)); } catch (_) { /* spent already */ } }
  if (!scan && !edits.length) return { made: 0, why: 'not a scan, and no code changed' };
  if (!scan && isReady(recordOf(repoDir, dataDir))) return { made: 0, why: 'GitX-ready: thoughts carry the reasoning' };
  const code = codeNow(repoDir).regions.filter((r) => r.kind !== 'doc');
  const byName = byNameOf(code);
  const changed = new Set();
  const whole = edits.length ? [...byName.values()].flat() : [];
  for (const e of edits) for (const r of whole) if (inFile(r, e.file) && r.from <= e.to && e.from <= r.to) changed.add(regionKey(r));
  /* Statements on code the session changed are the notes behind the change,
   * a scan or not; the rest of a scan's answer is its notes too. */
  const all = statementsOf(text);
  const onChange = all.filter((b) => changed.size && codeNamed(b.text, code, byName).targets.some((r) => changed.has(regionKey(r))));
  const a = marksFromNotes(repoDir, dataDir, onChange, { by, read: 'its change', project: false });
  if (!scan) return { ...a, changed: changed.size };
  /* A session that changed code opens with what it changed, not with what
   * the project is: no project note from it. */
  const b = marksFromNotes(repoDir, dataDir, all.filter((x) => !onChange.includes(x)), { by, project: !edits.length });
  return { made: a.made + b.made, places: a.places + b.places, about: b.about, restated: a.restated + b.restated, changed: changed.size };
}

/* Marks are how a repository that is not GitX-ready gets a record: agents
 * mark what they understood as they work. Reading has one way in -
 * gitx_search, whose answers carry the marks on the code they land on - so
 * gitx_investigate is for the marking: what earlier agents already marked,
 * and the biggest parts nobody has, so an agent fills gaps instead of
 * repeating them (owner, 18 October). A reading list handed out here was a
 * second way to read the same notes; the scan bench found agents read it
 * instead of searching, and 13 of 16 never searched. */
const NOT_YET = 6;
const isProjectMark = (m) => anchorsOf(m).some((a) => a.ref === 'project');
export function markedSoFar(repoDir, dataDir) {
  const byAgents = liveMarks(repoDir, dataDir).filter(({ m }) => m.standing !== 'from');
  if (!byAgents.length) return undefined;
  const onCode = byAgents.filter(({ v, m }) => v._files.length && m.note);
  const looked = new Set(onCode.flatMap(({ v }) => v._regions));
  const files = new Map();
  for (const { v } of onCode) for (const f of new Set(v._files)) files.set(f, (files.get(f) || 0) + 1);
  const code = codeNow(repoDir).regions.filter((r) => r.kind !== 'doc');
  const notYet = [...byNameOf(code).values()].flat().filter((r) => !looked.has(regionKey(r))).sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, NOT_YET);
  return {
    marks_by_agents: onCode.length,
    project_note: byAgents.some(({ m }) => isProjectMark(m)) || undefined,
    by_file: [...files].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => f + ' (' + n + ')'),
    not_marked_yet: notYet.map((r) => r.file + '::' + shortName(r) + ' (' + (r.to - r.from + 1) + ' lines)')
  };
}

/* A question about the project as a whole - "tell me about this project" -
 * is answered first by what earlier agents said the project is. */
const ABOUT_PROJECT = /\b(?:this|the) (?:project|repo|repository|codebase|app)\b|\bwhat is this\b|\boverview\b/i;
function projectNotes(repoDir, dataDir, query) {
  if (!ABOUT_PROJECT.test(String(query || '')) || (String(query).match(CODE_LIKE) || []).length) return [];
  return liveStacks(repoDir, dataDir).filter((v) => [].concat(v.at || []).includes('project') && v.note).slice(0, 2);
}

/* A note earns its place by saying what the names do not: "guardrails.js::
 * scanStaged scans staged changes" is the code read aloud. Words beyond the
 * names and files it is on, at least SAYS_MORE of them. */
const SAYS_MORE = 5;
const nameWords = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
export function saysMore(text, targets) {
  const own = targets.flatMap((r) => [...nameWords(shortName(r)), ...nameWords(r.file)]);
  const plain = String(text).replace(/`[^`]*`/g, ' ').replace(/[\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html|go|rs)(?:::[\w$.]+|[:#]L?\d+)?/g, ' ');
  const extra = [...questionTerms(plain)].filter((w) => !w.includes('_') && !own.some((o) => o.startsWith(w) || w.startsWith(o)));
  return new Set(extra).size >= SAYS_MORE;
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
  /* At most PER_SOURCE from any one source: file-fabric's journal alone has
   * five statements on drawLinks, and they filled every slot ahead of what
   * an agent's scan had understood about it. */
  /* Current knowledge first: what an agent's change says about the code,
   * then what agents understood of it, then the repository's own files -
   * and anything whose code has changed since it was written after all of
   * them. Order within each kind is as found: on the code, then by words. */
  const rankOf = (v) => (v._stale ? 3 : 0) + (/from its change/.test(v.status) ? 0 : /without reading the code/.test(v.status) ? 2.5 : /^INFERRED/.test(v.status) ? 1 : 2);
  /* A pool wider than what is shown: with only the best six by words, the
   * repository's own notes on the totem indicators filled the pool and the
   * setup agent's totems feature never reached the ranking that puts it
   * first. */
  const found = [...projectNotes(repoDir, dataDir, query), ...marksOn(repoDir, dataDir, { regions: [...keys] }), ...marksFor(repoDir, dataDir, query, { limit: POOL })];
  const project = new Set(projectNotes(repoDir, dataDir, query).map((v) => v.id));
  /* Within each kind, what answers the question first: a mark only on code
   * the search landed on - the big handlers that mention everything - after
   * a feature the question names. */
  const { score } = scorerFor(repoDir, dataDir, query);
  const ordered = found.map((v, i) => ({ v, i, k: project.has(v.id) ? -1 : rankOf(v), s: score(v) })).sort((a, b) => a.k - b.k || b.s - a.s || a.i - b.i).map((x) => x.v);
  const out = [], seen = new Set(), from = new Map(), later = [];
  for (const v of ordered) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const n = from.get(v._source) || 0;
    if (n >= PER_SOURCE) { later.push(v); continue; }
    from.set(v._source, n + 1);
    if (out.length < SHOWN) out.push(v);
  }
  for (const v of later) if (out.length < SHOWN) out.push(v);
  return out.map(publicView);
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
    marks: { live: live.length, from_agent_files: by('from'), inferred: by('inferred'), cited: by('cited'), shown_as: liveStacks(repoDir, dataDir).length }
  };
}

/* Setup mode's map: every code file, how much of it is marked, and the
 * biggest parts nobody has marked - so the setup agent covers the
 * repository, not the corner it started in. */
const UNMARKED = 25;
export function setupMap(repoDir, dataDir) {
  const code = codeNow(repoDir).regions.filter((r) => r.kind !== 'doc');
  const whole = [...byNameOf(code).values()].flat();
  const marked = new Set(liveMarks(repoDir, dataDir).filter(({ m }) => m.standing !== 'from').flatMap(({ v }) => v._regions));
  const files = new Map();
  for (const r of whole) {
    const f = files.get(r.file) || { lines: 0, regions: 0, marked: 0 };
    f.lines = Math.max(f.lines, r.to); f.regions++; if (marked.has(regionKey(r))) f.marked++;
    files.set(r.file, f);
  }
  const c = setupCoverage(repoDir, dataDir);
  return {
    coverage: c.marked + ' of the ' + c.of + ' biggest functions marked; setup is done at ' + Math.round(SETUP_TARGET * 100) + '%',
    files: [...files].sort((a, b) => b[1].lines - a[1].lines).map(([f, x]) => f + ': ' + x.lines + ' lines, ' + x.regions + ' functions, ' + x.marked + ' marked'),
    not_marked_yet: whole.filter((r) => !marked.has(regionKey(r))).sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, UNMARKED).map((r) => r.file + '::' + shortName(r) + ' ' + r.from + '-' + r.to),
    features_so_far: featuresSoFar(repoDir, dataDir)
  };
}
export const SETUP_HOW = [
  'You are setting this repository up for GitX: go through it feature by feature, and for each feature mark the code range it lives in with a note on what it does, so any agent after you understands the code from your marks.',
  'For each feature: read its code until you understand it, then mark it - gitx_mark { "marks": [ { "to": ["script.js:7090-7140", "style.css:1195-1260"], "feature": "totem-indicators", "note": "..." } ] }. to: the code range (file:from-to) or function (file::name) of each part; feature: a short name, the same for every part of one feature (features_so_far lists the names used).',
  'The note: what you understood about this feature, written the way you want - whatever the next agent needs to understand this code. The mark keeps its own place as the code moves.',
  'A mark counts once you have read the code it is on: coverage counts only functions you read at least half of, and a mark on code you have not opened is shown as marked without reading the code.',
  'A part of a feature already marked: give the same feature, and your mark follows the last mark of that feature (the reply says follows: m-...). To see a feature\'s marks first: gitx_mark { "feature": "totem-indicators" }.',
  'Cover the repository: files lists every code file and how much of it is marked; not_marked_yet the biggest unmarked parts. Use the repository\'s own notes (CLAUDE.md, README, docs) to find the features, but check them against the code - they can be out of date.'
];

/* Setup is done when the repository is covered, not when the agent says so:
 * the first setup agent stopped after 87 seconds of a 25-minute budget, with
 * 18 marks on 11.7k lines (setup bench, 18 October). Coverage is the share
 * of the repository's biggest functions some agent's mark is on; below the
 * target, the Stop hook sends the agent back with the next ones to mark, for
 * at most SETUP_ROUNDS rounds. */
export const SETUP_BIGGEST = 40, SETUP_TARGET = 0.6, SETUP_ROUNDS = 4, SETUP_FOR = 3 * 3600000;
const setupFile = (repoDir, dataDir) => path.join(marksHome(repoDir, dataDir), 'setup.json');
export function startSetup(repoDir, dataDir, by = null) {
  if (MARKS_OFF) return;
  const f = setupFile(repoDir, dataDir);
  try { const s = JSON.parse(fs.readFileSync(f, 'utf8')); if (Date.now() - Date.parse(s.at) < SETUP_FOR) return; } catch (_) { /* a new setup */ }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), by, rounds: 0 }) + '\n');
}
/* What has been read, from the hook's record (hook.js after every Read):
 * file -> [from, to] spans, since a time. A Read with no offset reads from
 * the top, as far as the Read tool goes (2000 lines). */
const READ_WHOLE = 2000;
export function readSpans(repoDir, dataDir, since = 0, until = Infinity) {
  const spans = new Map();
  let lines = [];
  try { lines = fs.readFileSync(path.join(dataDir, 'reads', repoKey(repoDir) + '.jsonl'), 'utf8').split('\n'); } catch (_) { return spans; }
  for (const l of lines) {
    let x; try { x = JSON.parse(l); } catch (_) { continue; }
    if (!x || !x.file || x.thought || Date.parse(x.at) < since || Date.parse(x.at) > until) continue;
    const from = x.from || 1, to = x.to || from + READ_WHOLE - 1;
    if (!spans.has(x.file)) spans.set(x.file, []);
    spans.get(x.file).push([from, to]);
  }
  return spans;
}
/* Read when at least half of its lines have been read. */
/* Which parts of a mark the agent had opened: none of them is a mark made
 * without reading; some of them names the parts it did not open. One
 * unopened helper among four used to label the whole mark unread - the
 * totems note, written from the two parts it had read (setup bench v3). */
export function partsOpened(spans, regions) {
  const open = regions.filter((r) => wasRead(spans, r, 1e-6));
  return { none: !open.length, missing: regions.filter((r) => !open.includes(r)).map((r) => shortName(r)) };
}
export function wasRead(spans, r, share = 0.5) {
  const s = spans.get(r.file) || [];
  let n = 0;
  for (let i = r.from; i <= r.to; i++) if (s.some(([a, b]) => a <= i && i <= b)) n++;
  return n >= (r.to - r.from + 1) * share;
}
/* Coverage counts what was understood, not what was named: the second setup
 * agent marked 37 of the 40 biggest functions after six reads, and 17 of its
 * 39 notes were partly guessed from names and the repository's notes (setup
 * bench, 18 October). A function counts once marked AND read since the
 * setup began. */
export function setupCoverage(repoDir, dataDir) {
  const code = codeNow(repoDir).regions.filter((r) => r.kind === 'code');
  const biggest = [...byNameOf(code).values()].flat().sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, SETUP_BIGGEST);
  const marked = new Set(liveMarks(repoDir, dataDir).filter(({ m }) => m.standing !== 'from').flatMap(({ v }) => v._regions));
  let since = 0; try { since = Date.parse(JSON.parse(fs.readFileSync(setupFile(repoDir, dataDir), 'utf8')).at) || 0; } catch (_) {}
  const spans = readSpans(repoDir, dataDir, since);
  const done = biggest.filter((r) => marked.has(regionKey(r)) && wasRead(spans, r));
  const unread = biggest.filter((r) => marked.has(regionKey(r)) && !wasRead(spans, r));
  return { marked: done.length, of: biggest.length, share: biggest.length ? done.length / biggest.length : 1,
    marked_unread: unread.map((r) => r.file + '::' + shortName(r)),
    next: biggest.filter((r) => !done.includes(r)).slice(0, 12).map((r) => r.file + '::' + shortName(r) + ' (' + (r.to - r.from + 1) + ' lines' + (marked.has(regionKey(r)) ? ', marked but not read' : '') + ')') };
}
/* At Stop (hook.js): the reason to keep going, or null when setup is done -
 * covered, out of rounds, or no setup running. */
export function setupNext(repoDir, dataDir) {
  const f = setupFile(repoDir, dataDir);
  let s; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
  if (s.done) return null;
  if (Date.now() - Date.parse(s.at) > SETUP_FOR) { try { fs.unlinkSync(f); } catch (_) {} return null; }
  const c = setupCoverage(repoDir, dataDir);
  if (c.share >= SETUP_TARGET || s.rounds >= SETUP_ROUNDS) { s.done = { at: new Date().toISOString(), coverage: c.marked + '/' + c.of, rounds: s.rounds }; fs.writeFileSync(f, JSON.stringify(s) + '\n'); return null; }
  s.rounds++;
  fs.writeFileSync(f, JSON.stringify(s) + '\n');
  return 'GitX setup is not done: ' + c.marked + ' of the ' + c.of + ' biggest functions are marked (' + Math.round(c.share * 100) + '%, the target is ' + Math.round(SETUP_TARGET * 100) + '%). ' +
    'Keep going feature by feature: read each of these, work out which feature it belongs to, and mark it with gitx_mark { "marks": [...] } as before - same feature name for parts of a feature already marked. Next, the biggest unmarked: ' + c.next.join(', ') + '. Round ' + s.rounds + ' of ' + SETUP_ROUNDS + '.';
}

/* A repository recorded the GitX way needs no marks: its commits, thoughts
 * and topics are the record, and gitx_search reads them. */
export const isReady = (rec) => rec.state === 'recorded the GitX way';
export const READY_HOW = [
  'This repository is recorded the GitX way - commits carry their reasoning, thoughts and topics are linked - so there is nothing to mark. Ask with gitx_search { "query": "<the subject>", "lens": ["what","why"] }; use your own tools (Grep, Read) for where a named function or file is.'
];
export const INVESTIGATE_HOW = [
  'This repository is not GitX-ready yet, so you are building its record as you work: what you understand about the code is left on it for the next agent.',
  'Ask your questions with gitx_search { "query": "<the subject>", "lens": ["what","why"] } - its answers carry the notes earlier agents left on the code they land on (under marks), and what earlier agents said the project is. Check a note before relying on it, then gitx_mark { "confirm": "m-..." } or { "contradict": "m-...", "note": "..." }. Use your own tools (Grep, Read) for where a named function or file is.',
  'Your next final answer is read as your notes: name the code each statement is about (script.js::drawLinks, server.js:321) - each statement that says more than the names becomes a mark on that code, and an opening paragraph on what the project is becomes the project\'s note. marked_so_far says what is marked already and what nobody has marked: add to the gaps rather than repeating.',
  'When you change code, say in your answer what you changed and why, naming the code (file::function): with no GitX record yet, that is read as the note behind the change, on the code you changed. When you work out something the code does not say plainly - it took reading several places - leave it on that code: gitx_mark { "to": ["file:line", "file::function"], "note": "..." } - one mark on every place a feature lives.'
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
  const code = codeNow(repoDir).regions.filter((r) => r.kind !== 'doc');
  const inFile = (r, f) => r.file === f || r.file.endsWith('/' + f) || f.endsWith('/' + r.file);
  /* One answer, one mark: the code it cited together answered one question
   * together, and that is the one thing a citation says. */
  const rs = [];
  for (const ref of refs || []) {
    if (!ref.file) continue;
    const r = ref.name ? code.find((x) => inFile(x, ref.file) && (shortName(x) === ref.name || shortName(x).endsWith('.' + ref.name)))
      : code.find((x) => inFile(x, ref.file) && x.from <= ref.line && ref.line <= x.to);
    if (r && !shown.has(regionKey(r)) && !rs.includes(r)) rs.push(r);
  }
  if (!rs.length) return { made: 0, question: w.question.query };
  const res = createMark(repoDir, dataDir, { rs, standing: 'cited', by, question: w.question.query, evidence: { read: 'cited in the final answer' } });
  return { made: res.existed ? 0 : 1, places: rs.length, question: w.question.query };
}
