/*
 * Path recorder: for each prompt an agent asks GitX, what GitX did with it and
 * the path the agent then took - kept per prompt, not as a trail of every call
 * (t-50e40ce534, which replaced the trail recorder), and streamed to the broker
 * as it happens for GitX Monitor's live view (t-0156b1d6c5).
 *
 *   <GitX data folder>/paths/<repo key>/<prompt id>.json     gitx.path/0
 *
 *   question   the agent's words, ids, paths, topic and filters
 *   gitx       processing, search, results, filtering - counts and timings
 *   stack      the answer arranged in the layers: nodes and the links between them
 *   path       each move after it, in order: the node, its layer, whether it was
 *              in the stack, and the move - enter, along, up, down, off
 *   status     walking, then declared, re-asked or left
 *
 * A prompt starts with gitx_related; every GitX call after it, until the next
 * one, is a step on its path. Self-contained like the trails were: server.js
 * calls it in two places, it never fails a call, and it writes only its own
 * folder - never inside a repository, since a path names private thoughts and
 * carries the agent's words.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SCHEMA = 'gitx.path/0';
/* Context sits beside L3; for telling up from down it counts as above it. */
const LEVEL = { context: 4, thought: 3, commit: 2, code: 1 };

/* A repository is known by its first commit, as the thought log knows it, so a
 * clone can move or be renamed and keep its paths. */
