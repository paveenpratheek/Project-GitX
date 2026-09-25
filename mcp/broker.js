import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { scanGitHistory } from './tools/chronicle-parser.js';
import { loadOrBuildIndex } from './tools/commit-index.js';
import { formThreads } from './tools/threads.js';
import { loadGraph, graphPayload } from './tools/project-graph.js';
import { loadThoughts, thoughtsPayload } from './tools/thoughts.js';
import { loadTopics, loadGoal, writeGoal, suggestTopics } from './tools/topics.js';
import { ThoughtWatcher, readLog } from './tools/thought-watch.js';
import { promotePending, describe as describePromotion } from './tools/promote.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(DEFAULT_ROOT, '.gitx', 'state.json');
/* Overridable so a second instance can run beside a live one - otherwise the
 * only way to try a change is to stop the broker someone is using. */
const PORT = Number(process.env.GITX_BROKER_PORT) || 7771;

/* The watcher: there is no gate on the thought files and cannot be one, so
 * what is kept instead is a record of every change, with the old values. Its
 * log lives outside the repository when a data folder is given
 * (GITX_DATA_DIR - ter-manager hands each plugin one), because a log beside
 * the files it watches is edited by whatever edited them. */
const watcher = new ThoughtWatcher({
  dataDir: process.env.GITX_DATA_DIR || null,
  context: () => ({ agents: Object.values(state.agents).filter((a) => a.status === 'Online').map((a) => a.id) }),
  /* A thought recorded, a topic or the goal changed: the page hears it now,
   * not at the next commit. The new signature is what makes it refetch. */
  onChange: () => {
    try { state.thoughtStats = thoughtStatsOf(state.activeRepo); } catch (_) { return; }
    broadcast({ type: 'SYNC_STATE', state });
  }
});

let state = {
  activeRepo: DEFAULT_ROOT,
  activeRepoName: path.basename(DEFAULT_ROOT),
  activeBranch: 'master',
  agents: {},
  issues: [],
  chronicles: [],
  streams: {},
  /* Threads are derived from code regions, declared scope and stated trailers -
   * so unlike `streams`, which only sees commits carrying a chronicle tag, they
   * cover every commit in the repository. Added ALONGSIDE chronicles rather
   * than replacing them: the Lakehouse view still reads those. */
  threads: [],
  threadLinks: [],
  statedRelations: [],
  threadStats: null,
  /* What graph.html draws: commits with their messages in force (.gitx/commits
   * where written, git otherwise), lines of work, threads and stated links. */
  projectGraph: null,
  /* Counts and a change signature only. The thoughts themselves are served by
   * /api/thoughts on request - they are the one payload here that holds
   * unconfirmed reasoning, and too large to ship with every SYNC_STATE. */
  thoughtStats: null
};

/* The page refetches the thoughts when this signature moves, so it covers
 * both graphs: a thought written to the context graph, or one promoted out of
 * it, has to reach the page as surely as one in the thought graph. The
 * context map's topics and goal are in it too. */
function thoughtStatsOf(dir) {
  const graph = loadThoughts(dir).stats;
  const context = loadThoughts(dir, { store: 'context' }).stats;
  const map = Math.round(Math.max(loadTopics(dir).newest, loadGoal(dir).newest));
  return { ...graph, context: { count: context.count, skipped: context.skipped }, signature: graph.signature + '|' + context.signature + '|' + map };
}

function getBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (_) {
    return 'main';
  }
}

function getHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
}

/* HEAD moves without GitX being told.
 *
 * The broker re-read git only when it started, when the repository changed,
 * or when a commit came through gitx_commit_chronicle. A commit made from
 * ter-manager's Source Control or the command line, and a branch switch, went
 * unnoticed - so the page kept drawing the history it had, under a header
 * that already named the new branch.
 *
 * Git records where HEAD is in two places: the HEAD file (which branch, or
 * which commit when detached) and the branch tips under refs/heads, plus
 * packed-refs. Those are watched and nothing else - the index changes on
 * every stage, and re-reading history for that would be most of the work for
 * none of the news. A burst (a rebase moves HEAD many times) settles before
 * anything is re-read, and nothing is re-read unless HEAD or the branch
 * actually changed. */
