import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

import { scanStaged } from './tools/guardrails.js';
import { ensureWorktree, listWorktrees } from './tools/worktree-manager.js';
import { loadOrBuildIndex } from './tools/commit-index.js';
import { stagedRegions, findRelated } from './tools/retrieval.js';
import { parseMessage, tokenize } from './tools/git-extract.js';
import { loadGraph, graphMap, graphArea, graphChain, graphCommit } from './tools/project-graph.js';
import { catchUp, readThought } from './tools/thought-query.js';
import { readLog } from './tools/thought-watch.js';
import { loadThoughts } from './tools/thoughts.js';
import { promote, describe as describePromotion } from './tools/promote.js';
import { recordThoughts } from './tools/record.js';
import { related } from './tools/rank.js';
/* The path taken for each prompt (t-50e40ce534): what GitX did with an agent's
 * question and where the agent went next, kept per prompt and streamed to the
 * broker for GitX Monitor. Its own module and folder; the only coupling is the
 * calls below. It replaced the trail recorder, which kept every call. */
import { PathRecorder } from './tools/path-recorder.js';
const paths = new PathRecorder({ send: (msg) => sendToBroker(msg), dataDir: () => logDataDir() });
process.on('exit', () => paths.end());
/* What gitx_related did, for the path recorder; never part of the agent's answer. */
let lastMonitor = null;

/* The commit form's vocabulary. Conventional-commit types, so the header parses
 * the way parseMessage already reads one. */
const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'];
/* A scope or root is a NAME that later commits repeat, so it is kept to
 * characters that pass through a commit header and a trailer value unchanged. */
const NAME_RE = /^[a-z0-9][a-z0-9._/-]*$/;
/* A floor against filler, not a measure of quality - see the why check. */
const MIN_WHY_WORDS = 3;

const __filename = fileURLToPath(import.meta.url);
function getRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return process.cwd();
  }
}

const ROOT_DIR = getRepoRoot();

/* Where the broker's watcher writes its log. GITX_DATA_DIR wins, as it does
 * in the broker; otherwise the folder ter-manager gave the broker, which it
 * remembers in its local.json. Read on every call, because the broker may
 * learn the folder after this server started - and without it the history
 * tool read a log nobody writes to and answered "nothing recorded". */