const keys = new Map();
export function repoKey(dir) {
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

export function pathsHome(repoDir, dataDir) {
  return path.join(dataDir || localAppData(), 'paths', repoKey(repoDir));
}

/* The newest first, for GitX Monitor's history. A file that is not a path is
 * skipped; it never stops the rest from being read. */
export function readPaths(repoDir, dataDir, limit = 50) {
  const dir = pathsHome(repoDir, dataDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of names) {
    try { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (p && p.schema === SCHEMA) out.push(p); } catch (_) { /* half-written or foreign */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

/* A prompt whose agent went away mid-walk: its process was ended, so its own
 * exit handler never ran. The broker sees the connection close and calls this.
 * Only a prompt still walking changes - one already declared or re-asked keeps
 * how it ended. Returns true when it changed the record. */
export function markLeft(repoDir, dataDir, id) {
  const file = path.join(pathsHome(repoDir, dataDir), id + '.json');
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
  if (!rec || rec.status !== 'walking') return false;
  rec.status = 'left';
  rec.ended_at = new Date().toISOString();
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return true;
}

const parse = (result) => { try { return JSON.parse(result.content[0].text); } catch (_) { return null; } };
const shortOf = (id) => (/^[0-9a-f]{7,40}$/.test(id) ? id.slice(0, 8) : id);

export class PathRecorder {
  /* send: hands an event to the broker for the live view.
   * dataDir: the folder the broker uses, when it can be known without asking. */
  constructor({ send = () => {}, dataDir = () => null } = {}) {
    this.send = send;
    this.client = null;
    this.agent = null;
    this.base = null;
    this.pending = [];
    this.current = new Map();      // repo -> the prompt being walked
    this.warned = false;
    this.resolveBase(dataDir);
  }

  /* The broker's own data folder first - the env var or its local.json - so
   * GitX Monitor's history reads where this writes; else ter-manager's folder
   * for the plugin; else local app data. Saves wait for the answer. */
  async resolveBase(dataDir) {
    let dir = null;
    try { dir = dataDir(); } catch (_) { /* fall through */ }
    if (!dir) {
      try {
        const host = process.env.TERMANAGER_URL || 'http://127.0.0.1:7070';
        const res = await fetch(host + '/api/plugins/data-dir?id=gitx', { signal: AbortSignal.timeout(2500) });
        if (res.ok) { const b = await res.json(); if (b && b.dir) dir = b.dir; }
      } catch (_) { /* ter-manager not running */ }
    }
    this.base = dir || localAppData();
    const waiting = this.pending;
    this.pending = [];
    for (const rec of waiting) this.save(rec);
  }

  start(clientInfo, agent) {
    this.client = clientInfo && typeof clientInfo === 'object'
      ? { name: String(clientInfo.name || '').slice(0, 80) || null, version: String(clientInfo.version || '').slice(0, 40) || null }
      : null;
    this.agent = agent || null;
  }

  /* One tool call, after its answer has gone. Never throws. */
  onCall(tool, args, repoDir, result, error, monitor) {
    try {
      const body = error ? null : parse(result);
      if (tool === 'gitx_related') {
        if (body && !body.error && monitor) this.ask(repoDir, args || {}, monitor);
        return;
      }
      const rec = this.current.get(repoDir);
      if (!rec) return;
      const step = stepOf(tool, args || {}, body, error);
      if (!step) return;
      this.walk(rec, step);
    } catch (err) { this.warn(err); }
  }

  ask(repoDir, args, monitor) {
    const prev = this.current.get(repoDir);
    if (prev && prev.status === 'walking') this.finish(prev, 're-asked');
    const at = new Date().toISOString();
    const rec = {
      schema: SCHEMA,
      id: 'p-' + at.replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex'),
      repo: repoDir, at, agent: this.agent, client: this.client,
      question: {
        query: String(args.query || '') || null, ids: args.ids || undefined, paths: args.paths || undefined,
        topic: args.topic || undefined, layers: args.layers || undefined, outcome: args.outcome || undefined, kind: args.kind || undefined
      },
      gitx: monitor.phases,
      stack: monitor.stack,
      path: [],
      status: 'walking'
    };
    this.current.set(repoDir, rec);
    this.save(rec);
    this.send({ type: 'GITX_MONITOR', event: 'ask', repo: repoDir, record: rec });
  }

  walk(rec, step) {
    step.at = new Date().toISOString();
    if (step.node) {
      const inStack = inStackOf(rec.stack, step.node);
      const prev = [...rec.path].reverse().find((s) => s.node && s.in_stack);
      step.in_stack = !!inStack;
      if (inStack) step.node.id = inStack.id;
      if (!step.node.layer && inStack) step.node.layer = inStack.layer;
      step.move = !step.in_stack ? 'off'
        : !prev ? 'enter'
        : LEVEL[step.node.layer] > LEVEL[prev.node.layer] ? 'up'
        : LEVEL[step.node.layer] < LEVEL[prev.node.layer] ? 'down' : 'along';
    }
    if (step.kind === 'declare') {
      const ids = new Set(rec.stack.nodes.map((n) => n.id));
      step.cited_in_stack = (step.cites || []).filter((c) => ids.has(shortOf(c)) || ids.has(c));
      rec.status = 'declared';
    }
    step.n = rec.path.length + 1;
    rec.path.push(step);
    this.save(rec);
    this.send({ type: 'GITX_MONITOR', event: 'move', repo: rec.repo, prompt: rec.id, step, status: rec.status });
  }

  finish(rec, status) {
    rec.status = status;
    rec.ended_at = new Date().toISOString();
    this.save(rec);
    this.send({ type: 'GITX_MONITOR', event: 'status', repo: rec.repo, prompt: rec.id, status });
  }

  save(rec) {
    if (!this.base) { if (!this.pending.includes(rec)) this.pending.push(rec); return; }
    try {
      const dir = pathsHome(rec.repo, this.base);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, rec.id + '.json');
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (err) { this.warn(err); }
  }

  /* Synchronous, because it runs on process exit: a prompt still being walked
   * when the session ends is one the agent left. */
  end() {
    for (const rec of this.current.values()) {
      if (rec.status !== 'walking') continue;
      rec.status = 'left';
      rec.ended_at = new Date().toISOString();
      if (this.base) { try { fs.writeFileSync(path.join(pathsHome(rec.repo, this.base), rec.id + '.json'), JSON.stringify(rec, null, 2) + '\n'); } catch (_) {} }
      try { this.send({ type: 'GITX_MONITOR', event: 'status', repo: rec.repo, prompt: rec.id, status: 'left' }); } catch (_) {}
    }
  }

  warn(err) {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write('[GitX Paths] Recording failed and is now quiet for this session: ' + err.message + '\n');
  }
}

/* What one call after a prompt was, as a step on its path. */
function stepOf(tool, args, body, error) {
  if (error) return null;
  switch (tool) {
    case 'gitx_thought': {
      if (args.id) {
        if (!body || !body.thought) return null;
        const layer = body.graph === 'thought graph' ? 'thought' : body.graph === 'context graph' ? 'context' : null;
        return { kind: 'open', tool, node: { id: body.thought.id || args.id, layer, text: String(body.thought.text || '').slice(0, 160) } };
      }
      /* The thinking behind a commit: the step up from that commit. */
      if (args.commit) return { kind: 'open', tool, node: { id: String(args.commit), layer: 'thought', behind: true } };
      return { kind: 'list', tool, what: args.stashes ? 'stashes' : [].concat(args.outcome || [], args.kind || [], args.reopenable ? ['reopenable'] : []).join(', ') };
    }
    case 'gitx_graph_commit':
    case 'gitx_graph_chain':
      if (!args.hash) return null;
      return { kind: 'open', tool, node: { id: String(args.hash), layer: 'commit', text: body && body.commit ? String(body.commit.subject || '').slice(0, 160) : undefined } };
    case 'gitx_graph_area':
    case 'gitx_graph_map':
      return { kind: 'overview', tool, what: args.name || 'map' };
    case 'gitx_thought_record': {
      if (!body || !body.ok) return null;
      const recorded = (body.thoughts || []).map((t) => t.id);
      const cites = [];
      for (const t of args.thoughts || []) {
        for (const l of t.links || []) cites.push(String(l.to));
        for (const f of t.forces || []) for (const c of f.cites || []) cites.push(String(c));
      }
      return { kind: 'declare', tool, recorded, cites: [...new Set(cites)].filter((c) => /^t-|^[0-9a-f]{7,40}$/.test(c)) };
    }
    case 'gitx_find_related':
    case 'gitx_thought_catch_up':
    case 'gitx_thought_history':
      return { kind: 'other', tool };
    default:
      return null;
  }
}

/* The stack node a step landed on, if any: by id, a commit by its hash prefix,
 * and the thinking behind a commit by a settled result carried out in it. */
function inStackOf(stack, node) {
  const nodes = (stack && stack.nodes) || [];
  const id = String(node.id);
  if (node.behind) return nodes.find((n) => n.commit && (n.commit.startsWith(id.slice(0, 7)) || id.startsWith(n.commit))) || null;
  return nodes.find((n) => n.id === id || (n.layer === 'commit' && id.length >= 7 && (n.id.startsWith(id.slice(0, 8)) || id.startsWith(n.id)))) || null;
}
