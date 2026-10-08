/*
 * The thought watcher: what changed, when, and what it used to say.
 *
 * There is no gate on the thought files and there cannot be a real one - an
 * agent has the same disk access this process does, so anything that refuses a
 * write is refusing only the polite path. What is worth having instead is a
 * record: every add, edit and delete seen, with the OLD values kept, so a
 * mistaken rewrite is both noticed and recoverable. Prevention was never
 * available; detection is.
 *
 * Five things it is careful about:
 *
 *   TWO GRAPHS, ONE RECORD. A thought lives in the thought graph
 *   (.gitx/thoughts/) or in the context graph (.gitx/context/thoughts/), and
 *   passes from the second to the first when a commit settles it. Each store
 *   read alone would see that as a removal in one place and an unrelated
 *   addition in the other, and the history of the thought would break in two.
 *   Both are watched together, so an id that changes store is ONE entry,
 *   "moved", carrying any fields that changed with it. The same id in both
 *   stores at once is reported as an unreadable file: a thought cannot be in
 *   two graphs, and the thought-graph copy is the one read.
 *
 *   FILES, NOT ONLY THOUGHTS. A file in the wrong shape never becomes a
 *   thought, so it cannot appear as one being added - it is skipped by the
 *   reader without a word, and the write looks like it worked. Those files are
 *   watched by path and recorded with the reason, which makes a badly written
 *   thought the one kind of mistake that says so.
 *
 *   OUTSIDE THE REPOSITORY. The log lives in GitX's own data folder under the
 *   host's save directory, not in .gitx/ - a log sitting beside the files it
 *   watches is edited by whatever edited them. It falls back to the repo only
 *   when there is no save directory to use.
 *
 *   CHAINED. Each entry carries the hash of the one before it, so an entry
 *   removed or rewritten later breaks the chain and says so. It does not stop
 *   tampering; it stops tampering being silent.
 *
 *   IT CANNOT NAME THE AUTHOR. The filesystem does not record who wrote a
 *   file. Each entry carries what this process does know - the agents
 *   connected at that moment - and calls it what it is: circumstantial.
 *
 * Reconciles on startup, so changes made while nothing watched are still seen,
 * marked as unwatched rather than dated wrongly.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadThoughts, thoughtDirs } from './thoughts.js';
import { loadTopics, loadGoal, mapPaths } from './topics.js';

const DEBOUNCE_MS = 400;
const MAX_READ = 5000;          // entries a reader may ask for at once

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/* A repository is identified by its first commit, not its path: the same clone
 * moved or renamed keeps its log. Falls back to the path when git cannot say. */
function repoKey(repoDir) {
  try {
    const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      windowsHide: true,
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split('\n').pop();
    if (root) return root.slice(0, 16);
  } catch (_) { /* no commits yet, or not a repo */ }
  return sha(path.resolve(repoDir));
}

export function logHome(repoDir, dataDir) {
  const base = dataDir || path.join(repoDir, '.gitx');
  return path.join(base, 'thought-log', repoKey(repoDir));
}

function readIndex(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8')); } catch (_) { return null; }
}

/* Both graphs, and which one each thought is in. `where` is kept beside the
 * thoughts rather than inside them, so a thought is recorded exactly as it is
 * on disk. */
function snapshot(repoDir) {
  const graph = loadThoughts(repoDir);
  const context = loadThoughts(repoDir, { store: 'context' });
  const out = { thoughts: {}, where: {}, files: {} };
  for (const t of graph.thoughts) { out.thoughts[t.id] = t; out.where[t.id] = 'thought'; }
  /* A file that is not readable as a thought never becomes one, so it can never
   * show up as an "added" thought - it is the one change that would otherwise
   * go unreported, and the worst one to miss, because the write LOOKS like it
   * worked. Kept by path, with the reason and a hash of what it says. */
  for (const u of [...graph.stats.unreadable, ...context.stats.unreadable]) out.files[u.file] = { why: u.why, hash: u.hash };
  for (const t of context.thoughts) {
    if (out.thoughts[t.id]) {
      out.files[context.fileOf[t.id]] = {
        why: 'id ' + t.id + ' is also in the thought graph, at ' + graph.fileOf[t.id] + ' - a thought cannot be in both graphs, and only the thought-graph copy is read',
        hash: sha(JSON.stringify(t))
      };
      continue;
    }
    out.thoughts[t.id] = t;
    out.where[t.id] = 'context';
  }
  /* The context map's topics and goal: not thoughts, but what they decide -
   * which part agents read - is worth a record of its own. */
  out.map = { topics: Object.fromEntries(loadTopics(repoDir).topics.map((t) => [t.id, t])), goal: loadGoal(repoDir).goal };
  return out;
}

