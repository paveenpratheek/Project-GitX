import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
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
  } catch (err) {
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
    description: 'Retrieves the task, feature prompt specification, and assigned branch allocated to this agent in GitX.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'gitx_create_issue_with_branch',
    description: 'Creates a new GitHub/GitX issue with a feature specification prompt, provisions an isolated branch and worktree, and enables another agent to work on it.',
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
    description: 'Creates an automated, structured 4-layer commit in GitX (Motive, Architecture, Code Manifest, Verification). Never deletes history and never pushes to remote.',
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
          description: 'Layer 3: List of files and functions modified or introduced'
        },
        verification: { type: 'string', description: 'Layer 4: Verification evidence, test cases run, exit codes, and exact line locations' }
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
        layer: { type: 'number', description: 'Layer to search: 1 (Motive), 2 (Architecture), 3 (Files), or 4 (Lines/Proof). Defaults to 1.' }
      },
      required: ['query']
    }
  },
  {
    name: 'gitx_get_swarm_status',
    description: 'Queries the current status of all agents in the GitX swarm, their active branches, and their assigned tasks.',
    inputSchema: {
      type: 'object',
      properties: {},
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
      sendToBroker({
        type: 'CREATE_ISSUE',
        agentId: AGENT_ID,
        title,
        branch,
        prompt_spec,
        source_branch: source_branch || 'main'
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            message: 'Issue registered in GitX! Feature branch & worktree scheduled: ' + branch,
            title,
            branch,
            prompt_spec
          }, null, 2)
        }]
      };
    }

    case 'gitx_commit_chronicle': {
      const { summary, stream, motive, architecture, files_manifest, verification } = args;

      sendToBroker({
        type: 'COMMIT_CHRONICLE',
        agentId: AGENT_ID,
        stream: stream || 'Core',
        summary,
        motive,
        architecture,
        filesManifest: files_manifest,
        verification
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            commit_format: 'GitX 4-Layer Chronicle',
            stream: stream || 'Core',
            summary,
            layers_recorded: [1, 2, 3, 4],
            note: 'Commit recorded in GitX Lakehouse. Remote push is guarded and must be performed in Ter-Manager.'
          }, null, 2)
        }]
      };
    }

    case 'gitx_search_chronicle': {
      const { query, layer } = args;
      const q = (query || '').toLowerCase();
      const l = layer || 1;
      let matches = [];

      try {
        const stateFile = path.join(ROOT_DIR, '.gitx', 'state.json');
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          const chronicles = state.chronicles || [];

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
            searched_layer: l,
            matches_count: matches.length,
            results: matches
          }, null, 2)
        }]
      };
    }

    case 'gitx_get_swarm_status': {
      let swarm = [];
      try {
        const stateFile = path.join(ROOT_DIR, '.gitx', 'state.json');
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          swarm = (state.issues || []).map(i => ({
            issue: i.number,
            title: i.title,
            branch: i.branch,
            assigned_to: i.assignedTo,
            status: i.status
          }));
        }
      } catch (_) {}

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            current_agent: AGENT_ID,
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