let headWatchers = [];
let headWatchedDir = null;
let headTimer = null;
function watchHead(dir) {
  if (headWatchedDir === dir && headWatchers.length) return;
  for (const w of headWatchers) { try { w.close(); } catch (_) {} }
  headWatchers = [];
  headWatchedDir = dir;
  let gitDir, common;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    common = path.resolve(dir, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch (_) { return; }   // not a repository: nothing to watch
  const moved = () => {
    clearTimeout(headTimer);
    headTimer = setTimeout(() => {
      if (state.activeRepo !== dir) return;
      const head = getHead(dir), branch = getBranch(dir);
      if (head === state.head && branch === state.activeBranch) return;
      console.log('[GitX Broker] HEAD moved outside GitX (' + String(state.head || '').slice(0, 7) + ' ' + state.activeBranch
        + ' -> ' + String(head || '').slice(0, 7) + ' ' + branch + '); re-reading.');
      refreshFromGit(dir);
      broadcast({ type: 'SYNC_STATE', state });
    }, 400);
  };
  const watchOne = (target, recursive, keep) => {
    try {
      const w = fs.watch(target, { recursive }, (ev, name) => { if (!keep || keep(String(name || ''))) moved(); });
      w.on('error', () => { /* a folder that goes away is not a crash */ });
      headWatchers.push(w);
    } catch (_) { /* unwatchable: the manual refresh still works */ }
  };
  watchOne(gitDir, false, (n) => n === 'HEAD');
  watchOne(common, false, (n) => n === 'packed-refs');
  watchOne(path.join(common, 'refs', 'heads'), true, null);
}

function refreshFromGit(targetDir = null) {
  const dir = targetDir || state.activeRepo || DEFAULT_ROOT;
  if (!fs.existsSync(dir)) return;

  state.activeRepo = dir;
  state.activeRepoName = path.basename(dir) || dir;
  state.activeBranch = getBranch(dir);
  state.head = getHead(dir);
  watchHead(dir);

  console.log(`[GitX Broker] Scanning Git history for '${state.activeRepoName}' (${dir}) on branch [${state.activeBranch}]`);
  const gitCommits = scanGitHistory(dir, 100);

  // Replace chronicles with the active repository's commits
  state.chronicles = gitCommits;

  // Re-index streams map for the active repository
  state.streams = {};
  for (const c of state.chronicles) {
    const sName = c.stream || 'Core';
    if (!state.streams[sName]) state.streams[sName] = [];
    state.streams[sName].push(c.commitHash);
  }

  /* Thread formation, from the commit index rather than the chronicle tags.
   * Wrapped because it must never take the broker down: a repo it cannot index
   * should still get agents, issues and the Lakehouse view, just no threads. */
  try {
    const t0 = Date.now();
    const { index, rebuilt } = loadOrBuildIndex(dir);
    const { threads, loose, links, relations, stats } = formThreads(index);
    state.threads = threads;
    state.threadLinks = links;
    state.statedRelations = relations;
    state.threadStats = { ...stats, loose: loose.length, commits: index.count, ms: Date.now() - t0 };
    console.log(`[GitX Broker] ${threads.length} threads over ${index.count} commits ` +
      `(${loose.length} unthreaded, ${links.length} inter-thread links, ${relations.length} stated relations, ` +
      `index ${rebuilt ? 'rebuilt' : 'cached'}, ${Date.now() - t0}ms).`);
  } catch (err) {
    state.threads = [];
    state.threadLinks = [];
    state.statedRelations = [];
    state.threadStats = { error: err.message };
    console.warn('[GitX Broker] Thread formation failed, continuing without it:', err.message);
  }

  /* Same rule as threads: a repo the graph cannot be built for still gets
   * everything else. The page shows the error instead of a blank canvas. */
  try {
    const t0 = Date.now();
    state.projectGraph = graphPayload(loadGraph(dir));
    console.log(`[GitX Broker] Graph: ${state.projectGraph.commits.length} commits, ${state.projectGraph.roots.length} lines of work, ` +
      `${state.projectGraph.stats.messages_from_gitx} messages from .gitx/commits (${Date.now() - t0}ms).`);
  } catch (err) {
    state.projectGraph = { error: err.message };
    console.warn('[GitX Broker] Graph build failed, continuing without it:', err.message);
  }

  try {
    state.thoughtStats = thoughtStatsOf(dir);
    watcher.open(dir);
  } catch (err) {
    state.thoughtStats = { error: err.message };
    console.warn('[GitX Broker] Thought layer failed to load, continuing without it:', err.message);
  }

  /* A commit that names thoughts in a GitX-Thoughts trailer settles them.
   * AFTER the watcher is open, so each move is recorded as it happens: run
   * first, the watcher's reconcile at open found the moves and logged them as
   * made while nothing watched, which was untrue - and it reopens on every
   * refresh, so that was every promotion. Scans recent history, so a commit
   * made while the broker was down is still settled. */
  try {
    const promoted = promotePending(dir);
    for (const r of promoted) console.log('[GitX Broker] Promoted for ' + describePromotion(r));
    if (promoted.some((r) => r.promoted.length || r.brought.length)) state.thoughtStats = thoughtStatsOf(dir);
  } catch (err) {
    console.warn('[GitX Broker] Promotion failed, nothing more was moved: ' + err.message);
  }

  saveState();
  console.log(`[GitX Broker] Loaded ${state.chronicles.length} commits across ${Object.keys(state.streams).length} streams for '${state.activeRepoName}'.`);
}

/* Two files, split by who they belong to.
 *
 *   state.json  the issue list - shared project data, tracked in git
 *   local.json  which repo this broker is showing - a path on THIS machine,
 *               git-ignored
 *
 * They used to be one file, so every time the graph was opened on a different
 * repository the tracked file changed, and Source Control showed a modified
 * state.json that nobody had edited and nobody should commit. */
/* Overridable for the same reason as the port: a second broker opened on
 * another repository must not rewrite which one the live broker opens next. */
const LOCAL_FILE = process.env.GITX_LOCAL_FILE || path.join(DEFAULT_ROOT, '.gitx', 'local.json');

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[GitX Broker] Failed to read ' + path.basename(file) + ', ignoring it:', err.message);
  }
  return null;
}

