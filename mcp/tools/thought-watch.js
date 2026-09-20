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
 * Three things it is careful about:
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

const DEBOUNCE_MS = 400;
const MAX_READ = 5000;          // entries a reader may ask for at once

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/* A repository is identified by its first commit, not its path: the same clone
 * moved or renamed keeps its log. Falls back to the path when git cannot say. */
function repoKey(repoDir) {
  try {
    const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
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

function snapshot(repoDir) {
  const { thoughts } = loadThoughts(repoDir);
  const out = {};
  for (const t of thoughts) out[t.id] = t;
  return out;
}

/* Which fields differ, with what they used to say. Whole thoughts are kept for
 * a removal - that is the copy a restore comes from. */
const WATCHED_FIELDS = ['kind', 'text', 'outcome', 'decided_by', 'anchor', 'resulted_in', 'links', 'forces', 'applied_to', 'provenance', 'confirmed', 'parent', 'session', 'sources'];

function diff(before, after) {
  const events = [];
  for (const id of Object.keys(after)) {
    if (!before[id]) { events.push({ event: 'added', id, text: after[id].text }); continue; }
    const fields = {};
    for (const f of WATCHED_FIELDS) {
      const a = JSON.stringify(before[id][f] === undefined ? null : before[id][f]);
      const b = JSON.stringify(after[id][f] === undefined ? null : after[id][f]);
      if (a !== b) fields[f] = { was: JSON.parse(a), now: JSON.parse(b) };
    }
    if (Object.keys(fields).length) events.push({ event: 'changed', id, text: after[id].text, fields });
  }
  for (const id of Object.keys(before)) {
    if (!after[id]) events.push({ event: 'removed', id, text: before[id].text, thought: before[id] });
  }
  return events;
}

export class ThoughtWatcher {
  constructor({ dataDir = null, context = () => ({}) } = {}) {
    this.dataDir = dataDir;
    this.context = context;              // what the broker knows: agents online, etc.
    this.repoDir = null;
    this.home = null;
    this.before = {};
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
      const missed = diff(saved.thoughts, now);
      if (missed.length) {
        this.append(missed.map((e) => ({ ...e, seen: 'while-unwatched' })));
        this.stats.unwatched += missed.length;
      }
    }
    this.before = now;
    this.save();
    this.watch();
    return this;
  }

  watch() {
    const dirs = thoughtDirs(this.repoDir);
    for (const dir of [dirs.confirmed, dirs.drafts, dirs.stash]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, { recursive: true }, () => this.bump());
        w.on('error', () => { /* a folder that goes away is not a crash */ });
        this.watchers.push(w);
      } catch (_) { /* unwatchable folder - the startup reconcile still covers it */ }
    }
  }

  bump() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sweep(), DEBOUNCE_MS);
  }

  sweep() {
    if (!this.repoDir) return;
    let now;
    try { now = snapshot(this.repoDir); } catch (_) { return; }
    const events = diff(this.before, now);
    /* A file that stopped parsing reads as a removal, and it is worth saying
     * which it was: the reader drops such a thought without a word. */
    const { stats } = loadThoughts(this.repoDir);
    if (stats.skipped) this.stats.unreadable = stats.skipped;
    if (events.length) this.append(events);
    this.before = now;
    this.save();
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
        JSON.stringify({ repo: this.repoDir, at: new Date().toISOString(), lastHash: this.lastHash, thoughts: this.before }, null, 1));
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
  const picked = (id ? all.filter((e) => e.id === id) : all).slice(-Math.min(limit, MAX_READ)).reverse();
  return {
    entries: picked,
    recorded: all.length,
    tampered: broken || undefined,
    note: broken
      ? 'The log does not verify: ' + broken + '. Entries can still be read, but one has been changed or removed since it was written.'
      : undefined
  };
}