/* Topic files and the goal: added, changed with what they used to say, and
 * removed with a full copy, as thoughts are. An index from before the map
 * existed has none, so a first look reports what is there as added. */
const TOPIC_FIELDS = ['title', 'status', 'waiting_for', 'revisit_if', 'digest', 'owner'];
const GOAL_FIELDS = ['text', 'topics', 'domains_off'];
function diffMap(before, after) {
  const events = [];
  const b = (before && before.topics) || {}, a = after.topics;
  const fieldsOf = (x, y, names) => {
    const f = {};
    for (const n of names) {
      const p = JSON.stringify(x[n] === undefined ? null : x[n]), q = JSON.stringify(y[n] === undefined ? null : y[n]);
      if (p !== q) f[n] = { was: JSON.parse(p), now: JSON.parse(q) };
    }
    return f;
  };
  for (const id of Object.keys(a)) {
    if (!b[id]) { events.push({ event: 'topic-added', id, text: a[id].title }); continue; }
    const f = fieldsOf(b[id], a[id], TOPIC_FIELDS);
    if (Object.keys(f).length) events.push({ event: 'topic-changed', id, text: a[id].title, fields: f });
  }
  for (const id of Object.keys(b)) if (!a[id]) events.push({ event: 'topic-removed', id, text: b[id].title, topic: b[id] });
  const g0 = (before && before.goal) || null, g1 = after.goal;
  if (g1 && !g0) events.push({ event: 'goal-set', id: 'goal', text: g1.text, goal: g1 });
  else if (!g1 && g0) events.push({ event: 'goal-removed', id: 'goal', text: g0.text, goal: g0 });
  else if (g1 && g0) {
    const f = fieldsOf(g0, g1, GOAL_FIELDS);
    if (Object.keys(f).length) events.push({ event: 'goal-changed', id: 'goal', text: g1.text, set_by: g1.set_by, fields: f });
  }
  return events;
}

/* Which fields differ, with what they used to say. Whole thoughts are kept for
 * a removal - that is the copy a restore comes from. */
const WATCHED_FIELDS = ['kind', 'text', 'outcome', 'decided_by', 'anchor', 'resulted_in', 'links', 'forces', 'applied_to', 'provenance', 'parent', 'was_parent', 'session', 'sources'];

/* An index saved before the context graph existed has no `where`: everything
 * it recorded was in the thought graph, so that is what an unrecorded store
 * means - and restarting on an old index logs no false moves. */
const storeOf = (where, id) => (where && where[id]) || 'thought';

function diff(before, after, wasIn, isIn) {
  const events = [];
  for (const id of Object.keys(after)) {
    const to = storeOf(isIn, id);
    if (!before[id]) { events.push({ event: 'added', id, store: to, text: after[id].text }); continue; }
    const fields = {};
    for (const f of WATCHED_FIELDS) {
      const a = JSON.stringify(before[id][f] === undefined ? null : before[id][f]);
      const b = JSON.stringify(after[id][f] === undefined ? null : after[id][f]);
      if (a !== b) fields[f] = { was: JSON.parse(a), now: JSON.parse(b) };
    }
    const changed = Object.keys(fields).length > 0;
    const from = storeOf(wasIn, id);
    /* One entry for a move, with whatever changed on the way - a promotion
     * sets resulted_in in the same step, and splitting that into a move and an
     * edit would record one act as two. */
    if (from !== to) events.push({ event: 'moved', id, from, to, text: after[id].text, fields: changed ? fields : undefined });
    else if (changed) events.push({ event: 'changed', id, store: to, text: after[id].text, fields });
  }
  for (const id of Object.keys(before)) {
    if (!after[id]) events.push({ event: 'removed', id, store: storeOf(wasIn, id), text: before[id].text, thought: before[id] });
  }
  return events;
}