function writeJson(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(obj, null, 2);
  /* Unchanged content is not rewritten, so saving the same issue list after
   * every refresh does not touch the file's mtime or show up as activity. */
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (_) { /* new file */ }
  fs.writeFileSync(file, text, 'utf8');
}

function loadState() {
  const shared = readJson(STATE_FILE);
  const local = readJson(LOCAL_FILE);
  if (shared) state.issues = shared.issues || [];
  state.agents = {};
  /* local.json first; an older state.json that still carries activeRepo is
   * honoured once, and the next save moves it across. */
  state.activeRepo = (local && local.activeRepo) || (shared && shared.activeRepo) || DEFAULT_ROOT;
  /* A folder remembered from last time, so a restart writes its log where the
   * last one did without asking anybody. */
  if (!watcher.dataDir && local && local.dataDir) watcher.dataDir = local.dataDir;
  refreshFromGit(state.activeRepo);
}

function saveState() {
  try {
    writeJson(STATE_FILE, { issues: state.issues });
  } catch (err) {
    console.error('[GitX Broker] Failed to persist state.json:', err.message);
  }
  try {
    writeJson(LOCAL_FILE, { activeRepo: state.activeRepo, dataDir: watcher.dataDir || undefined });
  } catch (err) {
    console.error('[GitX Broker] Failed to persist local.json:', err.message);
  }
}

loadState();

/* Where the watcher's log goes, without anyone having to say so.
 *
 * The log must live outside the repository it watches, and the host already
 * keeps a folder for every plugin under the save directory - so ask it, once,
 * and remember the answer in local.json. GITX_DATA_DIR still wins when it is
 * set, and a host that is not running, or has no save directory, leaves the
 * log in .gitx/thought-log/ where the ignore rules already keep it private.
 *
 * No Origin header is sent by this process, which ter-manager treats as local
 * by construction - a browser is the confused deputy its check is about. */
async function findDataDir() {
  if (watcher.dataDir) return;
  const host = process.env.TERMANAGER_URL || 'http://127.0.0.1:7070';
  try {
    const res = await fetch(host + '/api/plugins/data-dir?id=gitx', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 409 ? ' - no save directory is set in ter-manager' : ''));
    const body = await res.json();
    if (!body || !body.dir) throw new Error('no folder in the answer');
    watcher.dataDir = body.dir;
    console.log('[GitX Broker] Thought log:', body.dir);
    saveState();
    if (state.activeRepo) watcher.open(state.activeRepo);
  } catch (err) {
    console.log('[GitX Broker] Thought log stays in the repository (' + err.message + ').');
  }
}
findDataDir();

