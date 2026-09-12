import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

import { scanPreCommit } from './tools/guardrails.js';
import { ensureWorktree, listWorktrees } from './tools/worktree-manager.js';
import { scanGitHistory } from './tools/chronicle-parser.js';
import { loadOrBuildIndex, stagedRegions, findRelated } from './tools/region-index.js';

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
/* Per-repo GitX data - issues and worktrees - lives INSIDE whichever repo
 * it is about, at <repo>/.gitx/, the same convention .git/ itself uses.
 * Not the repo GitX happens to be installed in; the one actually named by
 * cwd. This is what makes it travel: clone the repo and its .gitx/ comes
 * along as ordinary files, no GitX install or broker required to have
 * created them - only to read them back.
 *
 * ensureGitignored is what keeps the promise of "without disturbing the
 * user's code": a bare .gitx/ folder with no ignore rule is untracked
 * clutter the moment someone runs `git status` in their own repo. Same
 * defensive shape as every other .gitignore writer in this stack - skip a
 * pattern already present, enforce a trailing newline before appending, or
 * the new line grafts onto whatever the last line was. */
function ensureGitignored(dir) {
  try {
    const giFile = path.join(dir, '.gitignore');
    let text = '';
    try { text = fs.readFileSync(giFile, 'utf8'); } catch (_) { /* none yet - creating it */ }
    const already = text.split(/\r?\n/).some((l) => l.trim() === '.gitx' || l.trim() === '.gitx/');
    if (already) return;
    const sep = (text === '' || text.endsWith('\n')) ? '' : '\n';
    fs.writeFileSync(giFile, text + sep + '.gitx/' + '\n', 'utf8');
  } catch (_) { /* best-effort - never block the actual operation over this */ }
}

