/*
 * Trail recorder: which nodes an agent visited on its way through GitX, kept
 * for the 5th Dimension (graph caching) to learn from later.
 *
 * Self-contained on purpose. It writes only into its own folder, reads none of
 * the other stores, and server.js calls it in two places. Removing it is
 * deleting this file, those two calls and the folder - nothing else moves.
 *
 * WHERE
 *   <GitX data folder>/trails/<repo key>/<session>.jsonl
 *   The data folder is GITX_DATA_DIR, else the one ter-manager keeps for this
 *   plugin, else the OS's local app data (%LOCALAPPDATA%\gitx on Windows) -
 *   never inside a repository, because a trail names private thoughts and
 *   carries the agent's own search words. One file per agent session, so a
 *   single recording can be deleted without touching any other.
 *
 * WHAT IS RECORDED - raw events, nothing interpreted
 *   Each tool call: which layer it acted on, the node it landed on, the words
 *   the agent searched with, and the ids the answer offered. When a later call
 *   lands on an id an earlier answer offered, that is recorded too (picked).
 *
 * WHAT IS DERIVED - acceptance, from the raw events, when read
 *   The owner's definition: the node where the agent CAME IN, every node where
 *   it TURNED up or down to another layer, and the node where it LEFT. Kept in
 *   acceptedNodes() below and never written into a recording, so changing the
 *   definition re-reads every recording made so far under the new one.
 *
 * WHAT IT CANNOT SEE, said plainly
 *   - The user's prompt. Only the words an agent passes to a tool reach GitX.
 *   - The code layer. Agents read code with their own tools, and GitX has no
 *     code-layer tool yet, so going DOWN to raw code is invisible until the 4th
 *     Dimension adds one. Nothing here guesses at it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const VERSION = 1;
const OFFER_CAP = 25;

/* Which layer each tool acts on. Tools not listed are not moves through the
 * stack (the swarm and issue tools) - still recorded, with no layer, so the
 * log is complete; acceptance ignores them. */
const LAYER = {
  gitx_graph_map: 'L2', gitx_graph_area: 'L2', gitx_graph_chain: 'L2', gitx_graph_commit: 'L2',
  gitx_find_related: 'L2', gitx_search_chronicle: 'L2', gitx_commit_chronicle: 'L2',
  gitx_thought_catch_up: 'L3', gitx_thought_search: 'L3', gitx_thought_history: 'L3'
};
const LEVEL = { L1: 1, L2: 2, L3: 3 };

/* The node a call landed on, from its arguments. */
function nodeOf(tool, a = {}) {
  switch (tool) {
    case 'gitx_graph_map': return { kind: 'map' };
    case 'gitx_graph_area': return { kind: 'area', id: a.name || null };
    case 'gitx_graph_chain':
    case 'gitx_graph_commit': return { kind: 'commit', id: a.hash || null };
    case 'gitx_find_related':
    case 'gitx_search_chronicle': return { kind: 'search' };
    case 'gitx_commit_chronicle': return { kind: 'commit-written' };
    case 'gitx_thought_catch_up': return { kind: 'overview', id: a.since || null };
    case 'gitx_thought_history': return { kind: 'thought-history', id: a.id || null };
    /* Across all three layers at once, so it has no layer of its own; what it
     * offered and what the agent opened next is what route learning needs. */
    case 'gitx_related': return a.ids && a.ids.length ? { kind: 'related-to', id: a.ids[0] } : { kind: 'search' };
    case 'gitx_thought_search':
      if (a.id) return { kind: 'thought', id: a.id };
      /* Asking for the thinking behind a commit is the step UP from L2. */
      if (a.commit) return { kind: 'thoughts-of-commit', id: a.commit };
      return { kind: 'search' };
    default: return null;
  }
}

/* The agent's own words, where the call carried any. */
const intentOf = (a = {}) => a.query || a.description || null;

/* Every thought id and commit hash an answer offered, found by shape rather
 * than by knowing each tool's layout, so a tool that changes its answer does
 * not silently stop being recorded. */
function offeredIn(result) {
  const out = { thoughts: new Set(), commits: new Set() };
  let obj;
  try { obj = JSON.parse(result && result.content && result.content[0] && result.content[0].text); } catch (_) { return { thoughts: [], commits: [] }; }
  const walk = (v, key) => {
    if (out.thoughts.size >= OFFER_CAP && out.commits.size >= OFFER_CAP) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k); return; }
    if (typeof v !== 'string') return;
    if (/^t-[0-9a-f]{10}$/.test(v) && out.thoughts.size < OFFER_CAP) out.thoughts.add(v);
    else if ((key === 'hash' || key === 'short') && /^[0-9a-f]{7,40}$/.test(v) && out.commits.size < OFFER_CAP) out.commits.add(v.slice(0, 12));
  };
  walk(obj, null);
  return { thoughts: [...out.thoughts], commits: [...out.commits] };
}

/* A repository is known by its first commit, the same key the thought log
 * uses - the clone can move or be renamed and keep its trails. */