/* The whole API is for this machine: the state carries the active repo's
 * absolute path, commit bodies and the issue specs, and the socket accepts
 * CREATE_ISSUE and SET_ACTIVE_REPO. So a request that carries an Origin must
 * come from a loopback page (the GitX plugin is served from 127.0.0.1:7070).
 * No Origin at all (curl, an agent, the MCP server's socket) is local by
 * construction - the broker only listens on 127.0.0.1 - and a browser always
 * sends one cross-origin, so no page can get in by leaving it off.
 * A `null` origin (sandboxed iframe, file://) is refused: any site can
 * produce one. */
function originAllowed(origin) {
  if (!origin) return true;
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname); } catch (_) { return false; }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!originAllowed(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'the GitX broker serves local pages only' }));
    return;
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'gitx-broker',
      port: PORT,
      activeRepo: state.activeRepo,
      activeRepoName: state.activeRepoName,
      activeBranch: state.activeBranch,
      agents: Object.keys(state.agents).length
    }));
    return;
  }

  if (req.url === '/api/refresh') {
    refreshFromGit();
    broadcast({ type: 'SYNC_STATE', state });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: state.chronicles.length, repo: state.activeRepoName }));
    return;
  }

  /* Drafts are reasoning nobody has confirmed yet; the Origin check at the top
   * of this handler is what keeps them off other sites' pages. */
  /* The log reads under the same rule as the thoughts themselves: local pages
   * only. It holds what a thought used to say, which is as private as the
   * thought. */
  if (req.url.split('?')[0] === '/api/thoughts/log') {
    const origin = req.headers.origin;
    let loopback = false;
    try { loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname); } catch (_) {}
    res.setHeader('Vary', 'Origin');
    if (origin && !loopback) {
      res.removeHeader('Access-Control-Allow-Origin');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'the thought log is served to local pages only' }));
      return;
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    try {
      const body = JSON.stringify(readLog(state.activeRepo, {
        id: q.get('id'), limit: Number(q.get('limit')) || 50, dataDir: watcher.dataDir || null
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url.split('?')[0] === '/api/thoughts') {
    try {
      const body = JSON.stringify(thoughtsPayload(state.activeRepo));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  /* The context map's controls. Local pages only, like every route here (the
   * Origin check at the top). The goal decides what agents read, so a change
   * is checked whole before it is written, and the watcher records it. */
  if (req.url.split('?')[0] === '/api/context/suggest') {
    const text = new URL(req.url, 'http://127.0.0.1').searchParams.get('text') || '';
    try {
      const thoughts = loadThoughts(state.activeRepo, { store: 'context' }).thoughts;
      const body = JSON.stringify(suggestTopics(text, thoughts, loadTopics(state.activeRepo).topics));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/context/goal' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on('end', () => {
      let patch;
      try { patch = JSON.parse(raw || '{}'); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, problems: ['the body is not JSON'] }));
        return;
      }
      try {
        const r = writeGoal(state.activeRepo, { text: patch.text, topics: patch.topics, domains_off: patch.domains_off }, { by: 'user' });
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        if (r.ok) {
          state.thoughtStats = thoughtStatsOf(state.activeRepo);
          broadcast({ type: 'SYNC_STATE', state });
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, problems: [err.message] }));
      }
    });
    return;
  }

  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

/* WebSockets are not covered by CORS at all - a foreign page can open one to
 * any address - so the upgrade gets the same Origin rule as the HTTP routes.
 * Refused with 403 before the connection is accepted or any state is sent. */
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => originAllowed(origin)
});

function broadcast(msg, senderWs = null) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== senderWs) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'SYNC_STATE', state }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg, ws);
    } catch (err) {
      console.error('[GitX Broker] Malformed message:', err.message);
    }
  });

  ws.on('close', () => {
    if (ws.agentId && state.agents[ws.agentId]) {
      state.agents[ws.agentId].status = 'Offline';
      state.agents[ws.agentId].lastSeen = new Date().toISOString();
      broadcast({ type: 'AGENT_OFFLINE', agentId: ws.agentId });
    }
  });
});

