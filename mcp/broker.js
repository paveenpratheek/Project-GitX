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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(DEFAULT_ROOT, '.gitx', 'state.json');
/* Overridable so a second instance can run beside a live one - otherwise the
 * only way to try a change is to stop the broker someone is using. */
const PORT = Number(process.env.GITX_BROKER_PORT) || 7771;

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
  projectGraph: null
};

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

function refreshFromGit(targetDir = null) {
  const dir = targetDir || state.activeRepo || DEFAULT_ROOT;
  if (!fs.existsSync(dir)) return;

  state.activeRepo = dir;
  state.activeRepoName = path.basename(dir) || dir;
  state.activeBranch = getBranch(dir);

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
const LOCAL_FILE = path.join(DEFAULT_ROOT, '.gitx', 'local.json');

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
  refreshFromGit(state.activeRepo);
}

function saveState() {
  try {
    writeJson(STATE_FILE, { issues: state.issues });
  } catch (err) {
    console.error('[GitX Broker] Failed to persist state.json:', err.message);
  }
  try {
    writeJson(LOCAL_FILE, { activeRepo: state.activeRepo });
  } catch (err) {
    console.error('[GitX Broker] Failed to persist local.json:', err.message);
  }
}

loadState();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

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
