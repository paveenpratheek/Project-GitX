import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

import { scanPreCommit } from './tools/guardrails.js';
import { ensureWorktree, listWorktrees } from './tools/worktree-manager.js';
import { scanGitHistory } from './tools/chronicle-parser.js';

const __filename = fileURLToPath(import.meta.url);
function getRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return process.cwd();
  }
}

const ROOT_DIR = getRepoRoot();

/* Every read tool used to be locked to ROOT_DIR - computed ONCE, from
 * wherever this process happened to be spawned, with no way to ask about a
 * different repository afterward. A session spawned from inside another
 * project got that project's history back for every query, silently:
 * gitx_search_chronicle("gitx") returned commits from the WRONG repo, with
 * no error and a plausible-looking result, which is the expensive kind of
 * wrong - it costs nothing to hit and nothing to notice.
 *
 * cwd resolves per call now, but only for the two tools that actually
 * SCAN a repository's history - search_chronicle and get_swarm_status.
 * GitX's own bookkeeping (.gitx/state.json - the issue list, the agent
 * registry) stays anchored to ROOT_DIR regardless: it is GitX's own
 * database, not a property of whichever repo someone asked to search, and
 * letting cwd move it too would mean asking about a different project's
 * commits also silently swapped which project's ISSUE LIST you were
 * looking at - a much bigger and more surprising change than was asked
 * for. Worktree creation has the same problem and is NOT fixed here -
 * flagged separately, since it needs its own answer about where a
 * worktree for someone else's repo should actually live. */
function resolveTargetRepo(cwd) {
  if (cwd && typeof cwd === 'string') {
    const resolved = path.resolve(cwd);
    if (fs.existsSync(resolved)) return { dir: resolved, requested: cwd, ok: true };
    return { dir: ROOT_DIR, requested: cwd, ok: false };
  }
  return { dir: ROOT_DIR, requested: null, ok: true };
}
const BROKER_WS = 'ws://127.0.0.1:7771';

const AGENT_ID = process.env.GITX_AGENT_ID || ('agent-' + process.pid);
const AGENT_NAME = process.env.GITX_AGENT_NAME || ('Agent ' + process.pid);
const AGENT_MODEL = process.env.GITX_AGENT_MODEL || 'Antigravity/Claude';

let brokerWs = null;
let brokerReady = false;

function connectBroker() {
  try {
    brokerWs = new WebSocket(BROKER_WS);

    brokerWs.on('open', () => {
      brokerReady = true;
      process.stderr.write('[GitX MCP] Connected to GitX Broker at ' + BROKER_WS + '\n');
      brokerWs.send(JSON.stringify({
        type: 'REGISTER_AGENT',
        agentId: AGENT_ID,
        name: AGENT_NAME,
        model: AGENT_MODEL,
        pid: process.pid
      }));
    });

    brokerWs.on('error', () => {
      brokerReady = false;
    });

    brokerWs.on('close', () => {
      brokerReady = false;
      setTimeout(connectBroker, 3000);
    });
  } catch (_) {
    brokerReady = false;
  }
}

connectBroker();

function sendToBroker(payload) {
  if (brokerWs && brokerReady) {
    try { brokerWs.send(JSON.stringify(payload)); } catch (_) {}
  }
}