function logDataDir() {
  if (process.env.GITX_DATA_DIR) return process.env.GITX_DATA_DIR;
  try {
    const file = process.env.GITX_LOCAL_FILE || path.join(path.dirname(__filename), '..', '.gitx', 'local.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).dataDir || null;
  } catch (_) {
    return null;
  }
}

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
 * user's code" - and it ignores only what is PRIVATE. The commit graph
 * (.gitx/commits, the fuller messages) belongs to the repository and is shared
 * with it; thoughts, drafts, the context graph, stashes, task state and sandbox checkouts belong to the
 * person who owns this clone and never leave it. A bare ".gitx/" would have
 * hidden the graph along with them.
 *
 * It is written as ignore-everything-then-share-one, not as a list of private
 * folders. A list is private only for the folders someone remembered to name:
 * every folder added later - the context graph was the first - would have been
 * pushed with the next commit until a line was added to every repository.
 * Git's last matching rule wins, so the share line must come AFTER the ignore
 * line; a share line that only appears earlier is appended again.
 *
 * A repository that already ignores the whole folder is left alone: that is
 * a choice someone made, and widening what gets pushed is not this function's
 * call. Lines from the old list are left where they are - they are harmless
 * under the new rule, and editing someone's own lines is not this function's
 * call either. Same defensive shape as every other .gitignore writer in this
 * stack: skip what is already there, enforce a trailing newline before
 * appending, or the new line grafts onto whatever the last line was. */
const GITX_IGNORE = '.gitx/*';
const GITX_SHARE = '!.gitx/commits/';

function ensureGitignored(dir) {
  try {
    const giFile = path.join(dir, '.gitignore');
    let text = '';
    try { text = fs.readFileSync(giFile, 'utf8'); } catch (_) { /* none yet - creating it */ }
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes('.gitx') || lines.includes('.gitx/')) return;
    const ignoreAt = lines.lastIndexOf(GITX_IGNORE);
    const shareAt = lines.lastIndexOf(GITX_SHARE);
    const missing = ignoreAt < 0 ? [GITX_IGNORE, GITX_SHARE]
      : shareAt < ignoreAt ? [GITX_SHARE]
      : [];
    if (!missing.length) return;
    const sep = (text === '' || text.endsWith('\n')) ? '' : '\n';
    fs.writeFileSync(giFile, text + sep + missing.join('\n') + '\n', 'utf8');
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
/* Overridable for the same reason the broker's own port is: a second instance -
 * a test run, say - has to be able to point somewhere other than the dashboard
 * someone is using, or its test commits show up in their live view. */
const BROKER_WS = process.env.GITX_BROKER_URL || 'ws://127.0.0.1:7771';

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
    /* This used to write a 4-layer "chronicle": summary, stream, motive,
     * architecture, a hand-typed file list and a verification block between
     * START/END tags. It had no field for what a commit builds on, and its END
     * tag closed every message, so a trailer typed into any field could never be
     * read. It also wrote the file list into the message (git records files
     * exactly; a typed list only drifts), filled an empty verification with a
     * claim nobody made, and committed into whichever repo this server started
     * in. It is now a form for the one format retrieval, chains and the graph
     * actually read. The name stays so existing setups keep working. */
    description: 'Commit what is staged, with GitX writing the message from the fields you fill in - so the format, and the trailers that link commits into chains, are always exactly right. Give builds_on (the earlier commit this continues: run gitx_find_related first and pick from its results) OR root (the name of a new feature this commit starts). Nothing is committed if: nothing is staged, why is filler, both or neither of builds_on/root are given, a hash does not exist or (for builds_on) is not behind HEAD, the root name is already taken, or the staged content contains a secret. A root whose staged change overlaps earlier commits is held until you have reviewed them and pass root_confirmed: true.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the repository (or agent worktree) to commit in. Required - a commit is not something to default to wherever this server happened to start.' },
        type: { type: 'string', enum: COMMIT_TYPES, description: 'What kind of change this is.' },
        scope: { type: 'string', description: 'The feature or area, in the project\'s own nouns - e.g. "menu", "retrieval". Reuse an existing name where one fits: it is what ties a line of work together. Defaults to root when root is given.' },
        subject: { type: 'string', description: 'One line: what changed. Without the "type(scope):" prefix - GitX writes that.' },
        why: { type: 'string', description: 'What forced this change, what you tried first, and what it rules out. Do not list files - git records them exactly.' },
        verification: { type: 'string', description: 'Optional: what you actually ran and what it showed. Left out when empty, never filled in for you.' },
        builds_on: { type: 'array', items: { type: 'string' }, description: 'Hash(es) of the earlier commit(s) this continues - pick from gitx_find_related results. Give this OR root.' },
        root: { type: 'string', description: 'Name of the NEW feature this commit starts, when no earlier commit is what it continues. Give this OR builds_on. Written as GitX-Root: <name>; later commits in the feature build on this one.' },
        root_confirmed: { type: 'boolean', description: 'Pass true only after a root attempt came back needs_confirmation and none of its candidates is what this continues.' },
        relates_to: { type: 'array', items: { type: 'string' }, description: 'Optional: commits that are related but are not what this builds on - e.g. the feature a new feature sits inside. Written as GitX-Relates-To.' },
        thoughts: { type: 'array', items: { type: 'string' }, description: 'Optional: ids of the decisions and costs this commit carries out, waiting in the context graph (gitx_thought with outcome accepted lists them). Written as GitX-Thoughts; on commit they move to the thought graph with this commit as their result, and the evidence, alternatives and costs that made them happen come with them.' }
      },
      required: ['cwd', 'type', 'subject', 'why']
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
    description: 'Finds earlier commits related to what you are working on, so you can read the reasoning behind them instead of guessing. Two uses: AFTER staging and before writing a commit message, or when ORIENTING in an unfamiliar area before changing anything. Ranks on which code regions are involved AND how you describe the work - the two reach different things, so supply both. Reads the staged diff itself; do not paste it in. gitx_related searches commits and thoughts by words; this searches by example, from staged work.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'One line in your own words - what you just built, or what you are about to work on. e.g. "reworked how the wallpaper picks its accent colour". An independent search signal: it reaches work whose code has since moved, which regions alone cannot find.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, directories or exact regions you are working in. USE THIS WHEN NOTHING IS STAGED - without it a query runs on your description alone and loses most of its accuracy. Three forms: "public/app.js::function applyWallpaper" for one declaration, "public/app.js" for a whole file, "public/scenes/" for a directory.'
        },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project, or the result silently answers about the wrong one.' },
        limit: { type: 'number', description: 'How many results to return. Defaults to 10.' }
      },
      required: ['description']
    }
  },
  /* The project graph: for a NEW agent getting on track, where find_related is
   * for an agent in the middle of a change. Four small calls rather than one
   * large one, so an agent pays only for the depth its question needs. */
  {
    name: 'gitx_graph_map',
    description: 'START HERE when you are new to a project and need to get on track with the agents already working on it. Returns the whole project as a map: every line of work (root) with how it started and its latest commits, the threads (areas of code that change together) and how they connect. Read it once, then drill in with gitx_graph_area, gitx_graph_chain and gitx_graph_commit. Uses fuller messages from .gitx/commits/ where they exist, git otherwise. This is navigation, not search: to find what YOUR change relates to, use gitx_find_related.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project.' }
      },
      required: []
    }
  },
  {
    name: 'gitx_graph_area',
    description: 'One line of work or thread from gitx_graph_map, in depth: the commit that started it and why, the commits where it split into phases, its latest commits with their reasons, the code regions it lives in, and which other lines of work it connects to.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A root name (e.g. "terminal") or thread name exactly as gitx_graph_map lists it.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in.' }
      },
      required: ['name']
    }
  },
  {
    name: 'gitx_graph_chain',
    description: 'Follow one commit\'s reasoning: every commit it builds on back to the root of its line of work (nearest first, each with its why), and every commit built on it since. Use it to answer WHY something exists or what happened after it. Stop reading once the reason is found.',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'Commit hash or prefix (at least 4 characters).' },
        limit: { type: 'number', description: 'Maximum commits each way. Defaults to 30.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in.' }
      },
      required: ['hash']
    }
  },
  {
    name: 'gitx_graph_commit',
    description: 'One commit in full: its whole message (and the original git subject if a fuller message was written later), what it builds on and what was built on it, its line of work and thread, and the exact files and code regions it changed. Read those regions before describing how something works today.',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'Commit hash or prefix (at least 4 characters).' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in.' }
      },
      required: ['hash']
    }
  },
  /* The thought layer: what commits never carry - alternatives turned down and
   * why, questions still open, ideas stashed for later, rules learned from a
   * correction. Read-only; thoughts are the repo owner's own and never leave
   * their clone. Writing them is a later, separate set of tools. */
  {
    name: 'gitx_thought_catch_up',
    description: 'Call this at the START of a session in a repository, before changing anything, to pick up where the last agent or session left off. Returns: thinking recorded since the last commit (what was in progress), what the recent commits decided and turned down, where the newest reasoning is if the recent commits have none, a one-line count of the thinking waiting in the context graph (search it with gitx_related), questions still open, turned-down ideas that can come back and under what condition, ideas stashed for later, and rules learned from past corrections - which you should follow. Every empty answer says so explicitly: "no thinking on record" is a fact, not a failure. Pass since (a commit hash) to catch up on everything after a commit you already know.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Optional commit hash: summarise every commit after it instead of the last 5.' },
        limit: { type: 'number', description: 'Maximum commits to summarise (up to 30).' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project.' }
      },
      required: []
    }
  },
  /* Reading a thought, not searching for one: by id from either graph, the
   * thinking behind a commit, lists by outcome or kind, and the stashes.
   * Searching by words is gitx_related's - see tools/thought-query.js. */
  {
    name: 'gitx_thought',
    description: 'Read reasoning GitX holds, by address rather than by words: one thought by id in full - every force, every link both ways, where it sits, whether a commit settled it - from the thought graph (settled) or the context graph (waiting); the thinking behind one commit; every thought of an outcome or kind, or rejected ideas that can come back (reopenable), from both graphs; or the stashes. To find thinking by words, use gitx_related. An empty answer says which kind of empty it is.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One thought id (t-...) to read in full, whichever graph holds it.' },
        commit: { type: 'string', description: 'Commit hash or prefix (4+ characters): the thinking that led to this commit.' },
        outcome: { type: 'array', items: { type: 'string', enum: ['accepted', 'rejected', 'stashed', 'open'] }, description: 'List thoughts with these outcomes, settled and waiting. "open" lists questions nobody has settled; an accepted one that is waiting is decided but not built.' },
        kind: { type: 'array', items: { type: 'string', enum: ['decision', 'finding', 'cost', 'learned'] }, description: 'List thoughts of these kinds, settled and waiting.' },
        reopenable: { type: 'boolean', description: 'List rejected ideas held back only by something that can change, each with its revisit_if.' },
        stashes: { type: 'boolean', description: 'List the stashes: ideas set aside on purpose, each with its thoughts and references.' },
        limit: { type: 'number', description: 'Maximum results per list. Defaults to 15, at most 50.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project.' }
      },
      required: []
    }
  },
  /* The ranking engine (tools/rank.js) as an agent asks it: one list over
   * everything GitX holds, where the tools above each search one part. */
  {
    name: 'gitx_related',
    description: 'Find what GitX already holds about something - commits, settled reasoning and thinking still waiting, ranked together - BEFORE working it out again. Give a query (a question, a task, a draft in your own words), and optionally ids you are on, paths you work in, or a topic. Each result gives its status first (OPEN QUESTION, PROPOSED - NOT CONFIRMED, ANSWERED by <thought>, ACCEPTED - NOT BUILT, SETTLED in <commit>, REJECTED with what held it back, SUPERSEDED, COMMIT), its full text, why it ranked, and the call that reads it in full. Results are pointers: read one before relying on what it does not show. An empty answer says so, and is not evidence nothing was considered.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Your words: a question, what you are about to do, or a draft thought. Matched by meaning-bearing words across every commit and thought.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Thought ids (t-...) or commit hashes you are on or about to link to - what is linked to them ranks higher.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files, directories or "file::declaration" you work in - what touched that code ranks higher.' },
        topic: { type: 'string', description: 'A topic id (tp-...) the work belongs to.' },
        layers: { type: 'array', items: { type: 'string', enum: ['commit', 'thought', 'context'] }, description: 'Only these: commit, thought (settled), context (waiting). Default all three.' },
        outcome: { type: 'array', items: { type: 'string', enum: ['accepted', 'rejected', 'stashed', 'open'] }, description: 'Only thoughts with these outcomes - "rejected" for ideas turned down, "open" for questions nobody has settled.' },
        kind: { type: 'array', items: { type: 'string', enum: ['decision', 'finding', 'cost', 'learned'] }, description: 'Only thoughts of these kinds.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 8, at most 25.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project.' }
      },
      required: []
    }
  },
  /* The one tool that writes a thought. Everything it records waits in the
   * context graph until a commit names it - see tools/record.js. */
  {
    name: 'gitx_thought_record',
    description: 'Record thinking as it happens: a decision and the alternatives it beat, a cost accepted, a finding, an open question, a rule learned from a correction. It goes to the context graph and waits there; when the commit that carries a decision out names it (GitX-Thoughts in the message, or thoughts in gitx_commit_chronicle), it moves to the thought graph with what supports it. Give kind, text (one sentence that stands on its own), outcome, decided_by for a decision, the forces behind it, and links; GitX stamps the id, the commit it was thought at, who and when. Record several at once with keys, so a decision, what lost to it (lost-to) and its cost (cost-of) link in one call; a link may also name any thought on record by id. Nothing is written unless every thought passes - a lost-to must run from a rejection to an accepted thought, a cost-of from a cost to an accepted decision, a contingent force needs revisit_if, and an exact repeat of a thought on record is refused. The reply gives each id, the line that settles a decision, and the thoughts on record it most likely continues, repeats, answers or contradicts, each with why - link to one if so.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the repository the thinking is about. Required: a thought is not written to wherever this server happened to start.' },
        thoughts: {
          type: 'array',
          description: 'One to 20 thoughts, recorded together or not at all.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'A name for this thought within the call, so others in the same call can link to or cite it. Defaults to its position, 1, 2, 3...' },
              kind: { type: 'string', enum: ['decision', 'finding', 'cost', 'learned'] },
              text: { type: 'string', description: 'One sentence that stands on its own: what was decided, found, accepted as a cost, or learned. The reasoning goes in forces.' },
              outcome: { type: 'string', enum: ['accepted', 'rejected', 'open', 'stashed'], description: '"accepted" for a decision made (built or not), "rejected" for an alternative turned down, "open" for a question nobody has settled, "stashed" for an idea set aside on purpose.' },
              decided_by: { type: 'string', enum: ['user', 'agent', 'agent-delegated'], description: 'For a decision: who made it. Defaults to agent.' },
              forces: {
                type: 'array',
                description: 'What pushed it forward or held it back.',
                items: {
                  type: 'object',
                  properties: {
                    direction: { type: 'string', enum: ['forward', 'backward'] },
                    kind: { type: 'string', enum: ['contingent', 'structural'], description: 'For a backward force: contingent if it can change, structural if it cannot.' },
                    text: { type: 'string' },
                    revisit_if: { type: 'string', description: 'For a contingent force: what would have to change for this to come back.' },
                    cites: { type: 'array', items: { type: 'string' }, description: 'Keys in this call or thought ids on record that this force rests on.' }
                  },
                  required: ['direction', 'text']
                }
              },
              links: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['lost-to', 'cost-of', 'supports', 'refines', 'derived-from', 'supersedes', 'contradicts'] },
                    to: { type: 'string', description: 'A key in this call, or a thought id on record in either graph.' }
                  },
                  required: ['type', 'to']
                }
              }
            },
            required: ['kind', 'text', 'outcome']
          }
        }
      },
      required: ['cwd', 'thoughts']
    }
  },
  {
    name: 'gitx_thought_history',
    description: 'What a thought used to say, and what has changed in the thought graph and the context graph. Nothing guards these files - any agent, including you, can rewrite or delete a thought - so what exists instead is a record of every change with the OLD values kept. Each entry says which graph it happened in; a thought passing from the context graph to the thought graph (or back) is one "moved" entry, with any fields that changed on the way. It also records files under .gitx that are NOT readable as thoughts - wrong schema, no id, no anchor, not JSON - which the reader otherwise skips in silence, so a thought written in the wrong shape says so instead of simply never existing. Use it to see how a thought reached its current wording, to find what a deleted one said (the entry holds a full copy, so it can be put back), to check whether anything changed while you were away, or to find out why a thought you just wrote is not showing up. Pass id for one thought. The log verifies itself: each entry is chained to the one before, and the answer says so if that chain is broken.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One thought id (t-...): its own history, newest first. A file path under .gitx works too, for a file that never became a thought.' },
        limit: { type: 'number', description: 'How many entries. Defaults to 50.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project.' }
      },
      required: []
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
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

      /* A caller still sending the old 4-layer fields is told what replaced them,
       * rather than getting a commit made from half of what it meant. */
      const legacy = ['summary', 'stream', 'motive', 'architecture', 'files_manifest'].filter((k) => args[k] !== undefined);
      if (legacy.length && args.subject === undefined && args.why === undefined) {
        return reply({
          ok: false,
          committed: false,
          error: 'gitx_commit_chronicle no longer takes ' + legacy.join(', ') + ' - it now writes the GitX commit format from a form. Nothing was committed.',
          field_map: {
            summary: 'type + scope + subject (the subject without its "feat:" prefix)',
            'motive, architecture': 'why - what forced the change, what you tried first, what it rules out',
            files_manifest: 'gone - stage the files yourself (git add); the commit takes exactly what is staged',
            stream: 'scope',
            'new and required': 'builds_on (the earlier commit this continues) OR root (the name of the new feature this starts)'
          }
        });
      }

      const cwd = args.cwd || args.worktree_path;
      if (!cwd) {
        return reply({ ok: false, committed: false, error: 'cwd is required: the absolute path of the repository to commit in. A commit is not something to default to wherever this server happened to start. Nothing was committed.' });
      }
      const target = resolveTargetRepo(cwd);
      if (!target.ok) {
        return reply({ ok: false, committed: false, error: 'No such folder: ' + target.requested + ' - nothing was committed.' });
      }
      const dir = target.dir;
      const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const gitOk = (...a) => { try { git(...a); return true; } catch (_) { return false; } };
      if (!gitOk('rev-parse', '--is-inside-work-tree')) {
        return reply({ ok: false, committed: false, error: dir + ' is not inside a git repository - nothing was committed.' });
      }

      const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean);
      const type = String(args.type || '').trim().toLowerCase();
      const subject = String(args.subject || '').trim();
      const why = String(args.why || '').replace(/\r\n?/g, '\n').trim();
      const verification = String(args.verification || '').replace(/\r\n?/g, '\n').trim();
      const root = String(args.root || '').trim().toLowerCase();
      const scope = String(args.scope || '').trim().toLowerCase() || root;
      const rootConfirmed = args.root_confirmed === true || args.root_confirmed === 'true';
      const buildsOnIn = [...new Set(list(args.builds_on))];
      const relatesIn = [...new Set(list(args.relates_to))].filter((h) => !buildsOnIn.includes(h));

      /* Every problem at once, so a caller fixes the form in one pass instead of
       * discovering the next refusal only after fixing the last. */
      const problems = [];
      if (!COMMIT_TYPES.includes(type)) problems.push('type must be one of: ' + COMMIT_TYPES.join(', ') + '.');
      if (!subject) problems.push('subject is empty - one line saying what changed.');
      else if (/\n/.test(subject)) problems.push('subject must be one line; the detail belongs in why.');
      else if (/^[a-z]+(\([^)]*\))?!?:\s/i.test(subject)) problems.push('subject repeats the "type(scope):" prefix - give only the description; GitX writes the prefix.');
      if (args.scope && !NAME_RE.test(scope)) problems.push('scope "' + scope + '" should be a short name: lowercase letters, digits, dot, dash, underscore or slash.');
      if (root && !NAME_RE.test(root)) problems.push('root "' + root + '" should be a short name: lowercase letters, digits, dot, dash, underscore or slash.');

      /* A floor against filler, not a quality check. Words describing the act of
       * committing - added, fixed, update, bug - are exactly the ones retrieval
       * discards, so a why built from them scores the same as an empty one and
       * would look recorded while saying nothing. */
      const whyWords = new Set(tokenize(why));
      if (whyWords.size < MIN_WHY_WORDS) {
        problems.push('why has ' + whyWords.size + ' usable word(s); it needs at least ' + MIN_WHY_WORDS + '. Say what forced the change, what you tried first and what it rules out - words like "added", "fixed", "update" and "bug" do not count.');
      }

      if (root && buildsOnIn.length) {
        problems.push('give builds_on OR root, not both: builds_on continues earlier work, root starts a new feature. For what a new feature sits inside, use relates_to.');
      }
      if (!root && !buildsOnIn.length) {
        problems.push('say what this continues - builds_on: ["<hash>"], picked from gitx_find_related - or, if it starts something new, root: "<feature name>". With neither, "new", "forgot" and "nothing matched" would all look the same.');
      }

      const hasHead = gitOk('rev-parse', '--verify', '--quiet', 'HEAD');
      const resolveRefs = (refs, field, mustBeBehind) => refs.map((ref) => {
        if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
          problems.push(field + ': "' + ref + '" is not a commit hash (7 to 40 hex characters).');
          return null;
        }
        let full = '';
        try { full = git('rev-parse', '--verify', '--quiet', ref + '^{commit}').trim(); } catch (_) {}
        if (!full) {
          problems.push(field + ': ' + ref + ' does not name a commit in this repository (or is ambiguous - give more characters).');
          return null;
        }
        if (mustBeBehind && !(hasHead && gitOk('merge-base', '--is-ancestor', full, 'HEAD'))) {
          problems.push(field + ': ' + ref + ' is not in this branch\'s history - a commit can only build on work that is already behind it.');
          return null;
        }
        /* Written at 12 characters: a 7-character hash that is unique today can
         * stop being unique as the history grows, and an ambiguous trailer is a
         * link that resolves to whichever commit happens to be found first. */
        return git('rev-parse', '--short=12', full).trim();
      }).filter(Boolean);
      const buildsOn = resolveRefs(buildsOnIn, 'builds_on', true);
      const relatesTo = resolveRefs(relatesIn, 'relates_to', false);

      /* The thoughts this commit settles. Each must be waiting in the context
       * graph as a decision or cost - that is what a commit carries out; the
       * rest comes with it. One already in the thought graph was settled by an
       * earlier commit, and one on record nowhere is a typo that would promote
       * nothing without a word. */
      const thoughtIds = [...new Set(list(args.thoughts))];
      if (thoughtIds.length) {
        const waiting = new Map(loadThoughts(dir, { store: 'context' }).thoughts.map((t) => [t.id, t]));
        const settled = new Set(loadThoughts(dir).thoughts.map((t) => t.id));
        for (const id of thoughtIds) {
          const t = waiting.get(id);
          if (!/^t-[0-9a-f]{10}$/.test(id)) problems.push('thoughts: "' + id + '" is not a thought id (t- and ten hex characters).');
          else if (settled.has(id)) problems.push('thoughts: ' + id + ' is already in the thought graph - an earlier commit settled it.');
          else if (!t) problems.push('thoughts: ' + id + ' is not in the context graph - gitx_thought with outcome accepted lists what is waiting.');
          else if (!(t.outcome === 'accepted' && (t.kind === 'decision' || t.kind === 'cost'))) problems.push('thoughts: ' + id + ' is ' + t.outcome + ' ' + t.kind + ' - name the decisions and costs this commit carries out; the findings, alternatives and costs that made them happen come with them.');
        }
      }

      /* One name, one start. A second root under a name already in use makes
       * "where does this feature begin" ambiguous - the one question a root
       * exists to answer. Read from the index, which parses every commit's
       * trailers exactly the way retrieval does. */
      let index = null;
      if (root && hasHead) {
        index = loadOrBuildIndex(dir).index;
        const taken = index.commits.find((c) => c.root === root);
        if (taken) {
          problems.push('root "' + root + '" was already started by ' + taken.short + ' ("' + taken.subject + '"). If this continues that feature, use builds_on: ["' + taken.short + '"]; if it is genuinely separate, choose another name.');
        }
      }

      let staged = false;
      try { git('diff', '--cached', '--quiet'); } catch (_) { staged = true; }
      if (!staged) problems.push('nothing is staged. Stage exactly what this commit should contain (git add <files>) and call again - the commit takes the staged changes and nothing else.');

      if (problems.length) return reply({ ok: false, committed: false, problems });

      /* Scans the staged bytes - what the commit will actually contain - not the
       * working copy, which can differ. */
      const shield = scanStaged(dir);
      if (!shield.allowed) {
        return reply({
          ok: false,
          committed: false,
          blocked_by: 'GitX Secret Shield',
          error: shield.reason,
          action_required: 'Unstage the file (git restore --staged <file>) or remove the secret and stage it again, then call again.'
        });
      }

      /* "This is new" is the one claim nothing downstream can check, so it is the
       * one asked about BEFORE the commit exists - afterwards the message is
       * immutable. Every earlier commit sharing code or distinctive words with the
       * staged change is shown, and the root is only written once the caller has
       * looked and confirmed none of them is what this continues.
       *
       * No score threshold decides it: any overlap at all asks. In a busy
       * repository most roots will take two calls. That friction is deliberate
       * and cheap; a threshold would be an untested constant quietly deciding
       * which near-misses an agent never gets to see. */
      if (root && hasHead && !rootConfirmed) {
        index = index || loadOrBuildIndex(dir).index;
        const { results } = findRelated(index, { regions: stagedRegions(dir), description: subject + '\n' + why, limit: 3 });
        if (results.length) {
          return reply({
            ok: false,
            committed: false,
            needs_confirmation: true,
            message: 'Not committed yet. You marked this as the start of a new feature, but these earlier commits share code or wording with it. If one of them is what this continues, call again with builds_on: [its hash] instead of root. If it is genuinely new, call again with root_confirmed: true - and use relates_to for any of them it only sits beside.',
            candidates: results.map((r) => ({
              hash: r.short,
              date: r.date,
              subject: r.subject,
              score: r.score,
              shared_regions: r.shared_regions,
              shared_words: r.shared_words,
              why: r.why,
              root: r.root
            }))
          });
        }
      }

      const header = type + (scope ? '(' + scope + ')' : '') + ': ' + subject;
      const trailers = [
        ...buildsOn.map((h) => 'GitX-Builds-On: ' + h),
        ...(root ? ['GitX-Root: ' + root] : []),
        ...relatesTo.map((h) => 'GitX-Relates-To: ' + h),
        ...(thoughtIds.length ? ['GitX-Thoughts: ' + thoughtIds.join(', ')] : [])
      ];
      const message = [header, why, ...(verification ? ['Verified: ' + verification] : []), trailers.join('\n')].join('\n\n') + '\n';

      /* Read back with the same parser the index uses AND with git's own trailer
       * parser, before committing. If either would miss a link, that is found
       * while the message can still be changed - not later, as a chain that
       * silently stops early. */
      const readBack = parseMessage(header, message);
      let gitRead = [];
      try {
        gitRead = execFileSync('git', ['interpret-trailers', '--parse'], { cwd: dir, input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
          .split('\n').filter((l) => /^GitX-/i.test(l));
      } catch (_) {}
      if (readBack.trailers.length !== buildsOn.length + relatesTo.length || (readBack.root || '') !== root || readBack.thoughts.length !== thoughtIds.length || gitRead.length !== trailers.length) {
        return reply({
          ok: false,
          committed: false,
          error: 'The composed message would not read back correctly, so nothing was committed.',
          message,
          gitx_read: { links: readBack.trailers, root: readBack.root },
          git_read: gitRead
        });
      }

      try {
        execFileSync('git', ['commit', '--cleanup=whitespace', '-F', '-'], { cwd: dir, input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
      } catch (err) {
        return reply({ ok: false, committed: false, error: 'git commit failed: ' + String(err.stderr || err.stdout || err.message).trim(), message });
      }

      const hash = git('rev-parse', 'HEAD').trim();
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const files = git('show', '--name-status', '--format=', 'HEAD').split('\n').map((l) => l.trim()).filter(Boolean);

      /* Settled now, not left to the broker: it may not be running. It is the
       * same code the broker runs when HEAD moves, and whichever gets there
       * second finds nothing left to move. */
      let promotion;
      if (thoughtIds.length) {
        try { promotion = describePromotion(promote(dir, hash, thoughtIds)); } catch (err) { promotion = 'not settled: ' + err.message + ' - the broker retries when it next reads git'; }
      }

      /* Same message type the dashboard already listens for. The fields it
       * expects are filled from real data - the why, the links, the files git
       * actually committed - never from placeholder text. */
      sendToBroker({
        type: 'COMMIT_CHRONICLE',
        agentId: AGENT_ID,
        stream: scope || 'Core',
        summary: header,
        motive: why,
        architecture: trailers.join('\n'),
        filesManifest: files.map((l) => l.split('\t').pop()),
        verification,
        commitHash: hash,
        branch
      });

      return reply({
        ok: true,
        committed: true,
        commit: hash.slice(0, 12),
        branch,
        repo: dir,
        message,
        links: { builds_on: buildsOn, relates_to: relatesTo, root: root || null },
        thoughts: promotion,
        files,
        checks: [
          buildsOn.length
            ? 'builds_on: every hash resolved and is behind HEAD'
            : 'root: "' + root + '" was not taken' + (rootConfirmed ? ', and you confirmed it is new after seeing the candidates' : ''),
          'why: ' + whyWords.size + ' usable words',
          'staged content scanned for secrets: clean (' + (shield.files || []).length + ' file(s))',
          'GitX and git both read the trailers back'
        ],
        next: root ? 'Later commits in this feature should use builds_on: ["' + hash.slice(0, 12) + '"].' : undefined,
        note: 'Committed locally only - nothing was pushed.'
      });
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
      const { qWords, results, regionSource, matchedRegions } = findRelated(index, {
        regions: qRegions,
        description: args.description || '',
        paths: args.paths,
        limit: args.limit || 10
      });

      const regionList = Object.keys(qRegions);
      const notes = [];
      if (regionSource === 'none') {
        notes.push('Ranked on your description ALONE - nothing staged and no paths given, so the code half of the search contributed nothing. Pass paths: ["the/file.js"] for the area you are working in; it is normally the stronger of the two signals.');
      } else if (regionSource === 'paths' && !matchedRegions) {
        notes.push('None of the paths you gave matched anything in this repository - check the spelling, or that they exist on this branch.');
      }
      if (!qWords.length && args.description) {
        notes.push('Your description contributed nothing: every word in it was either too common in this repo or a stopword. Ranked on staged code alone.');
      }
      if (!results.length) {
        notes.push('No prior commit shares a region or a distinctive word with this work. That usually means it is genuinely new - mark it as the start of a feature (root in gitx_commit_chronicle, or GitX-Root: <name> in a message) rather than inventing a link.');
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
            /* Which half carried the query. A caller cannot otherwise tell a
             * genuinely weak result from one scored on text alone - and that
             * ambiguity is exactly what made two benchmark runs hard to read. */
            region_source: regionSource,
            regions_matched: matchedRegions,
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
              'If none of these is what your work continues, it starts something new: write GitX-Root: <feature name> instead of GitX-Builds-On. Use GitX-Relates-To: <hash> for a commit that is related but is not the one you build on.',
              'Specific nouns matter far more than length. Words like "added", "fixed", "update" and "bug" are discarded outright, so a long message built from them scores exactly the same as an empty one.',
              'gitx_commit_chronicle writes this whole shape from fields, checks every hash, and commits exactly what is staged.'
            ].join('\n'),
            notes: notes.length ? notes : undefined
          }, null, 2)
        }]
      };
    }

    case 'gitx_graph_map':
    case 'gitx_graph_area':
    case 'gitx_graph_chain':
    case 'gitx_graph_commit': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.', repo: null });

      /* Read-only, like find_related: the index is the temp-dir cache and the
       * .gitx/commits messages are only read. Nothing is written into the repo. */
      const graph = loadGraph(target.dir);
      const head = { repo: target.dir, index_rebuilt: graph.index_rebuilt };
      if (name === 'gitx_graph_map') return reply({ ...head, ...graphMap(graph) });
      if (name === 'gitx_graph_area') return reply({ ...head, ...graphArea(graph, args.name) });
      if (name === 'gitx_graph_chain') return reply({ ...head, ...graphChain(graph, args.hash, args.limit) });
      return reply({ ...head, ...graphCommit(graph, args.hash) });
    }

    case 'gitx_thought_history': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.' });
      return reply({ repo: target.dir, ...readLog(target.dir, { id: args.id, limit: args.limit, dataDir: logDataDir() }) });
    }

    case 'gitx_thought_record': {
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!args.cwd) return reply({ ok: false, recorded: false, error: 'cwd is required: the absolute path of the repository the thinking is about. Nothing was recorded.' });
      const target = resolveTargetRepo(args.cwd);
      if (!target.ok) return reply({ ok: false, recorded: false, error: 'No such folder: ' + target.requested + ' - nothing was recorded.' });
      /* Thoughts are private to whoever owns this clone. */
      ensureGitignored(target.dir);
      return reply({ repo: target.dir, ...recordThoughts(target.dir, args, { agent: AGENT_ID, name: AGENT_NAME, model: AGENT_MODEL, session: 'mcp-' + AGENT_ID }) });
    }

    case 'gitx_related': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.', repo: null });
      /* Read-only: the commit index is the temp-dir cache, thoughts are only read. */
      const out = related(target.dir, args);
      lastMonitor = out._monitor || null;
      delete out._monitor;
      return reply({ repo: target.dir, ...out });
    }

    case 'gitx_thought':
    case 'gitx_thought_catch_up': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.', repo: null });
      /* Read-only: thoughts, drafts and git are only read, nothing is written. */
      const head = { repo: target.dir };
      if (name === 'gitx_thought') return reply({ ...head, ...readThought(target.dir, args) });
      return reply({ ...head, ...catchUp(target.dir, args) });
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
/* The agent closed the session: the prompt it was walking, it left. The
 * broker covers a process ended without warning, when this never runs. */
rl.on('close', () => paths.end());

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
      paths.start(params && params.clientInfo, { id: AGENT_ID, name: AGENT_NAME, model: AGENT_MODEL });
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
      let result = null, failure = null;
      try {
        result = await handleToolCall(toolName, toolArgs);
        sendResponse({ jsonrpc: '2.0', id, result });
      } catch (err) {
        failure = err;
        sendResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message }
        });
      }
      /* After the answer has gone, so recording never delays or fails a call. */
      paths.onCall(toolName, toolArgs, resolveTargetRepo(toolArgs.cwd).dir, result, failure, lastMonitor);
      lastMonitor = null;
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
