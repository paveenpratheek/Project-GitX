import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { scanGitHistory } from './tools/chronicle-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(DEFAULT_ROOT, '.gitx', 'state.json');
const PORT = 7771;

let state = {
  activeRepo: DEFAULT_ROOT,
  activeRepoName: path.basename(DEFAULT_ROOT),
  activeBranch: 'master',
  agents: {},
  issues: [],
  chronicles: [],
  streams: {}
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

  saveState();
  console.log(`[GitX Broker] Loaded ${state.chronicles.length} commits across ${Object.keys(state.streams).length} streams for '${state.activeRepoName}'.`);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.issues = raw.issues || [];
      state.activeRepo = raw.activeRepo || DEFAULT_ROOT;
      state.agents = {};
    }
  } catch (err) {
    console.warn('[GitX Broker] Failed to read state.json, starting fresh:', err.message);
  }
  refreshFromGit(state.activeRepo);
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activeRepo: state.activeRepo,
      issues: state.issues
    }, null, 2), 'utf8');
  } catch (err) {
    console.error('[GitX Broker] Failed to persist state.json:', err.message);
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
      const newRepo = msg.repoPath;
      if (newRepo && fs.existsSync(newRepo) && newRepo !== state.activeRepo) {
        console.log(`[GitX Broker] Switching active project to: ${newRepo}`);
        refreshFromGit(newRepo);
        broadcast({ type: 'SYNC_STATE', state });
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