const TOOLS = [
  {
    name: 'gitx_get_assigned_task',
    description: 'Retrieves the task, feature prompt specification, assigned branch, and isolated worktree path allocated to this agent in GitX.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'gitx_create_issue_with_branch',
    description: 'Creates a new GitHub/GitX issue with a feature specification prompt, provisions an isolated Git branch and physical worktree on disk, and enables another agent to work on it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Clear title for the issue/task' },
        branch: { type: 'string', description: 'Git branch name (e.g. feat/customizable-ui)' },
        prompt_spec: { type: 'string', description: 'Comprehensive prompt specification that the assigned agent will consume to implement the feature' },
        source_branch: { type: 'string', description: 'Base branch to branch off from (defaults to current or main)' }
      },
      required: ['title', 'branch', 'prompt_spec']
    }
  },
  {
    name: 'gitx_commit_chronicle',
    description: 'Executes a real Git commit in the local repository or worktree using the structured 4-layer Chronicle format. Runs Secret Shield pre-commit verification and enforces the Push Shield.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Standard conventional commit summary (e.g. feat: implement token refresh)' },
        stream: { type: 'string', description: 'The semantic feature stream (e.g. Feature-Auth, UI, Core)' },
        motive: { type: 'string', description: 'Layer 1: The user prompt or task goal that motivated this change' },
        architecture: { type: 'string', description: 'Layer 2: Architectural decisions, trade-offs, patterns chosen and why' },
        files_manifest: {
          type: 'array',
          items: { type: 'string' },
          description: 'Layer 3: List of relative file paths to stage and commit'
        },
        verification: { type: 'string', description: 'Layer 4: Verification evidence, test cases run, exit codes, and exact line locations' },
        worktree_path: { type: 'string', description: 'Optional: absolute path to agent worktree if working in an isolated sandbox' }
      },
      required: ['summary', 'motive', 'architecture', 'files_manifest']
    }
  },
  {
    name: 'gitx_search_chronicle',
    description: 'Hierarchical token-efficient search across GitX commit history. Searches Layer 1 (Motive), Layer 2 (Architecture), Layer 3 (Files), or Layer 4 (Lines/Proof).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or keyword (e.g. paint canvas, refresh token)' },
        layer: { type: 'number', description: 'Layer to search: 1 (Motive), 2 (Architecture), 3 (Files), or 4 (Lines/Proof). Defaults to 1.' },
        cwd: { type: 'string', description: 'Absolute path of the repository to search. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project, or the result silently answers about the wrong one.' }
      },
      required: ['query']
    }
  },
  {
    name: 'gitx_get_swarm_status',
    description: 'Queries the current status of all agents in the GitX swarm, active worktrees on disk, and assigned tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the repository whose worktrees to list. Defaults to the repo this MCP server was started in.' }
      },
      required: []
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'gitx_get_assigned_task': {
      try {
        const stateFile = path.join(ROOT_DIR, '.gitx', 'state.json');
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          const task = (state.issues || []).find(i => i.status !== 'Closed');
          if (task) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  found: true,
                  task_number: task.number,
                  title: task.title,
                  branch: task.branch,
                  prompt_spec: task.prompt_spec,
                  source_branch: task.source_branch,
                  worktree_path: task.worktreePath || ROOT_DIR,
                  assigned_to: AGENT_ID
                }, null, 2)
              }]
            };
          }
        }
      } catch (_) {}
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: false,
            message: 'No open task currently assigned to this agent in GitX. Working on current branch.'
          })
        }]
      };
    }

    case 'gitx_create_issue_with_branch': {
      const { title, branch, prompt_spec, source_branch } = args;
      const baseBranch = source_branch || 'main';

      // 1. Provision physical Git Worktree on disk!
      const worktreeResult = ensureWorktree(ROOT_DIR, branch, baseBranch);

      // 2. Broadcast issue and worktree path to broker
      sendToBroker({
        type: 'CREATE_ISSUE',
        agentId: AGENT_ID,
        title,
        branch,
        prompt_spec,
        source_branch: baseBranch,
        worktreePath: worktreeResult.worktreePath
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            message: 'Issue registered and physical Git Worktree provisioned!',
            title,
            branch,
            worktree_path: worktreeResult.worktreePath,
            prompt_spec,
            worktree_created: worktreeResult.created,
            note: 'The assigned agent should execute commands inside worktree_path to remain isolated from main.'
          }, null, 2)
        }]
      };
    }

    case 'gitx_commit_chronicle': {
      const { summary, stream, motive, architecture, files_manifest, verification, worktree_path } = args;
      const executionDir = worktree_path && fs.existsSync(worktree_path) ? worktree_path : ROOT_DIR;

      // 1. Run Secret Shield Pre-Commit Guardrail
      const guardrailCheck = scanPreCommit(executionDir, files_manifest);
      if (!guardrailCheck.allowed) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              blocked_by: 'GitX Secret Shield',
              error: guardrailCheck.reason,
              action_required: 'Remove the detected secret or sensitive file from your changes before attempting to commit.'
            }, null, 2)
          }]
        };
      }

      // 2. Build 4-Layer Chronicle Commit Body
      const chronicleBody = `=== GITX-CHRONICLE:START ===
[LAYER-1: MOTIVE]
Stream: ${stream || 'Core'} | Agent: ${AGENT_ID}
Motive: ${motive}

[LAYER-2: ARCHITECTURE]
${architecture}

[LAYER-3: CODE-MANIFEST]
Files:
${(files_manifest || []).map(f => '- ' + f).join('\n')}

[LAYER-4: VERIFICATION & EXACT LOCATIONS]
${verification || 'Verified by agent inspection.'}
=== GITX-CHRONICLE:END ===`;

      let commitHash = 'local-' + Date.now().toString(16);
      let currentBranch = 'unknown';

      // 3. Execute Real Git Add and Git Commit
      try {
        // Stage files
        if (files_manifest && files_manifest.length > 0) {
          execFileSync('git', ['add', ...files_manifest], { cwd: executionDir, stdio: 'ignore' });
        }

        // Commit with summary and 4-layer body
        execFileSync('git', ['commit', '-m', summary, '-m', chronicleBody], {
          cwd: executionDir,
          encoding: 'utf8'
        });

        // Retrieve newly generated Git SHA
        commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: executionDir,
          encoding: 'utf8'
        }).trim();

        // Retrieve current branch name
        currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: executionDir,
          encoding: 'utf8'
        }).trim();

      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'Git execution error: ' + err.message,
              note: 'Ensure files exist and contain modifications to commit.'
            }, null, 2)
          }]
        };
      }

      // 4. Notify broker with real Git SHA and metadata
      sendToBroker({
        type: 'COMMIT_CHRONICLE',
        agentId: AGENT_ID,
        stream: stream || 'Core',
        summary,
        motive,
        architecture,
        filesManifest: files_manifest,
        verification,
        commitHash,
        branch: currentBranch
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            commit_hash: commitHash,
            branch: currentBranch,
            commit_format: 'GitX 4-Layer Chronicle',
            stream: stream || 'Core',
            summary,
            layers_recorded: [1, 2, 3, 4],
            security_check: 'Passed (Secret Shield clean)',
            note: 'Commit safely recorded in local Git history. Remote push is guarded and must be executed in Ter-Manager.'
          }, null, 2)
        }]
      };
    }

    case 'gitx_search_chronicle': {
      const { query, layer, cwd } = args;
      const q = (query || '').toLowerCase();
      const l = layer || 1;
      const target = resolveTargetRepo(cwd);
      let matches = [];

      if (!target.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No such folder: ' + target.requested + ' - nothing was searched.',
              searched_repo: null
            }, null, 2)
          }]
        };
      }

      try {
        const chronicles = scanGitHistory(target.dir);
        const seen = new Set(chronicles.map(c => c.commitHash));

        /* GitX's own cache, unaffected by cwd - see the note on
         * resolveTargetRepo. A repo being searched that is not the one
         * GitX is installed in will just skip this merge, which only ever
         * adds chronicles this same process itself recorded. */
        const stateFile = target.dir === ROOT_DIR ? path.join(ROOT_DIR, '.gitx', 'state.json') : null;
        if (stateFile && fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          for (const c of state.chronicles || []) {
            if (!seen.has(c.commitHash)) chronicles.push(c);
          }
        }

        {
          matches = chronicles.filter(c => {
            if (l === 1) return (c.motive || '').toLowerCase().includes(q) || (c.stream || '').toLowerCase().includes(q);
            if (l === 2) return (c.architecture || '').toLowerCase().includes(q);
            if (l === 3) return (c.filesManifest || []).some(f => f.toLowerCase().includes(q));
            return (c.verification || '').toLowerCase().includes(q);
          }).map(c => ({
            commitHash: c.commitHash,
            stream: c.stream,
            summary: c.summary,
            layer_content: l === 1 ? c.motive : (l === 2 ? c.architecture : (l === 3 ? c.filesManifest : c.verification))
          }));
        }
      } catch (_) {}

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            searched_repo: target.dir,
            searched_layer: l,
            matches_count: matches.length,
            results: matches
          }, null, 2)
        }]
      };
    }

    case 'gitx_get_swarm_status': {
      const target = resolveTargetRepo(args.cwd);
      if (!target.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No such folder: ' + target.requested + ' - nothing was listed.',
              searched_repo: null
            }, null, 2)
          }]
        };
      }
      let swarm = [];
      const activeWorktrees = listWorktrees(target.dir);

      try {
        const stateFile = path.join(ROOT_DIR, '.gitx', 'state.json');
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          swarm = (state.issues || []).map(i => ({
            issue: i.number,
            title: i.title,
            branch: i.branch,
            assigned_to: i.assignedTo,
            status: i.status,
            worktree_path: i.worktreePath || 'main'
          }));
        }
      } catch (_) {}

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            searched_repo: target.dir,
            current_agent: AGENT_ID,
            active_worktrees: activeWorktrees,
            active_swarm_tasks: swarm
          }, null, 2)
        }]
      };
    }

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    const { id, method, params } = request;

    if (method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'gitx-mcp-server', version: '1.0.0' }
        }
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        sendResponse({ jsonrpc: '2.0', id, result });
      } catch (err) {
        sendResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message }
        });
      }
      return;
    }

    if (method === 'ping') {
      sendResponse({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found: ' + method }
    });

  } catch (err) {
    process.stderr.write('[GitX MCP Error] ' + err.message + '\n');
  }
});

process.stderr.write('[GitX MCP Server] Running in stdio mode for ' + AGENT_ID + '\n');