/* The same for files that are not thoughts: one appearing, one still wrong
 * after an edit, and one that stops being wrong - by being fixed, or deleted. */
function diffFiles(repoDir, before, after) {
  const events = [];
  for (const file of Object.keys(after)) {
    const was = before[file];
    if (!was) events.push({ event: 'unreadable', file, why: after[file].why });
    /* Changed and still wrong: worth an entry of its own, and worth saying
     * when it is wrong in a NEW way rather than the same one. */
    else if (was.hash !== after[file].hash) events.push({ event: 'unreadable', file, why: after[file].why, before: was.why === after[file].why ? undefined : was.why });
  }
  for (const file of Object.keys(before)) {
    if (after[file]) continue;
    const still = fs.existsSync(path.join(repoDir, file));
    events.push({ event: 'readable', file, how: still ? 'it reads as a thought now' : 'the file is gone', before: before[file].why });
  }
  return events;
}

export class ThoughtWatcher {
  constructor({ dataDir = null, context = () => ({}), onChange = null } = {}) {
    this.dataDir = dataDir;
    this.context = context;              // what the broker knows: agents online, etc.
    this.onChange = onChange;            // told after a sweep that found anything
    this.repoDir = null;
    this.home = null;
    this.before = { thoughts: {}, where: {}, files: {} };
    this.timer = null;
    this.watchers = [];
    this.lastHash = null;
    this.stats = { entries: 0, unwatched: 0, unreadable: 0 };
  }

  /* Point it at a repository - on startup, and whenever the broker switches. */
  open(repoDir) {
    this.close();
    this.repoDir = repoDir;
    this.home = logHome(repoDir, this.dataDir);
    fs.mkdirSync(this.home, { recursive: true });

    const saved = readIndex(this.home);
    this.lastHash = saved ? saved.lastHash : null;
    const now = snapshot(repoDir);
    /* Anything that moved while nothing was watching is still recorded, marked
     * as such: the time is when it was NOTICED, not when it happened. */
    if (saved && saved.thoughts) {
      const missed = [...diff(saved.thoughts, now.thoughts, saved.where, now.where), ...diffFiles(repoDir, saved.files || {}, now.files), ...diffMap(saved.map, now.map)];
      if (missed.length) {
        this.append(missed.map((e) => ({ ...e, seen: 'while-unwatched' })));
        this.stats.unwatched += missed.length;
      }
    }
    this.before = now;
    this.stats.unreadable = Object.keys(now.files).length;
    this.save();
    this.watch();
    /* Said out loud, once, because an agent that wrote a thought in the wrong
     * shape has no other way of hearing that it does not exist. */
    if (this.stats.unreadable) {
      console.warn('[GitX Watcher] ' + this.stats.unreadable + ' file(s) under .gitx are not readable as thoughts, and are being skipped:');
      for (const [file, u] of Object.entries(now.files)) console.warn('  ' + file + ' - ' + u.why);
    }
    return this;
  }

