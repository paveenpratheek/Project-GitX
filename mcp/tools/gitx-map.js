/*
 * GitX.md - the map a setup agent writes of a repository GitX has no record
 * of (t-f3f6112124, t-352c91b3f4). GitX is a riddle, not an answer: it hands
 * the agent the code's own words as clues (tools/word-graph.js), the agent
 * reads the code, and the map says what it found and where it did not get.
 *
 * Framed as an answer the map lost to reading by hand on all six questions,
 * because readers stopped at it; framed as a map that states as found only
 * what was read and leaves the rest as unread leads, its readers read more
 * code than by hand and were judged best 4 of 6 (docs/word-graph-plan.md).
 * So GitX keeps three things true that the agent cannot be trusted to:
 *   - setup is not done until the code is read - coverage counts lines the
 *     agent opened with Read, and the Stop hook sends it back until it is;
 *   - the map says on top what it is, for readers who find it unprompted;
 *   - every name in it is checked against the code.
 *
 * Works on a folder with no git (file-fabric has none): the code is read
 * from disk, and the setup's state and reads are kept by the folder's path.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { diskRegions } from './code-find.js';
import { codeNow, readSpans } from './marks.js';
import { repoKey } from './path-recorder.js';
import { wordGraph, wordGraphText } from './word-graph.js';

export const MAP_NAME = 'GitX.md';
export const WORDS_FILE = path.join('.gitx', 'words.md');
/* Done at 90% of the code's lines read, or after ten rounds; a setup left
 * running is forgotten after six hours, so it never holds a later agent. */
export const MAP_TARGET = 0.9, MAP_ROUNDS = 10, MAP_FOR = 6 * 3600000;
const NEXT = 15;           // unread parts named when the agent is sent back

/* The code as it is now: git's index with uncommitted files split again,
 * or, with no git, the files on disk. */
export function regionsFor(dir) {
  let regions;
  try { regions = codeNow(dir).regions; } catch (_) { return diskRegions(dir); }
  /* A file with uncommitted changes is split again from disk without its
   * text, which the map needs - to check names and to fingerprint functions:
   * without it every function in an edited file read as changed. */
  const lines = new Map();
  return regions.map((r) => {
    if (r.text != null) return r;
    if (!lines.has(r.file)) { try { lines.set(r.file, fs.readFileSync(path.join(dir, r.file), 'utf8').replace(/\r\n/g, '\n').split('\n')); } catch (_) { lines.set(r.file, []); } }
    return { ...r, text: lines.get(r.file).slice(r.from - 1, r.to).join('\n') };
  });
}
const codeOf = (dir) => regionsFor(dir).filter((r) => r.kind !== 'doc');

/* Where the map is: at the root (committed, if the user wants) or private
 * in .gitx - the user's choice; root first when both exist. */
export function mapPath(dir) {
  for (const p of [path.join(dir, MAP_NAME), path.join(dir, '.gitx', MAP_NAME)]) if (fs.existsSync(p)) return p;
  return null;
}
const pathFor = (dir, where) => (where === 'gitx' ? path.join(dir, '.gitx', MAP_NAME) : path.join(dir, MAP_NAME));

const stateFile = (dir, data) => path.join(data, 'setup', repoKey(dir) + '.json');
function loadState(dir, data) {
  try { return JSON.parse(fs.readFileSync(stateFile(dir, data), 'utf8')); } catch (_) { return null; }
}
function saveState(dir, data, s) {
  fs.mkdirSync(path.dirname(stateFile(dir, data)), { recursive: true });
  fs.writeFileSync(stateFile(dir, data), JSON.stringify(s) + '\n');
}

/* How much of the code the setup agent has read since setup began: lines
 * opened with Read, over every code line. */