function loadTargetState(dir) {
  const stateFile = path.join(dir, '.gitx', 'state.json');
  try {
    if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {}
  return { issues: [] };
}

function saveTargetState(dir, state) {
  try {
    ensureGitignored(dir);
    const gitxDir = path.join(dir, '.gitx');
    if (!fs.existsSync(gitxDir)) fs.mkdirSync(gitxDir, { recursive: true });
    fs.writeFileSync(path.join(gitxDir, 'state.json'), JSON.stringify({ issues: state.issues || [] }, null, 2), 'utf8');
  } catch (_) {}
}

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
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the repository to check. Defaults to the repo this MCP server was started in.' }
      },
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
        source_branch: { type: 'string', description: 'Base branch to branch off from (defaults to current or main)' },
        cwd: { type: 'string', description: 'Absolute path of the repository to create this issue and worktree in. Defaults to the repo this MCP server was started in.' }
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
  },
  {
    name: 'gitx_find_related',
    description: 'Call this AFTER staging changes and BEFORE writing a commit message. Finds earlier commits related to the work you just did, so the message can reference real prior work instead of guessing. Ranks by which code regions you touched AND how you describe the change - the two find different things, so supply both. Reads the staged diff itself; do not paste it in. Unlike gitx_search_chronicle, which searches by keyword, this searches by example: the example is your staged work.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One line saying what you just built, in your own words - e.g. "reworked how the wallpaper picks its accent colour". This is a second, independent search signal: it reaches work whose code has since moved, which the staged diff alone cannot find.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project, or the result silently answers about the wrong one.' },
        limit: { type: 'number', description: 'How many results to return. Defaults to 10.' }
      },
      required: ['description']
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'gitx_get_assigned_task': {
      const target = resolveTargetRepo(args.cwd);
      if (!target.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: false,
              error: 'No such folder: ' + target.requested
            })
          }]
        };
      }
      try {
        const state = loadTargetState(target.dir);
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
                worktree_path: task.worktreePath || target.dir,
                assigned_to: AGENT_ID,
                repo: target.dir
              }, null, 2)
            }]
          };
        }
      } catch (_) {}
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: false,
            repo: target.dir,
            message: 'No open task currently assigned to this agent in GitX. Working on current branch.'
          })
        }]
      };
    }

    case 'gitx_create_issue_with_branch': {
      const { title, branch, prompt_spec, source_branch, cwd } = args;
      const target = resolveTargetRepo(cwd);
      if (!target.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: false, error: 'No such folder: ' + target.requested })
          }]
        };
      }
      const baseBranch = source_branch || 'main';

      // 1. Provision physical Git Worktree on disk, in the TARGET repo.
      const worktreeResult = ensureWorktree(target.dir, branch, baseBranch);

      /* Refuse to record an issue pointing at a worktree that was never
       * actually created. This used to persist regardless - a failed
       * ensureWorktree() falls back to { worktreePath: repoRoot, created:
       * false, error }, and the issue got written anyway, so
       * gitx_get_assigned_task would hand an agent a "worktree_path" that
       * was really just the main repo root. An agent told to work isolated
       * there is not isolated - it is editing the same files as everyone
       * else, believing otherwise. Only a real error fails this; the
       * "existing worktree re-used" case has no error field and passes
       * through exactly as before. */
      if (worktreeResult.error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'Could not provision the worktree, so no issue was recorded: ' + worktreeResult.error,
              repo: target.dir
            }, null, 2)
          }]
        };
      }

      /* 2. Persist directly into the target repo's own .gitx/state.json -
       * not only broadcast to the broker. The broker is a separate process
       * that may not even be running when an agent calls this tool over
       * stdio, and its own state file is centralized to wherever GitX
       * itself is installed, not to the repo the issue is actually about.
       * Writing it here is what makes the issue survive a clone even if
       * nobody ever opens the GitX dashboard for this repo. */
      const state = loadTargetState(target.dir);
      const issueNumber = (state.issues || []).length + 1;
      const issue = {
        id: 'issue-' + Date.now(),
        number: issueNumber,
        title: title || ('Untitled Task #' + issueNumber),
        branch,
        prompt_spec: prompt_spec || '',
        source_branch: baseBranch,
        worktreePath: worktreeResult.worktreePath,
        repoPath: target.dir,
        status: 'Open',
        assignedTo: null,
        createdAt: new Date().toISOString(),
        createdBy: AGENT_ID
      };
      state.issues = state.issues || [];
      state.issues.unshift(issue);
      saveTargetState(target.dir, state);

      // 3. Broadcast too, for whoever has the live dashboard open.
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
            message: 'Issue registered and physical Git Worktree provisioned in ' + target.dir,
            repo: target.dir,
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

    case 'gitx_find_related': {
      const target = resolveTargetRepo(args.cwd);
      if (!target.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'No such folder: ' + target.requested + ' - nothing was searched.', searched_repo: null }, null, 2)
          }]
        };
      }

      /* Deliberately does NOT call ensureGitignored or write into the repo.
       * This tool only reads; its index is a rebuildable cache kept in the OS
       * temp directory. A search that edits someone's .gitignore as a side
       * effect is exactly the kind of surprise that makes a tool untrustworthy. */
      const { index, rebuilt } = loadOrBuildIndex(target.dir);
      const qRegions = stagedRegions(target.dir);
      const { qWords, results } = findRelated(index, qRegions, args.description || '', args.limit || 10);

      const regionList = Object.keys(qRegions);
      const notes = [];
      if (!regionList.length) {
        notes.push('Nothing is staged, so this ranked on your description alone. Stage your changes first for a much better answer.');
      }
      if (!qWords.length && args.description) {
        notes.push('Your description contributed nothing: every word in it was either too common in this repo or a stopword. Ranked on staged code alone.');
      }
      if (!results.length) {
        notes.push('No prior commit shares a region or a distinctive word with this work. That usually means it is genuinely new - say so in the message rather than inventing a link.');
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            searched_repo: target.dir,
            indexed_commits: index.count,
            index_rebuilt: rebuilt,
            commits_with_relations: index.trailerEdges || 0,
            staged_regions: regionList,
            description_terms_used: qWords,
            matches_count: results.length,
            results,
            /* Two sub-scores are returned per result on purpose: a high
             * region_score with a low text_score means "same code, described
             * differently", the reverse means "same topic, code has moved".
             * Those are different relations and are worth wording differently. */
            how_to_use: [
              'READ the "why" field on each result before citing it - that is the reasoning behind the earlier change, and it is the one thing the code itself cannot tell you. If a result already rules out the approach you were about to take, that is the most valuable thing this tool can give you.',
              'shared_regions and shared_words say WHY each result surfaced. If neither looks relevant to what you actually did, do not cite it.',
              '"thread" lists commits explicitly linked to that result, so you can see a line of work rather than an isolated change.',
              'Then write the message in this shape:',
              '',
              '  type(scope): what changed, in this project\'s own nouns',
              '',
              '  Why - the constraint that forced this, what you tried first, what',
              '  it rules out. Do NOT list changed files here: git already records',
              '  them exactly and a hand-typed list is only ever less accurate.',
              '',
              '  GitX-Builds-On: ' + (results[0] ? results[0].short : '<hash from these results>'),
              '',
              'Specific nouns matter far more than length. Words like "added", "fixed", "update" and "bug" are discarded outright, so a long message built from them scores exactly the same as an empty one.'
            ].join('\n'),
            notes: notes.length ? notes : undefined
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