  watch() {
    const dirs = thoughtDirs(this.repoDir);
    /* A rename between the two graphs fires in two folders at once; the
     * debounce lets both land before one sweep reads them, which is what makes
     * a move one entry rather than a removal and an addition. */
    for (const dir of [dirs.thoughts, dirs.drafts, dirs.stash, dirs.context, dirs.contextStash, mapPaths(this.repoDir).topics]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, { recursive: true }, () => this.bump());
        w.on('error', () => { /* a folder that goes away is not a crash */ });
        this.watchers.push(w);
      } catch (_) { /* unwatchable folder - the startup reconcile still covers it */ }
    }
    /* goal.json sits in .gitx/context/ itself, beside the folders above:
     * watched there, not recursively, for that one name. */
    try {
      const goal = mapPaths(this.repoDir).goal;
      const w = fs.watch(path.dirname(goal), { recursive: false }, (ev, name) => { if (String(name || '') === path.basename(goal)) this.bump(); });
      w.on('error', () => {});
      this.watchers.push(w);
    } catch (_) { /* the reconcile still covers it */ }
  }

  bump() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sweep(), DEBOUNCE_MS);
  }

  sweep() {
    if (!this.repoDir) return;
    let now;
    try { now = snapshot(this.repoDir); } catch (_) { return; }
    const events = [...diff(this.before.thoughts, now.thoughts, this.before.where, now.where), ...diffFiles(this.repoDir, this.before.files, now.files), ...diffMap(this.before.map, now.map)];
    if (events.length) this.append(events);
    /* An edit that breaks a thought reads as a removal AND an unreadable file;
     * both are recorded, and the second is the one that says why. */
    for (const e of events) if (e.event === 'unreadable') console.warn('[GitX Watcher] ' + e.file + ' is not readable as a thought - ' + e.why);
    this.before = now;
    this.stats.unreadable = Object.keys(now.files).length;
    this.save();
    /* So what is on screen follows: a thought an agent records, or a goal
     * changed in another window, reaches the page without waiting for a
     * commit. */
    if (events.length && this.onChange) { try { this.onChange(events); } catch (_) { /* the record is kept either way */ } }
  }

  append(events) {
    const at = new Date().toISOString();
    const ctx = this.context() || {};
    const lines = events.map((e) => {
      const entry = { at, repo: this.repoDir, ...e, agents_online: ctx.agents || [], attribution: 'circumstantial - the filesystem does not say who wrote a file', prev: this.lastHash };
      entry.hash = sha(JSON.stringify(entry));
      this.lastHash = entry.hash;
      this.stats.entries++;
      return JSON.stringify(entry);
    });
    try {
      fs.appendFileSync(path.join(this.home, 'log.jsonl'), lines.join('\n') + '\n');
    } catch (err) {
      console.warn('[GitX Watcher] Could not append to the thought log:', err.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(path.join(this.home, 'index.json'),
        JSON.stringify({ repo: this.repoDir, at: new Date().toISOString(), lastHash: this.lastHash, thoughts: this.before.thoughts, where: this.before.where, files: this.before.files, map: this.before.map }, null, 1));
    } catch (_) { /* the log is what matters; the index rebuilds itself */ }
  }

  close() {
    clearTimeout(this.timer);
    for (const w of this.watchers) { try { w.close(); } catch (_) {} }
    this.watchers = [];
  }
}

/* Reading it back: the whole log, or one thought's history. Entries are
 * returned newest first, with the chain checked as they are read. */
export function readLog(repoDir, { id = null, limit = 50, dataDir = null } = {}) {
  const home = logHome(repoDir, dataDir);
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8'); } catch (_) {
    return { entries: [], note: 'Nothing has been recorded for this repository yet - the watcher writes as changes happen.' };
  }
  const all = [];
  let broken = null, prev = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { broken = broken || 'a line of the log is not readable'; continue; }
    const { hash, ...rest } = e;
    if (sha(JSON.stringify(rest)) !== hash) broken = broken || ('entry ' + (e.id || '') + ' at ' + e.at + ' does not match its own hash');
    else if (prev && e.prev !== prev) broken = broken || ('the chain breaks before ' + (e.id || '') + ' at ' + e.at);
    prev = hash;
    all.push(e);
  }
  /* A file that is not readable has no id to ask for, so the same argument
   * matches its path - "t-1a2b" or ".gitx/drafts/x.json" both work. */
  const picked = (id ? all.filter((e) => e.id === id || e.file === id) : all).slice(-Math.min(limit, MAX_READ)).reverse();
  return {
    entries: picked,
    recorded: all.length,
    tampered: broken || undefined,
    note: broken
      ? 'The log does not verify: ' + broken + '. Entries can still be read, but one has been changed or removed since it was written.'
      : undefined
  };
}