export function mapCoverage(dir, data, since = (loadState(dir, data) || {}).at) {
  const code = codeOf(dir);
  const spans = readSpans(dir, data, since ? Date.parse(since) : 0);
  const files = new Map();
  let total = 0, read = 0;
  const unread = [];
  for (const r of code) {
    const s = spans.get(r.file) || [];
    let n = 0;
    for (let i = r.from; i <= r.to; i++) if (s.some(([a, b]) => a <= i && i <= b)) n++;
    const len = r.to - r.from + 1;
    total += len; read += n;
    const f = files.get(r.file) || { lines: 0, read: 0 };
    f.lines += len; f.read += n; files.set(r.file, f);
    if (n < len / 2) unread.push({ at: r.file + ':' + r.from + '-' + r.to, name: r.name, lines: len - n });
  }
  return {
    read, of: total, share: total ? read / total : 1,
    files: [...files].sort((a, b) => b[1].lines - a[1].lines).map(([f, x]) => f + ': ' + x.read + ' of ' + x.lines + ' lines read'),
    next: unread.sort((a, b) => b.lines - a.lines).slice(0, NEXT).map((u) => u.at + ' (' + u.name + ')')
  };
}

/* Every name the map puts in backticks, checked against the code. A name
 * that is not in the code is a stale or guessed line - the round-1 map said
 * off-screen totems "show edge indicators" from a name whose code had gone. */
const NAME = /[A-Za-z_$][\w$-]*[\w$]/g;
/* The map as the agent wrote it, without GitX's lines on top. */
export const bodyOf = (text) => text.replace(/<!-- gitx:map -->[\s\S]*?<!-- \/gitx:map -->\s*/, '');
const hashOf = (text) => crypto.createHash('sha1').update(bodyOf(text)).digest('hex').slice(0, 16);
export function checkMap(dir, file = mapPath(dir)) {
  if (!file) return null;
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  text = bodyOf(text);
  const names = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    /* A span that names a file in the folder - find_braces.py, .claude/,
     * index.html.bak-dupfix-20260717 - is checked as that file, and only a
     * name after it (script.js::drawLinks) as code: split into pieces, the
     * first real map had five real file names flagged and unticked. */
    let span = m[1].trim();
    const file = span.split('::')[0].replace(/:\d+(?:-\d+)?$/, '').replace(/\/+$/, '');
    if (/[./]/.test(file) && fs.existsSync(path.join(dir, file))) span = span.includes('::') ? span.split('::').slice(1).join('::') : '';
    for (const n of span.matchAll(NAME)) if (n[0].length >= 4) names.add(n[0]);
  }
  const corpus = regionsFor(dir).filter((r) => r.kind !== 'doc').map((r) => r.text).join('\n');
  /* A file name the map cites is in the folder even when no code says it. */
  const exists = (n) => corpus.includes(n) || fs.existsSync(path.join(dir, n));
  const missing = [...names].filter((n) => !exists(n));
  return { file, names: names.size, missing };
}

/* The map is sorted by fixed kinds (t-95806b1f1d): four short sections every
 * agent gets from its first turn, then features read one at a time. The
 * kinds are GitX's, so no agent invents the classification - a weak model
 * sorts what it found, it does not design a taxonomy. */
export const KINDS = ['Goal', 'Rules', 'Criteria', 'Known bugs'];
const KIND = new RegExp('^##\\s+(' + KINDS.join('|') + ')\\b', 'i');
export const TOP_MAX = 9000;     // characters loaded into every session, about 2.5k tokens

/* The map's sections as the agent wrote them: heading, level, its lines in
 * the body (1-based), and whether it is one of the kinds. */
