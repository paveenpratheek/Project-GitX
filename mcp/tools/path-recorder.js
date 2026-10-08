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
/* Code on top, as an agent walks the stack (t-6a7335ce0a): from the code down
 * to the commits that wrote it and the thoughts they settled. Context sits
 * beside the stack; for telling up from down it counts as below it. */
const LEVEL = { code: 4, commit: 3, thought: 2, context: 1 };

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
  rec.status = rec.started_by ? 'ended' : 'left';
  rec.ended_at = new Date().toISOString();
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return rec.status;
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

  /* One tool call, after its answer has gone. Never throws.
   *
   * Every call is kept, not only the ones after a gitx_related: GitX Logs show
   * an agent's movement, and most of it - find_related before a commit, the
   * record tool, a commit opened by hash - happens with no question asked
   * first (measured: 4 gitx_related against about 200 other GitX calls in one
   * session). A call with no path open starts a path of its own, with no
   * stack; it teaches nothing, since only a declare citing its own stack does
   * (learn.js). Each step carries the words the agent gave and what it got. */
  onCall(tool, args, repoDir, result, error, monitor) {
    try {
      const body = error ? null : parse(result);
      /* A question starts a path; opening a map entry (expand) is a step on
       * it, down to that function in the code layer. */
      if (tool === 'gitx_related' && !(args && args.expand)) {
        /* A follow-up keeps its path (t-2c70a44885): a refine step, and what
         * it brought joins the path's stack, so opening it next is on it. */
        const cur = this.current.get(repoDir);
        if (body && body.question === 'follow-up' && cur && !cur.ended_at && monitor) { this.refine(cur, args || {}, body, monitor); return; }
        if (body && !body.error && monitor) this.ask(repoDir, args || {}, monitor);
        return;
      }
      const step = stepOf(tool, args || {}, body, error) || { kind: 'call', tool };
      step.asked = wordsOf(tool, args || {}) || undefined;
      step.got = gotOf(body, error);
      let rec = this.current.get(repoDir);
      if (!rec || rec.ended_at) rec = this.open(repoDir, tool, step.asked);
      this.walk(rec, step);
    } catch (err) { this.warn(err); }
  }

  /* A follow-up on the path being walked: its words and what changed as a
   * step, and its nodes and links merged into the path's stack. The page is
   * sent the whole record again, so it redraws the stack with them. */
  refine(rec, args, body, monitor) {
    const have = new Set(rec.stack.nodes.map((n) => n.id));
    for (const n of (monitor.stack && monitor.stack.nodes) || []) if (!have.has(n.id)) { rec.stack.nodes.push(n); have.add(n.id); }
    const linked = new Set(rec.stack.links.map((l) => l.join(' ')));
    for (const l of (monitor.stack && monitor.stack.links) || []) if (!linked.has(l.join(' '))) rec.stack.links.push(l);
    const m = body.map || {};
    const words = [args.query, ...[].concat(args.add || []).map((w) => '+' + w), ...[].concat(args.drop || []).map((w) => '-' + w)].filter(Boolean).join(' ');
    this.walk(rec, {
      kind: 'refine', tool: 'gitx_related', asked: words || undefined, what: body.why,
      got: 'round ' + body.round + ': ' + (m.new || []).length + ' new, ' + (m.back || []).length + ' back, ' + (m.hidden || []).length + ' hidden, ' + (m.kept || 0) + ' kept' + (monitor.phases && monitor.phases.question && monitor.phases.question.prefetched ? ' - worked out before it was asked' : '')
    });
    this.send({ type: 'GITX_MONITOR', event: 'ask', repo: rec.repo, record: rec });
  }

  /* A path started by a call rather than a question: no stack to walk. */
  open(repoDir, tool, words) {
    const at = new Date().toISOString();
    const rec = {
      schema: SCHEMA,
      id: 'p-' + at.replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex'),
      repo: repoDir, at, agent: this.agent, client: this.client,
      started_by: tool,
      question: { query: words || null },
      gitx: null,
      stack: { nodes: [], links: [] },
      path: [],
      status: 'walking'
    };
    this.current.set(repoDir, rec);
    this.save(rec);
    this.send({ type: 'GITX_MONITOR', event: 'ask', repo: repoDir, record: rec });
    return rec;
  }

  ask(repoDir, args, monitor) {
    const prev = this.current.get(repoDir);
    if (prev && prev.status === 'walking') this.finish(prev, prev.started_by ? 'ended' : 're-asked');
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
    /* No stack, so nothing is on or off it: the call opened what it opened. */
    if (step.node && rec.started_by) step.move = 'open';
    else if (step.node) {
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
      /* Calls with no question have nothing to leave unanswered: they ended. */
      rec.status = rec.started_by ? 'ended' : 'left';
      rec.ended_at = new Date().toISOString();
      if (this.base) { try { fs.writeFileSync(path.join(pathsHome(rec.repo, this.base), rec.id + '.json'), JSON.stringify(rec, null, 2) + '\n'); } catch (_) {} }
      try { this.send({ type: 'GITX_MONITOR', event: 'status', repo: rec.repo, prompt: rec.id, status: rec.status }); } catch (_) {}
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
      /* Down to the code under the commit (t-4f0de6c907): the step lands on
       * the region asked for, or the one the commit changed most. */
      if (tool === 'gitx_graph_commit' && args.code && body && body.code && body.code.length) {
        const region = body.code[0].region;
        return { kind: 'open', tool, node: { id: 'code:' + region, layer: 'code', text: region, commit: String(body.short || args.hash) } };
      }
      return { kind: 'open', tool, node: { id: String(args.hash), layer: 'commit', text: body && body.subject ? String(body.subject).slice(0, 160) : undefined } };
    /* A function opened from the map: the code node the map drew for it. */
    case 'gitx_related': {
      const t = body && body.expanded && body.expanded[0];
      return t ? { kind: 'open', tool, node: { id: 'code:' + t.ref, layer: 'code', text: t.function } } : null;
    }
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

/* The words an agent gave a call: what it searched for, or what it named. */
const ASKED = ['query', 'description', 'text', 'subject', 'title', 'id', 'hash', 'commit', 'topic', 'name'];
function wordsOf(tool, args) {
  const cut = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 160);
  if (tool === 'gitx_thought_record') {
    const ts = Array.isArray(args.thoughts) ? args.thoughts : [];
    if (ts.length) return cut((ts.length > 1 ? ts.length + ' thoughts: ' : '') + (ts[0] && ts[0].text || ''));
    if (args.summary && args.summary.topic) return 'summary of ' + args.summary.topic;
  }
  const said = ASKED.filter((k) => args[k] != null && args[k] !== '').map((k) => args[k]);
  const files = [].concat(args.items || [], args.paths || [], args.ids || []).map(String);
  const words = [...said, ...files].join(' · ');
  if (words) return cut(words);
  const rest = Object.keys(args).filter((k) => k !== 'cwd');
  return rest.length ? cut(rest.map((k) => k + ' ' + JSON.stringify(args[k])).join(', ')) : null;
}

/* What a call gave back, in a line: refused, or how many of each list. */
function gotOf(body, error) {
  if (error) return 'error: ' + String(error.message || error).slice(0, 140);
  if (!body) return 'answered';
  if (body.error) return 'error: ' + String(body.error).slice(0, 140);
  if (body.ok === false) return 'refused: ' + String([].concat(body.problems || body.reason || '')[0] || '').slice(0, 140);
  if (body.thought && body.thought.id) return 'read ' + body.thought.id;
  const lists = Object.entries(body).filter(([, v]) => Array.isArray(v) && v.length).slice(0, 4).map(([k, v]) => v.length + ' ' + k.replace(/_/g, ' '));
  if (body.recorded) lists.unshift('recorded ' + body.recorded);
  return lists.length ? lists.join(' · ') : (body.nothing_on_record ? 'nothing on record' : 'answered');
}

/* The stack node a step landed on, if any: by id, a commit by its hash prefix,
 * and the thinking behind a commit by a settled result carried out in it. */
function inStackOf(stack, node) {
  const nodes = (stack && stack.nodes) || [];
  const id = String(node.id);
  if (node.behind) return nodes.find((n) => n.commit && (n.commit.startsWith(id.slice(0, 7)) || id.startsWith(n.commit))) || null;
  return nodes.find((n) => n.id === id || (n.layer === 'commit' && id.length >= 7 && (n.id.startsWith(id.slice(0, 8)) || id.startsWith(n.id)))) || null;
}