function handleMessage(msg, ws) {
  switch (msg.type) {
    case 'SET_ACTIVE_REPO': {
      const rawRepo = msg.repoPath;
      if (rawRepo) {
        const normNew = path.resolve(rawRepo);
        const normCurrent = state.activeRepo ? path.resolve(state.activeRepo) : '';
        if (fs.existsSync(normNew) && (msg.force || normNew.toLowerCase() !== normCurrent.toLowerCase())) {
          console.log(`[GitX Broker] Switching active project to: ${normNew}`);
          refreshFromGit(normNew);
          broadcast({ type: 'SYNC_STATE', state });
        }
      }
      break;
    }

    case 'REGISTER_AGENT': {
      const { agentId, name, model, pid, repoRoot, branch } = msg;
      ws.agentId = agentId;
      state.agents[agentId] = {
        id: agentId,
        name: name || agentId,
        model: model || 'Unknown Model',
        pid: pid || null,
        repoRoot: repoRoot || state.activeRepo,
        branch: branch || state.agents[agentId]?.branch || state.activeBranch || 'main',
        status: 'Online',
        currentTask: null,
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      };
      broadcast({ type: 'AGENT_REGISTERED', agent: state.agents[agentId] });
      ws.send(JSON.stringify({ type: 'REGISTER_OK', agent: state.agents[agentId] }));
      break;
    }

    case 'ASSIGN_BRANCH': {
      const { agentId, branch, issueId } = msg;
      if (state.agents[agentId]) {
        state.agents[agentId].branch = branch;
        if (issueId) {
          const issue = state.issues.find(i => i.id === issueId);
          if (issue) {
            state.agents[agentId].currentTask = issue.title;
            issue.assignedTo = agentId;
            issue.status = 'In Progress';
          }
        }
        broadcast({ type: 'AGENT_UPDATED', agent: state.agents[agentId], issues: state.issues });
        saveState();
      }
      break;
    }

    case 'CREATE_ISSUE': {
      const issueNumber = state.issues.length + 1;
      const issue = {
        id: 'issue-' + Date.now(),
        number: issueNumber,
        title: msg.title || ('Untitled Task #' + issueNumber),
        branch: msg.branch || ('feat/task-' + issueNumber),
        prompt_spec: msg.prompt_spec || '',
        source_branch: msg.source_branch || state.activeBranch || 'main',
        worktreePath: msg.worktreePath || state.activeRepo,
        repoPath: state.activeRepo,
        status: 'Open',
        assignedTo: null,
        createdAt: new Date().toISOString(),
        createdBy: msg.agentId || 'User'
      };
      state.issues.unshift(issue);
      saveState();
      broadcast({ type: 'ISSUE_CREATED', issue, issues: state.issues });
      ws.send(JSON.stringify({ type: 'ISSUE_CREATED_OK', issue }));
      break;
    }

    case 'COMMIT_CHRONICLE': {
      const chronicle = {
        id: 'git-' + (msg.commitHash ? msg.commitHash.slice(0, 12) : Date.now().toString(16)),
        commitHash: msg.commitHash || ('local-' + Date.now().toString(16)),
        branch: msg.branch || state.activeBranch || 'main',
        agentId: msg.agentId || 'Unknown',
        stream: msg.stream || 'Core',
        summary: msg.summary || 'feat: update codebase',
        motive: msg.motive || '',
        architecture: msg.architecture || '',
        filesManifest: msg.filesManifest || [],
        verification: msg.verification || '',
        timestamp: new Date().toISOString(),
        isChronicle: true
      };

      state.chronicles.unshift(chronicle);
      if (!state.streams[chronicle.stream]) state.streams[chronicle.stream] = [];
      state.streams[chronicle.stream].push(chronicle.commitHash);

      broadcast({ type: 'CHRONICLE_COMMITTED', chronicle, state });
      ws.send(JSON.stringify({ type: 'CHRONICLE_OK', chronicle }));
      break;
    }

    case 'REFRESH_HISTORY': {
      refreshFromGit();
      broadcast({ type: 'SYNC_STATE', state });
      break;
    }

    case 'GET_TASK': {
      const { agentId } = msg;
      const agent = state.agents[agentId];
      if (!agent) {
        ws.send(JSON.stringify({ type: 'TASK_INFO', task: null }));
        return;
      }
      const task = state.issues.find(i => (i.assignedTo === agentId || i.branch === agent.branch) && i.status !== 'Closed');
      ws.send(JSON.stringify({ type: 'TASK_INFO', task, agent }));
      break;
    }

    default:
      console.warn('[GitX Broker] Unknown message type:', msg.type);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('===========================================================');
  console.log('  GitX Local Event Broker running on http://127.0.0.1:' + PORT);
  console.log('  WebSocket endpoint: ws://127.0.0.1:' + PORT);
  console.log(`  Initial Active Repo: '${state.activeRepoName}' (${state.activeRepo})`);
  console.log('===========================================================');
});