export function sectionsOf(body) {
  const lines = body.split('\n');
  const heads = [];
  lines.forEach((l, i) => { const m = /^(#{2,3})\s+(.+?)\s*$/.exec(l); if (m) heads.push({ level: m[1].length, title: m[2], from: i + 1 }); });
  return heads.map((h, k) => {
    /* A section runs to the next heading of its level or above. */
    const end = heads.slice(k + 1).find((x) => x.level <= h.level);
    return { ...h, to: end ? end.from - 1 : lines.length, kind: h.level === 2 && KIND.test('## ' + h.title) };
  });
}

/* What the map still lacks for GitX to serve it in parts. */
export function shapeOf(body) {
  const s = sectionsOf(body);
  const kinds = KINDS.filter((k) => s.some((x) => x.kind && x.title.toLowerCase().startsWith(k.toLowerCase())));
  const top = s.filter((x) => x.kind).reduce((n, x) => n + body.split('\n').slice(x.from - 1, x.to).join('\n').length, 0);
  return { missing: KINDS.filter((k) => !kinds.includes(k)), features: s.filter((x) => x.level === 3).length, top_chars: top };
}

/* The lines on top of the map - written by GitX, not the agent, so a reader
 * who finds GitX.md on its own is told what it is, what to read first and
 * where each feature is. The index gives exact lines for Read: GitX rewrites
 * it whenever the map changes. readLine is how much of the code was read; out
 * of setup the line already there is kept. stale (tools/map-index.js) marks
 * the sections whose code changed since the map was stamped, and names changed
 * code no section covers, so a reader knows where the map has fallen behind. */
export function stampMap(dir, file = mapPath(dir), { readLine = null, stale = null } = {}) {
  if (!file) return;
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  const old = /^> \*\*GitX map\*\*.*$/m.exec(text.split('<!-- /gitx:map -->')[0]);
  const read = readLine || (old ? old[0] : '> **GitX map** of this repository, written by a setup agent from the code it read.');
  const chk = checkMap(dir, file);
  const body = bodyOf(text);
  const secs = sectionsOf(body);
  const kinds = secs.filter((x) => x.kind), rest = secs.filter((x) => !x.kind && (x.level === 3 || !/^features\b/i.test(x.title)));
  const staleOf = (t) => stale && stale.stale.find((x) => x.title === t);
  const mark = (t) => { const x = staleOf(t); return x ? ' - STALE, changed since stamped: ' + [...x.changed, ...x.missing.map((n) => n + ' (gone)')].slice(0, 6).join(', ') : ''; };
  const head = (shift) => [
    '<!-- gitx:map -->',
    read,
    '> **Found** = read in the code. **Open lead** = seen only as a name, or not reached. It is where to start, not the answer - the code is. Check what you rely on, and look past its words: they are not all the words there are.',
    ...(chk && chk.missing.length ? ['> GitX checked ' + chk.names + ' names in this map against the code; ' + chk.missing.length + ' are not in it: ' + chk.missing.slice(0, 20).map((n) => '`' + n + '`').join(', ') + '.'] : []),
    ...(stale && (stale.stale.length || stale.uncovered.length) ? ['> GitX: ' + stale.stale.length + ' section(s) describe code that changed since the map was stamped (marked STALE below - trust the code there)' + (stale.uncovered.length ? '; changed code no section covers: ' + stale.uncovered.slice(0, 8).map((u) => '`' + u.name + '`').join(', ') + (stale.uncovered.length > 8 ? ' and ' + (stale.uncovered.length - 8) + ' more' : '') : '') + '.'] : []),
    ...(kinds.length ? ['> **Read first:** ' + kinds.map((x) => x.title + ' (lines ' + (x.from + shift) + '-' + (x.to + shift) + ')' + mark(x.title)).join(', ') + '. Then ask gitx_search about your task in your own words - it hands out the sections it touches, checked against the code; do not read this file for them. Sections:'] : []),
    ...rest.map((x) => '> - ' + x.title + ' - lines ' + (x.from + shift) + '-' + (x.to + shift) + mark(x.title)),
    '<!-- /gitx:map -->', ''
  ];
  /* Body line k is file line k + (header lines + the blank after it). */
  const n = head(0).length;
  const next = head(n).join('\n') + '\n' + body;
  if (next !== text) fs.writeFileSync(file, next);
}

/* What every session gets (hook.js at SessionStart, gitx_investigate): what
 * the map is, the four kinds as written, rules people recorded, and the index
 * - about 2.5k tokens at most, never the whole map. */
export async function topBlock(dir, file = mapPath(dir)) {
  if (!file) return null;
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const rel = path.relative(dir, file).replace(/\\/g, '/');
  const header = (/<!-- gitx:map -->([\s\S]*?)<!-- \/gitx:map -->/.exec(text) || [, ''])[1].trim();
  const body = bodyOf(text);
  const lines = body.split('\n');
  const kinds = sectionsOf(body).filter((x) => x.kind).map((x) => lines.slice(x.from - 1, x.to).join('\n').trim());
  /* Rules the code cannot show come from people: learned thoughts on record
   * for this repository, newest first, marked as recorded. */
  let recorded = [];
  try {
    const { loadThoughts } = await import('./thoughts.js');
    const all = [...loadThoughts(dir).thoughts, ...loadThoughts(dir, { store: 'context' }).thoughts];
    recorded = all.filter((t) => t.kind === 'learned' && t.outcome === 'accepted').sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 10).map((t) => '- ' + t.text + ' (recorded rule, ' + t.id + ')');
  } catch (_) { /* no record */ }
  let out = 'GitX map of this repository: ' + rel + '.\n' + header + '\n\n' + kinds.join('\n\n') + (recorded.length ? '\n\n## Rules recorded by people and agents\n' + recorded.join('\n') : '');
  if (out.length > TOP_MAX) out = out.slice(0, TOP_MAX) + '\n... (cut at ' + TOP_MAX + ' characters - the rest is in ' + rel + ' at the lines above)';
  return out;
}

/* Strict mode, for weaker models. Haiku answering with the map stack cited a
 * third of its functions without opening them - more than with CLAUDE.md or
 * by hand - and made the most wrong claims (map bench 5). Strict GitX holds
 * the agent to what it opened: in setup a higher read target, and every
 * function the map states as found must be one it read; in answers every
 * function cited must be one it opened this session. Claude Code does not
 * tell hooks the model, so strict is asked for (GITX_STRICT=1, --strict,
 * strict: true) or read from the session's transcript. */
export const MAP_TARGET_STRICT = 0.95, MAP_ROUNDS_STRICT = 12, CITE_ROUNDS = 2;
const STRICT_MODELS = () => new RegExp(process.env.GITX_STRICT_MODELS || 'haiku', 'i');
export function modelOf(transcript) {
  if (!transcript) return null;
  let model = null;
  try { for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) { const m = /"model":"([^"]+)"/.exec(l); if (m && /^claude-/.test(m[1])) model = m[1]; } } catch (_) { /* no transcript */ }
  return model;
}
export const strictFor = ({ flag = false, transcript = null } = {}) =>
  flag || process.env.GITX_STRICT === '1' || STRICT_MODELS().test(modelOf(transcript) || '');

/* The functions the code defines, by name, and where. */
const definesOf = (dir) => {
  const defs = new Map();
  for (const r of regionsFor(dir)) if (r.kind === 'code') { const n = shortNameOf(r); if (n && !defs.has(n)) defs.set(n, r); }
  return defs;
};
const shortNameOf = (r) => (/(?:function\s+|(?:const|let|var)\s+|class\s+)([A-Za-z_$][\w$]*)/.exec(r.name) || /^([A-Za-z_$][\w$]*)\s*\(/.exec(r.name) || [])[1] || null;
const opened = (spans, r) => (spans.get(r.file) || []).some(([a, b]) => a <= r.to && b >= r.from);

/* Setup, strict: functions the map states as found that the agent never
 * opened. Grep: lines are vocabulary, and a line that says it is a lead or
 * unread is a lead - neither is a claim of having read. */
export function unopenedFound(dir, data, file = mapPath(dir), since = (loadState(dir, data) || {}).at) {
  if (!file) return [];
  const body = bodyOf(fs.readFileSync(file, 'utf8'));
  const defs = definesOf(dir);
  const spans = readSpans(dir, data, since ? Date.parse(since) : 0);
  const lines = body.split('\n');
  const leads = new Set();
  for (const s of sectionsOf(body)) if (/open leads?|unread|not read/i.test(s.title)) for (let i = s.from; i <= s.to; i++) leads.add(i);
  const out = new Set();
  lines.forEach((l, i) => {
    if (leads.has(i + 1) || /^\s*Grep:/.test(l) || /open lead|unread|not read|unconfirmed|lead:/i.test(l)) return;
    for (const m of l.matchAll(/`([^`\n]+)`/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
      const r = defs.get(n[0]);
      if (r && !opened(spans, r)) out.add(n[0]);
    }
  });
  return [...out];
}

/* Answers, strict: functions an answer cites that this session never opened. */
export function unopenedCited(dir, data, answer, session) {
  const defs = definesOf(dir);
  const spans = new Map();
  try {
    for (const l of fs.readFileSync(path.join(data, 'reads', repoKey(dir) + '.jsonl'), 'utf8').split('\n')) {
      let x; try { x = JSON.parse(l); } catch (_) { continue; }
      if (!x || x.session !== session || !x.file) continue;
      const from = x.from || 1, to = x.to || from + 1999;
      if (!spans.has(x.file)) spans.set(x.file, []);
      spans.get(x.file).push([from, to]);
    }
  } catch (_) { /* nothing read */ }
  const out = new Set();
  for (const m of String(answer).matchAll(/`([^`\n]+)`/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
    const r = defs.get(n[0]);
    if (r && !opened(spans, r)) out.add(n[0]);
  }
  return [...out];
}

/* At Stop, outside setup: the answer goes back once or twice while it cites
 * functions it never opened. Counted per session, so it never loops. */
export function citeNext(dir, data, answer, session) {
  if (!session) return null;
  const f = path.join(data, 'strict', session + '.json');
  let s = { rounds: 0 }; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  if (s.rounds >= CITE_ROUNDS) return null;
  const missing = unopenedCited(dir, data, answer, session);
  if (!missing.length) return null;
  s.rounds++;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s) + '\n');
  return 'GitX (strict): your answer names code you never opened in this session: ' + missing.slice(0, 15).join(', ') + '. Open each with Read and check what you say about it - keep the claim, correct it, or drop it - then give your answer again. Round ' + s.rounds + ' of ' + CITE_ROUNDS + '.';
}

/* gitx_investigate { mode: "setup" }: the word graph written for the agent,
 * the setup stamped, and where things stand. */
export function startMapSetup(dir, data, { where = 'root', by = null, strict = false } = {}) {
  const graph = wordGraph(dir, { regions: regionsFor(dir) });
  const words = path.join(dir, WORDS_FILE);
  fs.mkdirSync(path.dirname(words), { recursive: true });
  fs.writeFileSync(words, wordGraphText(dir, graph) + '\n');
  let s = loadState(dir, data);
  if (!s || s.done || Date.now() - Date.parse(s.at) > MAP_FOR) {
    s = { at: new Date().toISOString(), by, where: where === 'gitx' ? 'gitx' : 'root', rounds: 0, strict: !!strict };
    saveState(dir, data, s);
  }
  const map = mapPath(dir) || pathFor(dir, s.where);
  return {
    map: path.relative(dir, map).replace(/\\/g, '/'), map_exists: fs.existsSync(map),
    words: WORDS_FILE.replace(/\\/g, '/') + ' - ' + graph.length + ' groups, ' + graph.reduce((n, g) => n + g.terms.filter((t) => !t.seen).length, 0) + ' words',
    coverage: mapCoverage(dir, data, s.at), target: Math.round(MAP_TARGET * 100) + '% of the code\'s lines read'
  };
}

/* At Stop (hook.js): the reason to keep going, or null when setup is done -
 * the code read, out of rounds, or no setup running. */
export function mapNext(dir, data, { strict = false } = {}) {
  const s = loadState(dir, data);
  if (!s || s.done) return null;
  const hard = strict || s.strict, TARGET = hard ? MAP_TARGET_STRICT : MAP_TARGET, ROUNDS = hard ? MAP_ROUNDS_STRICT : MAP_ROUNDS;
  if (Date.now() - Date.parse(s.at) > MAP_FOR) { try { fs.unlinkSync(stateFile(dir, data)); } catch (_) {} return null; }
  const file = mapPath(dir);
  const target = file || pathFor(dir, s.where);
  const rel = path.relative(dir, target).replace(/\\/g, '/');
  const c = mapCoverage(dir, data, s.at);
  if (file) stampMap(dir, file, { readLine: '> **GitX map** of this repository, written by a setup agent from the code it read - ' + Math.round(c.share * 100) + '% of ' + c.of + ' code lines, ' + new Date().toISOString().slice(0, 10) + '.' });
  const chk = file ? checkMap(dir, file) : null;
  const stale = chk && chk.missing.length ? chk.missing : [];
  const text = file ? fs.readFileSync(file, 'utf8') : '';
  const shape = file ? shapeOf(bodyOf(text)) : null;
  const unshaped = shape && (shape.missing.length || !shape.features || shape.top_chars > TOP_MAX);
  /* By what the agent wrote, not the file's time - GitX's own stamp changes that. */
  const body = file ? hashOf(text) : null;
  const covered = c.share >= TARGET;
  /* Strict: a function stated as found must be one the agent opened. */
  const unopened = hard && file ? unopenedFound(dir, data, file, s.at) : [];
  if ((file && covered && !stale.length && !unshaped && !unopened.length) || s.rounds >= ROUNDS) {
    s.done = { at: new Date().toISOString(), read: c.read + '/' + c.of, rounds: s.rounds, map: file ? rel : null };
    saveState(dir, data, s);
    /* A finished setup is the map's new baseline (tools/map-index.js): the old
     * fingerprints go, and the next look stamps the map as it is now. */
    try { fs.unlinkSync(path.join(dir, '.gitx', 'map-index.json')); } catch (_) { /* none yet */ }
    return null;
  }
  const quiet = s.rounds > 0 && file && body === s.mapBody;
  s.rounds++; s.mapBody = body;
  saveState(dir, data, s);
  const why = [];
  if (!file) why.push('There is no map yet: write ' + rel + ' now with what you have found so far, then go on reading.');
  if (quiet) why.push(rel + ' has not changed since the last round: write down what you read - move what you read from open leads to found, and add what you found.');
  if (stale.length) why.push('These names in the map are not in the code - fix or remove them: ' + stale.slice(0, 20).join(', ') + '.');
  if (shape && shape.missing.length) why.push('The map needs its four top sections, which every agent gets first - missing: ' + shape.missing.map((k) => '## ' + k).join(', ') + '.');
  if (shape && !shape.features) why.push('Put each feature under its own ### heading inside ## Features, so a reader can load one feature alone.');
  if (shape && shape.top_chars > TOP_MAX) why.push('The four top sections are ' + shape.top_chars + ' characters - keep them under ' + TOP_MAX + ' together (every session loads them); move detail into the feature sections.');
  if (unopened.length) why.push('(Strict) These functions are stated as found, but you never opened their code: ' + unopened.slice(0, 20).join(', ') + '. Read each one and keep, correct or remove what the map says - or mark it as an unread open lead.');
  if (!covered) why.push('You have read ' + c.read + ' of ' + c.of + ' code lines (' + Math.round(c.share * 100) + '%; setup is done at ' + Math.round(TARGET * 100) + '%). Read with Read - only what you open counts. The biggest parts still unread: ' + c.next.join(', ') + '. Then update the map with what you found.');
  return 'GitX setup is not done. ' + why.join(' ') + ' Round ' + s.rounds + ' of ' + ROUNDS + '.';
}

export const MAP_SETUP_HOW = (rel) => [
  'You are setting this repository up for GitX. GitX has written this code\'s own words to .gitx/words.md: names the code defines, grouped by a shared name part, each with its near words and the other places it appears. No line numbers - grep a word to find it.',
  'The words are clues, not answers. A name says what someone meant when they wrote it, not what the code does now, and these are not all the words there are. Grep them, read the code with Read - only what you open with Read counts as read - and follow what you find past them.',
  'Write the map to ' + rel + ', for the agents who come after you. State as found only what you read in the code. Anything you saw only as a name, or did not get to, goes in as an open lead and says it is unread. Readers will trust what you state as found and go and check the leads, so keep the line between the two exact.',
  'Shape it so GitX can hand it out in parts. First four short sections, which every agent is given from its first turn: ## Goal (what the project is for, as the code shows it), ## Rules (what must stay true when changing the code - invariants the code implies, such as two places that must change together, each with where it is), ## Criteria (how to tell a change works - how it runs, what tests or checks exist), ## Known bugs (problems you read in the code, each with where). Keep the four under ' + TOP_MAX + ' characters together. Then ## Features, one ### heading per feature a user would name, each with the words to grep, what you found, how it connects to the rest, and its open leads. Then ## Open leads for what you did not reach. A reader loads the four sections and then only the feature its task touches, so put each thing where that reader will look. GitX writes the lines on top: what the map is and an index of the sections.',
  'Read all of the code. Write the map early and keep it up to date as you go - a long setup outlives what you can hold in mind. coverage says how much you have read; setup is done at ' + Math.round(MAP_TARGET * 100) + '% of the code\'s lines, and until then GitX sends you back with what is still unread. Every name you put in backticks is checked against the code.',
  'CLAUDE.md, GEMINI.md, AGENTS.md, READMEs and notes are for the agents who read them, and may be out of date: the map is about the code. Change no file but the map.'
];

/* For an agent arriving at a repository that has a map. */
export const MAP_READ_HOW = (rel) => 'This repository has a GitX map at ' + rel + ': its goal, rules, criteria and known bugs, then per feature the words to grep, what a setup agent found when it read the code, and open leads it did not read. Its top lines index the sections - read the one your task touches, not the whole file. It is where to start, not the answer - the code is. Check what you rely on, and look past its words.';