const keys = new Map();
function repoKey(dir) {
  if (keys.has(dir)) return keys.get(dir);
  let k = null;
  try {
    k = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').pop().slice(0, 16) || null;
  } catch (_) { /* not a repository, or no commits */ }
  if (!k) k = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
  keys.set(dir, k);
  return k;
}

function localAppData() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'gitx');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'gitx');
}

export class TrailRecorder {
  constructor() {
    this.session = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      + '-' + crypto.randomBytes(2).toString('hex');
    this.client = null;
    this.seq = 0;
    this.base = null;            // <data folder>/trails, once known
    this.pending = [];           // events waiting for the folder
    this.offeredAt = new Map();  // id -> seq of the answer that offered it
    this.files = new Set();      // files written this session, for the end marker
    this.warned = false;
    this.resolveBase();
  }

  /* The data folder: the env var, else ter-manager's folder for this plugin,
   * else local app data. Asked once; events wait for the answer. */
  async resolveBase() {
    let dir = process.env.GITX_DATA_DIR || null;
    if (!dir) {
      try {
        const host = process.env.TERMANAGER_URL || 'http://127.0.0.1:7070';
        const res = await fetch(host + '/api/plugins/data-dir?id=gitx', { signal: AbortSignal.timeout(2500) });
        if (res.ok) { const b = await res.json(); if (b && b.dir) dir = b.dir; }
      } catch (_) { /* ter-manager not running: fall through */ }
    }
    this.base = path.join(dir || localAppData(), 'trails');
    const waiting = this.pending;
    this.pending = [];
    for (const [repo, ev] of waiting) this.write(repo, ev);
  }

  start(clientInfo) {
    this.client = clientInfo && typeof clientInfo === 'object'
      ? { name: String(clientInfo.name || '').slice(0, 80) || null, version: String(clientInfo.version || '').slice(0, 40) || null }
      : null;
  }

  /* One tool call. Never throws: a recording that fails must not fail the
   * call it was recording. */
  record(tool, args, repoDir, result, error, ms) {
    try {
      const node = nodeOf(tool, args);
      const offered = error ? { thoughts: [], commits: [] } : offeredIn(result);
      const seq = ++this.seq;
      const id = node && node.id ? String(node.id) : null;
      const picked = id ? (this.offeredAt.get(id) ?? this.offeredAt.get(id.slice(0, 12)) ?? null) : null;
      for (const t of offered.thoughts) if (!this.offeredAt.has(t)) this.offeredAt.set(t, seq);
      for (const c of offered.commits) if (!this.offeredAt.has(c)) this.offeredAt.set(c, seq);
      this.write(repoDir, {
        v: VERSION, at: new Date().toISOString(), session: this.session, seq,
        client: this.client, tool, layer: LAYER[tool] || null, node,
        intent: intentOf(args), picked_from: picked,
        offered, ok: !error, error: error ? String(error.message || error).slice(0, 200) : undefined, ms
      });
    } catch (err) { this.warn(err); }
  }

  write(repoDir, ev) {
    if (!this.base) { this.pending.push([repoDir, ev]); return; }
    try {
      const dir = path.join(this.base, repoKey(repoDir));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, this.session + '.jsonl');
      if (!this.files.has(file)) {
        fs.appendFileSync(file, JSON.stringify({ v: VERSION, event: 'start', session: this.session, at: ev.at, repo: repoDir, client: this.client }) + '\n');
        this.files.add(file);
      }
      fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    } catch (err) { this.warn(err); }
  }

  /* Synchronous, because it runs on process exit. */
  end() {
    for (const file of this.files) {
      try { fs.appendFileSync(file, JSON.stringify({ v: VERSION, event: 'end', session: this.session, at: new Date().toISOString(), calls: this.seq }) + '\n'); } catch (_) {}
    }
  }

  warn(err) {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write('[GitX Trails] Recording failed and is now quiet for this session: ' + err.message + '\n');
  }
}

/* ------------------------------------------------------------ reading back */

export function trailHome(repoDir, dataDir) {
  return path.join(dataDir || localAppData(), 'trails', repoKey(repoDir));
}

export function readTrail(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

/* The owner's definition of acceptance: where the agent came in, every point
 * where it turned up or down to another layer, and where it left. Derived
 * here, from raw events, so the definition can change without a single
 * recording being rewritten. */
export function acceptedNodes(events) {
  const moves = events.filter((e) => e.layer && e.node && e.ok !== false);
  const out = [];
  moves.forEach((e, i) => {
    const next = moves[i + 1];
    const reasons = [];
    if (i === 0) reasons.push('came-in');
    if (next && next.layer !== e.layer) reasons.push(LEVEL[next.layer] > LEVEL[e.layer] ? 'turned-up' : 'turned-down');
    if (!next) reasons.push('left');
    if (reasons.length) out.push({ seq: e.seq, layer: e.layer, node: e.node, intent: e.intent, picked_from: e.picked_from, reasons });
  });
  return out;
}
