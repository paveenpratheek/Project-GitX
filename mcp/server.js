import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { NO_CONSOLE } from './tools/no-console.js';
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
import { related, buildRankIndex, summaryOf } from './tools/rank.js';
import { expandRegion, findText, warm } from './tools/code-find.js';
import { newSessions, askPooled, prefetch } from './tools/session-pool.js';
import { askSubjects } from './tools/ask-subjects.js';
import { instructionsFor } from './lens/subjects.js';
import { lensModel } from './lens/lens.js';
import { commitCode } from './tools/commit-code.js';
/* The path taken for each prompt (t-50e40ce534): what GitX did with an agent's
 * question and where the agent went next, kept per prompt and streamed to the
 * broker for GitX Monitor. Its own module and folder; the only coupling is the
 * calls below. It replaced the trail recorder, which kept every call. */
import { PathRecorder } from './tools/path-recorder.js';
import { markTargets } from './tools/mark.js';
import { loadMarks, createMark, judgeMark, linkMark, joinMark, relatedMarks, marksOn, viewOf, publicView, seedFromAgentFiles, marksForAnswer, walkHint, recordOf, startScan, markedSoFar, isReady, READY_HOW, INVESTIGATE_HOW, featureKey, featureMarks, setupMap, startSetup, readSpans, partsOpened, SETUP_HOW } from './tools/marks.js';
const paths = new PathRecorder({ send: (msg) => sendToBroker(msg), dataDir: () => logDataDir() });
process.on('exit', () => paths.end());
/* What gitx_search did, for the path recorder; never part of the agent's answer. */
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
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { windowsHide: NO_CONSOLE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return process.cwd();
  }
}

const ROOT_DIR = getRepoRoot();

/* The build this server runs, against the repository asked about. An agent
 * reading an older checkout of GitX met tools and behaviour its record said
 * did not exist - instructions, subjects, gitx_find - and spent its effort
 * reconciling them (debriefs, 15 October). When the two are the same project
 * at different commits, the first answer says so. */
const gitIn = (dir, args) => { try { return execFileSync('git', args, { cwd: dir, windowsHide: NO_CONSOLE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; } };
const buildOf = (dir) => ({ head: gitIn(dir, ['rev-parse', 'HEAD']), date: gitIn(dir, ['log', '-1', '--format=%cs']), root: gitIn(dir, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').pop() });
const SERVER_BUILD = buildOf(path.join(path.dirname(__filename), '..'));
const buildNoted = new Set();
function serverNote(targetDir) {
  if (buildNoted.has(targetDir) || !SERVER_BUILD.head) return {};
  buildNoted.add(targetDir);
  const t = buildOf(targetDir);
  if (!t.head || t.root !== SERVER_BUILD.root || t.head === SERVER_BUILD.head) return {};
  return { server_build: 'This GitX server runs GitX at ' + SERVER_BUILD.head.slice(0, 7) + ' (' + SERVER_BUILD.date + '); the repository you are asking about is GitX at ' + t.head.slice(0, 7) + ' (' + t.date + '). Tools and behaviour you see may be newer than this repository\'s code and record - answer about the repository from its record, not from how this server behaves.' };
}

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

/* Who starts the broker. It was this server, whenever it found none (the
 * owner, 7 October), so GitX Monitor worked without anyone typing
 * `npm run broker` - but then a broker stopped on purpose came back seconds
 * later, started by whichever agent's server noticed first. ter-manager now
 * looks after it (8 October): it is hosted as a Local Host kept running,
 * started and stopped there, and restarted there when it stops any other
 * way. So this server starts one only when asked, with
 * GITX_BROKER_AUTOSTART=1 - a test on a spare port, or GitX without
 * ter-manager - and then at most once a minute, detached, its output in
 * broker.log; a broker that loses the port to another leaves on its own. */
const BROKER_AUTOSTART = process.env.GITX_BROKER_AUTOSTART === '1';
let brokerStartedAt = 0;
function startBroker() {
  if (!BROKER_AUTOSTART || Date.now() - brokerStartedAt < 60000) return;
  brokerStartedAt = Date.now();
  try {
    const dir = paths.base || logDataDir() || path.join(os.tmpdir(), 'gitx');
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'broker.log');
    const out = fs.openSync(log, 'a');
    fs.writeSync(out, '\n[GitX MCP] ' + new Date().toISOString() + ' - no broker at ' + BROKER_WS + ', started by ' + AGENT_NAME + '\n');
    const child = spawn(process.execPath, [path.join(path.dirname(__filename), 'broker.js')], {
      cwd: path.join(path.dirname(__filename), '..'), detached: true, windowsHide: true, stdio: ['ignore', out, out],
      /* Detached is no console, so the broker's git calls need windowsHide - see no-console.js. */
      env: { ...process.env, GITX_NO_CONSOLE: '1', ...(process.env.GITX_BROKER_URL ? { GITX_BROKER_PORT: new URL(BROKER_WS).port } : {}) }
    });
    child.unref();
    fs.closeSync(out);
    process.stderr.write('[GitX MCP] No broker at ' + BROKER_WS + ' - started one (pid ' + child.pid + '); its output is in ' + log + '\n');
  } catch (err) {
    process.stderr.write('[GitX MCP] Could not start the broker: ' + err.message + '\n');
  }
}

/* What the Monitor is told while the broker is away - starting, or between
 * two of them - is held and sent when it is back, in order: an 'ask' lost
 * here leaves every later step of that path with no card to land on. */
const MONITOR_HELD = 200;
let held = [];

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
      const waiting = held;
      held = [];
      for (const m of waiting) sendToBroker(m);
    });

    brokerWs.on('error', () => {
      brokerReady = false;
    });

    brokerWs.on('close', () => {
      brokerReady = false;
      startBroker();
      setTimeout(connectBroker, 3000);
    });
  } catch (_) {
    brokerReady = false;
  }
}

connectBroker();

function sendToBroker(payload) {
  if (brokerWs && brokerReady) {
    try { brokerWs.send(JSON.stringify(payload)); return; } catch (_) {}
  }
  if (payload && payload.type === 'GITX_MONITOR') {
    held.push(payload);
    if (held.length > MONITOR_HELD) held.shift();
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
  /* Where the answer was, after a search (tools/mark.js): the next agent
   * asking something like it is shown it first. */
  {
    name: 'gitx_mark',
    description: 'Leave what you learned on the code you learned it from, so the next agent starts there: { "to": "server.js:321", "note": "the shell list is built once at startup" }. Mark when you worked something out that took reading several places or that the code does not say plainly - never what a name already says. Without a note it says where the answer to your last gitx_search was. The marks already on that code come back first: confirm one ({ "confirm": "m-..." }) or contradict it with your evidence ({ "contradict": "m-...", "note": "..." }) rather than writing a second. A feature in several places is ONE mark: name them all in to ({ "to": ["app.js::applyWallpaper", "app.css:40"], "note": "..." }); found the same thing a mark already says in other code? add your code to it ({ "join": "m-...", "to": ["notes.js::render"] }). A mark is shown as inferred, never as a decision.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: ['string', 'array'], items: { type: 'string' }, description: 'The code you learned about: file:line, a range (file:from-to), a function (app.js::fontChoice), a thought id, a commit hash, or a mark id (m-...) to link from - or several.' },
        note: { type: 'string', description: 'What you learned there, in one or two sentences, for the next agent.' },
        confirm: { type: 'string', description: 'A mark id (m-...) you checked and found holds.' },
        contradict: { type: 'string', description: 'A mark id (m-...) you found wrong - say why in note.' },
        link: { type: 'array', items: { type: 'string' }, description: 'Other code or marks this belongs with: file:line, a function, a mark id.' },
        as: { type: 'string', enum: ['same-feature', 'calls', 'styles', 'explains'], description: 'How the link relates. Default same-feature.' },
        join: { type: 'string', description: 'A mark id (m-...): add the code in to as more places that mark is about.' },
        marks: { type: 'array', items: { type: 'object', properties: { to: { type: ['string', 'array'], items: { type: 'string' } }, note: { type: 'string' }, feature: { type: 'string' } } }, description: 'Several marks in one call: [{ "to": [...the places], "feature": "...", "note": "what they do" }, ...].' },
        feature: { type: 'string', description: 'The feature this code is part of, a short name (totem-indicators). The mark follows the last mark of that feature. Alone, without to: that feature\'s marks.' },
        about: { type: 'string', description: 'What the project is, in a few sentences, from your scan.' },
        new: { type: 'boolean', description: 'Write your mark even though marks are already on that code.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in.' }
      },
      required: []
    }
  },
  /* The entry point on a repository: what GitX holds about it, the agent
   * files read into marks, and how to work (tools/marks.js). */
  {
    name: 'gitx_investigate',
    description: 'Start here on a repository: says whether it is GitX-ready (commits with reasoning, linked thoughts and topics - then use gitx_search, nothing to mark). If it is not, you build its record as you work: the statements its CLAUDE.md, .claude/, AGENTS.md, .agent/ and README make about specific code become marks on that code, your next answer is read as your notes, and marked_so_far says what earlier agents marked and what nobody has. Read with gitx_search either way.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['setup'], description: 'setup: you are assigned to set this repository up for GitX - go through it feature by feature and mark each feature\'s code with a note. The reply is the brief and a map of what is marked.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in.' }
      },
      required: []
    }
  },
  {
    name: 'gitx_find_related',
    description: 'Finds earlier commits related to what you are working on, so you can read the reasoning behind them instead of guessing. Two uses: AFTER staging and before writing a commit message, or when ORIENTING in an unfamiliar area before changing anything. Ranks on which code regions are involved AND how you describe the work - the two reach different things, so supply both. Reads the staged diff itself; do not paste it in. gitx_search searches commits and thoughts by words; this searches by example, from staged work.',
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
    description: 'One commit in full: its whole message (and the original git subject if a fuller message was written later), what it builds on and what was built on it, its line of work and thread, and the exact files and code regions it changed. Pass code: true to go down to the code itself - the lines it added and removed, exactly as git has them, under each region - with region to read one region, file or folder whole, and today: true for where each region\'s declaration is now. Read those regions before describing how something works today.',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'Commit hash or prefix (at least 4 characters).' },
        code: { type: 'boolean', description: 'Also return the code this commit changed: its added (+) and removed (-) lines per region, largest first, up to 400 lines.' },
        region: { type: 'string', description: 'With code: only this region ("file::declaration"), file, folder ("dir/") or declaration name - returned whole.' },
        today: { type: 'boolean', description: 'With code: say where each region\'s declaration is in the working tree now, or that it was renamed or removed since.' },
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
    description: 'Call this at the START of a session in a repository, before changing anything, to pick up where the last agent or session left off. Returns: thinking recorded since the last commit (what was in progress), what the recent commits decided and turned down, where the newest reasoning is if the recent commits have none, a one-line count of the thinking waiting in the context graph (search it with gitx_search), questions still open, turned-down ideas that can come back and under what condition, ideas stashed for later, and rules learned from past corrections - which you should follow. Every empty answer says so explicitly: "no thinking on record" is a fact, not a failure. Pass since (a commit hash) to catch up on everything after a commit you already know.',
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
   * Searching by words is gitx_search's - see tools/thought-query.js. */
  {
    name: 'gitx_thought',
    description: 'Read reasoning GitX holds, by address rather than by words: one thought by id in full - every force, every link both ways, where it sits, whether a commit settled it - from the thought graph (settled) or the context graph (waiting); the thinking behind one commit; one topic\'s summary in full, with every commit that built it, its code and everything still open; every thought of an outcome or kind, or rejected ideas that can come back (reopenable), from both graphs; or the stashes. To find thinking by words, use gitx_search. An empty answer says which kind of empty it is.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One thought id (t-...) to read in full, whichever graph holds it.' },
        commit: { type: 'string', description: 'Commit hash or prefix (4+ characters): the thinking that led to this commit.' },
        topic: { type: 'string', description: 'A topic id (tp-...): its summary in full - what it does today, every commit that built it, its code, everything still open.' },
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
    name: 'gitx_search',
    description: 'Find what GitX already holds about something - commits, settled reasoning and thinking still waiting - BEFORE working it out again. Give a query (a question, a task, a draft in your own words), and optionally paths you work in. GitX answers from the code down, map first: the feature\'s core (the code that implements it), wiring (where it is connected) and surface (where it is shown) as functions with line ranges, and its own words; then its best functions as trees - the lines worth reading, no file to open; the commits that wrote those lines and why; the thoughts they settled, each with its status first (OPEN QUESTION, PROPOSED - NOT CONFIRMED, ANSWERED by <thought>, ACCEPTED - NOT BUILT, SETTLED in <commit>, REJECTED with what held it back, SUPERSEDED); the topic summary; and beside them the context graph - waiting plans, open questions and rules. With no code about it, it says so and answers from the plans. Open any map entry with expand. A follow-up question keeps the previous one\'s rare words until the subject changes. Filtering by layers, outcome or kind, or giving ids with no query, lists the older stack instead. An empty answer says so, and is not evidence nothing was considered. Ask for what you need, not everything: focus "thinking" for why and what was decided (small, no code), focus "code" for the code, a budget in tokens for a quick check, or find for an exact name, value or list - each lowers what you have to read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Your words: a question, what you are about to do, or a draft thought. Matched by meaning-bearing words across every commit and thought.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Thought ids (t-...) or commit hashes you are on or about to link to - what is linked to them ranks higher.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files, directories or "file::declaration" you work in - what touched that code ranks higher.' },
        expand: { type: 'string', description: 'A function from the map - its name as the map wrote it ("learnKeys", "learn.js · learnKeys") or a ref "file:line" - to get it as a tree: its code, the commits that wrote it and why, the thoughts they settled, what is still open. No query needed.' },
        focus: { type: 'string', enum: ['thinking', 'code', 'both'], description: 'What you need back. "thinking": what was decided, discussed or is still open, and what each piece of code\'s commits settled - no code lines, so it is small; best for why / what did we decide / is it built. "code": the map and the code with the commits that wrote it, the thinking only counted. "both" (default): everything.' },
        lens: { type: 'string', enum: ['what', 'how', 'where', 'when', 'why'], description: 'The shape you want, when your words do not already say it: what - the parts of the subject, what each is and its key decisions (start here on an area you do not know); how - its code; where - its files and functions, no code lines; when - its commits in order, under every name it had; why - its decisions with their reasons, what was rejected, costs and open questions.' },
        budget: { type: 'number', description: 'Most tokens to send back, e.g. 800 for a quick check. The answer is cut best-first to fit, and cut says what went and how to get it - nothing is lost, only left for a later call.' },
        find: { type: 'string', description: 'Exact lookup instead of a question: text as written (case ignored) or /regex/ - for names, values, a list such as every tool or every default. Returns each matching line as file:line with the function it is in, and the thoughts that say it, by id. Pairs with paths.' },
        add: { type: 'array', items: { type: 'string' }, description: 'Words to add to the current question without asking a new one - GitX answers with what changed.' },
        drop: { type: 'array', items: { type: 'string' }, description: 'Words that took the answer the wrong way: removed, and what holds them sinks - GitX answers with what changed.' },
        new: { type: 'boolean', description: 'Treat query as a new question even if it shares words with the current one. Without it GitX decides, and says which and why.' },
        topic: { type: 'string', description: 'A topic id (tp-...) the work belongs to.' },
        layers: { type: 'array', items: { type: 'string', enum: ['commit', 'thought', 'context'] }, description: 'Only these: commit, thought (settled), context (waiting). Default all three.' },
        outcome: { type: 'array', items: { type: 'string', enum: ['accepted', 'rejected', 'stashed', 'open'] }, description: 'Only thoughts with these outcomes - "rejected" for ideas turned down, "open" for questions nobody has settled.' },
        kind: { type: 'array', items: { type: 'string', enum: ['decision', 'finding', 'cost', 'learned'] }, description: 'Only thoughts of these kinds.' },
        edge: { type: 'boolean', description: 'Also list the edge and what words alone found, one line each and cut - the rest of the stack, beyond the core.' },
        hops: { type: 'number', description: 'How far the links are pulled from the entries. Defaults to 4, at most 6.' },
        limit: { type: 'number', description: 'Most of the core to give in full; the rest of it is counted with the edge. Default: the whole core.' },
        cwd: { type: 'string', description: 'Absolute path of the repository. Defaults to the repo this MCP server was started in - pass this whenever you mean a DIFFERENT project.' }
      },
      required: []
    }
  },
  /* The one tool that writes a thought. Everything it records waits in the
   * context graph until a commit names it - see tools/record.js. */
  {
    name: 'gitx_thought_record',
    description: 'Record thinking as it happens: a decision and the alternatives it beat, a cost accepted, a finding, an open question, a rule learned from a correction. It goes to the context graph and waits there; when the commit that carries a decision out names it (GitX-Thoughts in the message, or thoughts in gitx_commit_chronicle), it moves to the thought graph with what supports it. Give kind, text (one sentence that stands on its own), outcome, decided_by for a decision, the forces behind it, and links; GitX stamps the id, the commit it was thought at, who and when. Record several at once with keys, so a decision, what lost to it (lost-to) and its cost (cost-of) link in one call; a link may also name any thought on record by id. Nothing is written unless every thought passes - a lost-to must run from a rejection to an accepted thought, a cost-of from a cost to an accepted decision, a contingent force needs revisit_if, and an exact repeat of a thought on record is refused. The reply gives each id, the topic it was filed under, the line that settles a decision, and the thoughts on record it most likely continues, repeats, answers or contradicts, each with why - link to one if so. Pass summary to rewrite a topic\'s summary, alone or beside thoughts.',
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
              topic: { type: 'string', description: 'The topic (tp-...) the thought is about. Leave it out and it is filed under the topic most of what it links to is in.' },
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
        },
        summary: {
          type: 'object',
          description: 'Rewrite a topic\'s summary in place: what that part of the project does TODAY, in a few lines (20-1200 characters). Read first by gitx_search; the reply of every record says which topics\' summaries are missing or have fallen behind.',
          properties: {
            topic: { type: 'string', description: 'The topic id (tp-...).' },
            text: { type: 'string', description: 'What it does today - not its history, which its thoughts and commits already hold.' }
          },
          required: ['topic', 'text']
        }
      },
      required: ['cwd']
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

/* 4th Dimension v3.1 (lens/ask.js): with GITX_V31=1 gitx_search takes
 * what the agent wants as structure - several lenses, the kinds to include,
 * topics, an effort - and the subject in words. */
const V31 = process.env.GITX_V31 === '1';
if (V31) {
  const rel = TOOLS.find((t) => t.name === 'gitx_search');
  const p = rel.inputSchema.properties;
  p.query.description = 'The subject in your own words - a feature, a concept, an area ("path knowledge", "the 4th Dimension"). Say what you want back with lens, include and effort instead of in the question.';
  p.lens = { type: 'array', items: { type: 'string', enum: ['what', 'how', 'where', 'when', 'why'] }, description: 'What you want back, one or several in one call: what - its parts, what each is, one or two of every kind of thinking in each, its main code by name; how - code lines, the commits that wrote them and why, the rules, constraints and rejected ideas on that code; where - files and functions only; when - commits in order with their reasons, open questions as raised; why - decisions with reasons and evidence, rejected ideas and what held them back, constraints, rules, open questions, findings.' };
  p.include = { type: 'array', items: { type: 'string', enum: ['decided', 'rejected', 'constraint', 'rule', 'open', 'finding', 'commits', 'code'] }, description: 'Kinds to give in full beside the lens, kept to the subject - ask here for the rejected ideas, open questions or constraints you would otherwise list in another call.' };
  p.topics = { type: 'array', items: { type: 'string' }, description: 'Topic ids (tp-...) to keep to; with no query they are the subject.' };
  p.effort = { type: 'string', enum: ['brief', 'normal', 'deep'], description: 'How much: brief - a quick look (~900 tokens), normal - the default, deep - more of each kind.' };
  rel.description += ' Each answer ends with next: the calls worth making next, written as calls - copy one rather than rewording.';
}

/* 4th Dimension, subjects (lens/subjects.js, tools/ask-subjects.js): with
 * GITX_SUBJECTS=1 gitx_search takes subjects, never a question. A question in
 * words made the agent's wording the search, and a question like "can we do
 * X" asked GitX for a decision no retrieval can make: the agent names what it
 * wants the record of, GitX returns the record, the agent decides. Exact
 * lookups - a name, a value, a function - are data too, and move to
 * gitx_find. The subject list reaches the agent before its first call, in the
 * server's instructions, since the tools themselves may not be loaded yet. */
const SUBJECTS = process.env.GITX_SUBJECTS === '1';
if (SUBJECTS) {
  const rel = TOOLS.find((t) => t.name === 'gitx_search');
  const p = rel.inputSchema.properties;
  rel.description = 'The record of one or several subjects of this project - its code, the commits that wrote it and the reasoning behind them (decisions, rejected ideas with what held them back, constraints, rules, open questions). It returns what is recorded; it does not answer questions or decide: name the subjects you need the record of, from the list in GitX\'s instructions, and decide yourself. Several subjects also give where they meet - each pair and all together. Each answer ends with next: calls worth making next, ready to copy.';
  rel.inputSchema = {
    type: 'object',
    properties: {
      subjects: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Subject names from GitX\'s list - the project, a topic or a concept, by today\'s name or an old one ("path knowledge", "4th Dimension", "trails"). Not a question. A name that is not a subject here comes back with the closest ones.' },
      lens: { ...p.lens, type: 'array', items: { type: 'string', enum: ['what', 'how', 'where', 'when', 'why'] } },
      include: p.include,
      effort: p.effort,
      cwd: p.cwd
    },
    required: ['subjects']
  };
  TOOLS.push({
    name: 'gitx_find',
    description: 'An exact lookup in this project: find - text as written (case ignored) or /regex/, for a name, a value or a list such as every tool or every default - returns each matching line as file:line with its function and the thoughts that say it; expand - a function named in an answer (its map name or file:line), returned with its code, the commits that wrote it and the thoughts they settled.',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'Text as written, or /regex/.' },
        expand: { type: 'string', description: 'A function from an answer: its name as written there, or file:line.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders to keep a find to.' },
        cwd: p.cwd
      },
      required: []
    }
  });
}
const SUBJECTS_HOW = 'Answers keep to the subjects named: brief is what each is; overview its parts, each with one or two of every kind of thinking; reasons the decisions with evidence and what lost to them; included the kinds asked for in full, kept to the subject; meets the records joining subjects, "names all of them" first. Asking a subject again gives only what changed. A name that is not a subject comes back under not_subjects with the closest ones.';


/* What reaches the agent, less what it already has (the owner's trims, 6
 * October). Measured on the owner's 18 questions, a gitx_search answer was
 * ~2,500 tokens of which 11% was indentation, 274 tokens the same how_to_use
 * as last time, and 550 the same topic summaries as the last question in
 * that topic. So every answer goes out as compact JSON; each how_to_use text
 * once per session; and a topic summary once per session until it changes -
 * after that a line saying it was given and how to read it again.
 *
 * A session is this server's life, one per agent session. The page, the
 * Monitor and rank-eval call the readers directly and see everything. The
 * cost: an agent whose context is compacted mid-session loses what was sent
 * once - the stub names the call that reads a summary again, and each tool's
 * description still says how to use it. */
const sentOnce = { howTo: new Set(), summaries: new Map() };

/* Each repository's question pool for this session (session-pool.js). */
const sessions = newSessions();

/* The code and thought indexes are kept in memory (t-2c70a44885); when a
 * commit moves HEAD they are rebuilt here, between calls, so the agent's
 * next question does not wait for it. One git call per repository asked
 * about, every WARM_EVERY. */
const WARM_EVERY = 15000;
setInterval(() => {
  for (const dir of sessions.keys()) { try { warm(dir); } catch (_) { /* answered at the next call instead */ } }
}, WARM_EVERY).unref();
const CODE_FIRST_HOW = 'Read the map first: (Ask for less when you need less: focus "thinking" for decisions and why, focus "code" for code, budget for a cap in tokens, find for an exact name or value.) core is the code that implements it, wiring where it is connected (imports, calls, shared event names and URLs), surface where it is shown - whole functions with line ranges at HEAD - and words are the feature\'s own words. trees give the core\'s best functions in full: the lines worth reading, the commits git blame names for them with why the code is as it is, the thoughts each settled - status first - and what is still open. Open any other map entry with expand. For more, ask again with a word from words or one you read, or add / drop words: question says whether GitX took it as new or a follow-up, and why, and a follow-up gives only what changed - map entries new, back or hidden, new lines and thoughts of functions already given (given_in) - nothing twice. words are the pool\'s words with their weights. thinking holds doc sections; summaries what the topic does today; context, beside the stack, is waiting thinking - open questions, proposals, decided but not built, rules. no_code means nothing at HEAD holds the question: what is there is plans and discussion. carried names words kept from your previous question.';
/* With v3.1 the how-to leads with asking by structure: the schema says what
 * each option is, this says how they go together, once a session. */
const CODE_FIRST_HOW_V31 = 'Ask by structure, the subject in words: { "query": "<the subject>", "lens": ["what","why"], "include": ["rejected","open","constraint"], "effort": "brief" }. lens is what you want back - what (its parts and every kind of thinking in each), how (code with the commits and rules on it), where (places only), when (commits in order with reasons), why (decisions, rejected ideas, constraints, rules, open questions, evidence) - several in one call. include gives those kinds in full, kept to the subject, instead of listing them repo-wide in another call. topics keeps to parts (tp-...). effort is brief, normal or deep. Every answer ends with next: copy one of its calls rather than rewording. brief is the one-line what-it-is; the rest is the lens you asked for, nothing else. ' + CODE_FIRST_HOW;
function lean(tool, result) {
  const first = result && Array.isArray(result.content) ? result.content[0] : null;
  if (!first || first.type !== 'text') return result;
  let body;
  try { body = JSON.parse(first.text); } catch (_) { return result; }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (typeof body.how_to_use === 'string') {
      const key = tool + '|' + body.how_to_use;
      if (sentOnce.howTo.has(key)) delete body.how_to_use;
      else sentOnce.howTo.add(key);
    }
    if (Array.isArray(body.summaries)) {
      body.summaries = body.summaries.map((s) => {
        const key = (body.repo || '') + '|' + s.topic;
        const said = [s.summary || s.no_summary || '', s.written || '', s.since_written || ''].join('|');
        if (sentOnce.summaries.get(key) === said) {
          return { topic: s.topic, title: s.title, given: 'Earlier in this session, unchanged - gitx_thought topic ' + s.topic + ' reads it again.' };
        }
        sentOnce.summaries.set(key, said);
        return s;
      });
    }
  }
  return { ...result, content: [{ ...first, text: JSON.stringify(body) }, ...result.content.slice(1)] };
}

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
      const git = (...a) => execFileSync('git', a, { windowsHide: NO_CONSOLE, cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
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
        gitRead = execFileSync('git', ['interpret-trailers', '--parse'], { windowsHide: NO_CONSOLE, cwd: dir, input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
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
        execFileSync('git', ['commit', '--cleanup=whitespace', '-F', '-'], { windowsHide: NO_CONSOLE, cwd: dir, input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
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

    /* Where the answer was (tools/mark.js). The question it answers is the
     * agent's last search here, which the recorder is walking; the step
     * itself is written by paths.onCall after this reply, like every call. */
    case 'gitx_mark': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was marked.' });
      const data = paths.base || logDataDir();
      const by = AGENT_NAME || AGENT_ID || null;
      /* Judging a mark someone left. */
      if (args.confirm || args.contradict) {
        const r = judgeMark(target.dir, data, String(args.confirm || args.contradict), args.contradict ? 'contradict' : 'confirm', { by, note: args.note });
        if (r.error) return reply({ error: r.error });
        return reply({ [args.contradict ? 'contradicted' : 'confirmed']: publicView(viewOf(target.dir, r.mark)) });
      }
      /* A scan's notes in one call - { marks: [{ to, note }], about } - kept
       * as lite as a call can be: one reply line of counts. Near-copies are
       * not refused here; reading stacks them. */
      /* A feature's marks, for a setup agent about to mark another part of it. */
      if (args.feature && !args.to && !args.marks) {
        const fm = featureMarks(target.dir, data, args.feature);
        return reply({ feature: featureKey(args.feature), marks: fm.slice(0, 12).map(publicView), how: fm.length ? 'mark another part with the same feature and it follows ' + fm[0].id : 'no marks for this feature yet' });
      }
      /* The mark a new part of a feature follows: the feature's last. */
      const followOf = (feature) => { const fm = featureMarks(target.dir, data, feature); return fm.length ? fm[0].id : null; };
      /* Whether the agent opened every part of the code it marks (the hook's
       * read record): a feature mark on code it never read says so. */
      const spans = readSpans(target.dir, data, 0);
      const opened = (onCode) => partsOpened(spans, onCode.map((x) => x.region));
      const readOf = (feature, onCode) => { if (!feature) return {}; const o = opened(onCode); return o.none ? { unread: true } : o.missing.length ? { unread_parts: o.missing } : {}; };
      if (Array.isArray(args.marks) || args.about) {
        let made = 0, places = 0, already = 0, about;
        const rejected = [], features = [];
        for (const it of [].concat(args.marks || [])) {
          const t = markTargets(target.dir, [].concat((it && it.to) || []).map(String), it && it.note);
          rejected.push(...t.rejected);
          if (!t.note || !t.marked.length) continue;
          const onCode = t.marked.filter((x) => x.layer === 'code' && x.region);
          const feature = it.feature ? featureKey(it.feature) : null;
          const follows = feature ? followOf(feature) : null;
          const res = createMark(target.dir, data, { rs: onCode.map((x) => x.region), refs: t.marked.filter((x) => !(x.layer === 'code' && x.region)).map((x) => x.key), note: t.note, by, feature,
            question: feature ? null : 'a scan of the project', evidence: { read: feature ? 'its setup of the repository' : 'its notes from a scan', ...readOf(feature, onCode) }, links: follows ? [{ to: follows, as: 'same-feature' }] : [] });
          if (res.existed) already++; else { made++; places += onCode.length; }
          if (feature) features.push({ id: res.mark.id, feature, follows: follows && follows !== res.mark.id ? follows : undefined });
        }
        if (args.about) about = publicView(viewOf(target.dir, createMark(target.dir, data, { refs: ['project'], note: String(args.about), by, evidence: { read: 'its notes from a scan' } }).mark));
        return reply({ made, on_places: places, already: already || undefined, marks: features.length ? features : undefined, about, rejected: rejected.length ? rejected : undefined });
      }
      const list = [].concat(args.to || []).map(String);
      if (!list.length) return reply({ error: 'gitx_mark takes to - the code you learned about - or confirm / contradict with a mark id.' });
      const as = ['same-feature', 'calls', 'styles', 'explains'].includes(args.as) ? args.as : 'same-feature';
      const known = new Set(loadMarks(target.dir, data).map((x) => x.id));
      const linkTo = [];
      for (const l of [].concat(args.link || []).map(String)) {
        if (known.has(l)) { linkTo.push({ to: l, as }); continue; }
        const t = markTargets(target.dir, [l]).marked[0];
        if (t) linkTo.push({ to: t.key, as });
      }
      /* Linking from marks already written. */
      const fromMarks = list.filter((x) => known.has(x));
      const linkedMarks = fromMarks.map((id) => linkMark(target.dir, data, id, linkTo)).filter((x) => x.mark).map((x) => publicView(viewOf(target.dir, x.mark)));
      const m = markTargets(target.dir, list.filter((x) => !known.has(x)), args.note);
      const walking = paths.current.get(target.dir);
      const asked = walking && !walking.started_by && !walking.ended_at && walking.question ? walking.question.query : null;
      /* With a note, a stored mark - unless marks are already on that code
       * and the agent did not ask for a second (docs/agent-marks-plan.md). */
      /* With a note, ONE mark on every place named - a feature in several
       * functions or files is one thing learned - unless marks are already on
       * that code, or say the same elsewhere, and the agent did not ask for a
       * second (docs/agent-marks-plan.md). */
      const made = [], here = [], like = [];
      const onCode = m.marked.filter((x) => x.layer === 'code' && x.region);
      const elsewhere = m.marked.filter((x) => !(x.layer === 'code' && x.region)).map((x) => x.key);
      let joined;
      if (args.join) {
        const r = joinMark(target.dir, data, String(args.join), onCode.map((x) => x.region));
        if (r.error) return reply({ error: r.error });
        joined = { places_added: r.added, mark: publicView(viewOf(target.dir, r.mark)) };
      } else if (m.note && m.marked.length) {
        /* A feature's part is deliberate: it is written, and follows the
         * feature's last mark; any other note waits on marks already there. */
        const feature = args.feature ? featureKey(args.feature) : null;
        const rel = feature ? { on: [], like: [] } : relatedMarks(target.dir, data, { regions: onCode.map((x) => x.key), note: m.note });
        if ((rel.on.length || rel.like.length) && !args.new) { here.push(...rel.on.map(publicView)); like.push(...rel.like.map(publicView)); }
        else {
          const follows = feature ? followOf(feature) : null;
          const res = createMark(target.dir, data, { rs: onCode.map((x) => x.region), refs: elsewhere, note: m.note, by, question: asked, feature,
            evidence: { read: feature ? 'its setup of the repository' : m.marked.length > 1 ? m.marked.length + ' places read together' : m.marked[0].name, ...readOf(feature, onCode) }, links: [...linkTo, ...(follows ? [{ to: follows, as: 'same-feature' }] : [])] });
          made.push({ ...publicView(viewOf(target.dir, res.mark)), follows: follows && follows !== res.mark.id ? follows : undefined });
        }
      }
      return reply({
        ...(m.marked.length && !m.note && !args.join ? { linked: (asked ? '"' + String(asked).slice(0, 80) + '"' : 'no gitx_search before this - marks teach only the search they follow') + ' -> ' + m.marked.map((x) => x.name).join('; ') } : {}),
        marked: m.marked.length ? m.marked.map((x) => ({ key: x.key, layer: x.layer, name: x.name, also: x.also })) : undefined,
        made: made.length ? made : undefined,
        joined,
        already_here: here.length ? here : undefined,
        says_the_same: like.length ? like : undefined,
        ...(here.length || like.length ? { how: 'marks are already on that code or say the same elsewhere: confirm one ({ "confirm": "m-..." }), contradict it ({ "contradict": "m-...", "note": "why" }), add your code to it ({ "join": "m-...", "to": [...] }), or write yours with new: true' } : {}),
        linked_marks: linkedMarks.length ? linkedMarks : undefined,
        rejected: m.rejected.length ? m.rejected : undefined
      });
    }

    /* The entry point on a repository (tools/marks.js). */
    case 'gitx_investigate': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.' });
      const data = paths.base || logDataDir();
      /* GitX-ready: the record is there and gitx_search reads it - nothing
       * to seed, nothing to mark. */
      const rec = recordOf(target.dir, data);
      if (isReady(rec)) return reply({ repo: target.dir, state: rec.state, record: rec.record, ready: true, how: READY_HOW });
      const seeded = seedFromAgentFiles(target.dir, data, { by: AGENT_NAME || AGENT_ID || null });
      /* Setup mode: this agent is assigned to set the repository up - mark
       * every feature's code with a note. Its marks are explicit, so its
       * answer is not also read as notes. */
      if (args.mode === 'setup') try { startSetup(target.dir, data, AGENT_NAME || AGENT_ID || null); } catch (_) { /* the brief alone */ }
      if (args.mode === 'setup') return reply({ repo: target.dir, state: rec.state, ready: false, mode: 'setup', ...setupMap(target.dir, data), agent_files: seeded.files, how: SETUP_HOW });
      /* Marking starts here: this agent's next final answer is read as its notes. */
      try { startScan(target.dir, data, AGENT_NAME || AGENT_ID || null); } catch (_) { /* the reply alone */ }
      return reply({ repo: target.dir, ...recordOf(target.dir, data), ready: false, marked_so_far: markedSoFar(target.dir, data), agent_files: seeded.files, seeded: { new_marks: seeded.made, on_places: seeded.places, statements: seeded.statements, naming_code: seeded.statements - seeded.no_code - seeded.lists, lists_skipped: seeded.lists, left_to_you: seeded.no_code }, how: INVESTIGATE_HOW });
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
      /* What agents and the agent files say about the code being changed. */
      let marksHere = [];
      try {
        const files = [...regionList.map((k) => k.split('::')[0]), ...[].concat(args.paths || []).map((x) => String(x).split('::')[0])];
        marksHere = marksOn(target.dir, paths.base || logDataDir(), { files }).slice(0, 8).map(publicView);
      } catch (_) { /* commits alone */ }
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
            ...(marksHere.length ? { marks_here: marksHere } : {}),
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
      const commit = graphCommit(graph, args.hash);
      if (!args.code || commit.error) return reply({ ...head, ...commit });
      /* Down a layer (t-4f0de6c907): the code under the commit, in place of
       * the region names, which the code repeats with its lines. */
      const { regions, how_to_use, ...rest } = commit;
      return reply({
        ...head, ...rest,
        ...commitCode(target.dir, commit.hash, { region: args.region, today: !!args.today }),
        how_to_use: 'code is what this commit added (+) and removed (-), exactly as git has it, under the region the index names - "at" is where those lines were in that commit. With today: true each region says where its declaration is now, or that it is gone. The message says what was intended; the code is what was done. Before describing how something works TODAY, read the file where today points.'
      });
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

    /* gitx_related was this tool's name until 15 October: still answered, so a
     * session or skill written for it keeps working, but no longer listed. */
    case 'gitx_related':
    case 'gitx_search': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.', repo: null });
      /* Read-only: the commit index is the temp-dir cache, thoughts are only read. */
      /* A question in words enters at the code (t-e688562831): the regions at
       * HEAD it is about, then the commits that wrote them and the thoughts
       * they settled, with the context graph beside. The previous question's
       * rare words ride along until the subject changes (t-71baf0316b). A
       * listing - by layer, outcome or kind, by ids with no words, the edge -
       * is still the stack's to answer. */
      /* A name from the map opened as a tree (t-da800103d5), with the last
       * question's words choosing its lines and thoughts. */
      /* An exact lookup: where, not an essay (code-find.js findText). */
      if (args.find) return reply({ repo: target.dir, ...findText(target.dir, String(args.find), { paths: args.paths }) });
      /* By subject: the record of what the agent named, never a question. */
      if (SUBJECTS && !args.expand) {
        const named = [].concat(args.subjects || []).map((x) => String(x || '').trim()).filter(Boolean);
        if (!named.length) {
          let list = [];
          try { list = instructionsFor(lensModel(target.dir)); } catch (_) { /* the error alone */ }
          return reply({ repo: target.dir, error: 'gitx_search takes subjects, not a question: name what you need the record of, and decide yourself from what comes back.' + (args.query ? ' "' + String(args.query).slice(0, 80) + '" was not searched.' : ''), how: list });
        }
        /* The walk is keyed by the subjects, so learning is per subject. */
        args.query = named.join(', ');
        const r = askSubjects(sessions, target.dir, { subjects: named, lens: args.lens || null, include: args.include || null, effort: args.effort || null, dataDir: paths.base || logDataDir() });
        lastMonitor = r.monitor;
        return reply({ repo: target.dir, ...serverNote(target.dir), ...r.answer, how_to_use: SUBJECTS_HOW });
      }
      if (args.expand) {
        const pool = (sessions.get(target.dir) || {}).pool;
        const words = pool ? [...pool.weights].filter(([, m]) => m >= 0.5).map(([w]) => w).join(' ') : '';
        const opened = expandRegion(target.dir, String(args.expand), { query: words });
        let onIt = [];
        try { onIt = marksForAnswer(target.dir, paths.base || logDataDir(), { trees: opened.expanded || [] }, ''); } catch (_) { /* the tree alone */ }
        return reply({ repo: target.dir, ...opened, ...(onIt.length ? { marks: onIt } : {}) });
      }
      /* Through the session's pool (t-2c70a44885): a question new or a
       * follow-up, decided and said; a follow-up, add or drop answered with
       * what changed. */
      const words = String(args.query || '').trim();
      const refine = (Array.isArray(args.add) ? args.add.length : args.add) || (Array.isArray(args.drop) ? args.drop.length : args.drop);
      if ((words || refine || (V31 && Array.isArray(args.topics) && args.topics.length)) && !args.layers && !args.outcome && !args.kind && !args.edge && !args.hops) {
        const r = askPooled(sessions, target.dir, { query: words, add: args.add, drop: args.drop, fresh: !!args.new, paths: args.paths, dataDir: paths.base || logDataDir(), focus: args.focus, budget: Number(args.budget) || 0, lensAs: args.lens || null, ...(V31 ? { include: args.include, topics: args.topics, effort: args.effort } : {}) });
        lastMonitor = r.monitor;
        /* The suggested words' follow-ups, worked out while the agent reads. */
        prefetch(sessions, target.dir);
        /* Marks on the code the answer landed on, and when to walk instead
         * (tools/marks.js). Each only when there is one. */
        let marks, walk;
        try { marks = marksForAnswer(target.dir, paths.base || logDataDir(), r.answer, words); walk = walkHint(target.dir, words, args.lens, r.answer); } catch (_) { /* the answer alone */ }
        return reply({ repo: target.dir, ...serverNote(target.dir), ...r.answer, ...(marks && marks.length ? { marks } : {}), ...(walk ? { walk } : {}), how_to_use: V31 ? CODE_FIRST_HOW_V31 : CODE_FIRST_HOW });
      }
      /* Learned keys come from the path files this server's recorder writes,
       * so they are read from the folder it resolved (t-4f44aa05bb). */
      const out = related(target.dir, args, { dataDir: paths.base || logDataDir() });
      lastMonitor = out._monitor || null;
      delete out._monitor;
      return reply({ repo: target.dir, ...out });
    }

    case 'gitx_find': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.', repo: null });
      if (args.find) return reply({ repo: target.dir, ...findText(target.dir, String(args.find), { paths: args.paths }) });
      if (args.expand) {
        const pool = (sessions.get(target.dir) || {}).pool;
        const words = pool ? [...pool.weights].filter(([, m]) => m >= 0.5).map(([w]) => w).join(' ') : '';
        const opened = expandRegion(target.dir, String(args.expand), { query: words });
        let onIt = [];
        try { onIt = marksForAnswer(target.dir, paths.base || logDataDir(), { trees: opened.expanded || [] }, ''); } catch (_) { /* the tree alone */ }
        return reply({ repo: target.dir, ...opened, ...(onIt.length ? { marks: onIt } : {}) });
      }
      return reply({ repo: target.dir, error: 'gitx_find takes find (text or /regex/) or expand (a function from an answer).' });
    }

    case 'gitx_thought':
    case 'gitx_thought_catch_up': {
      const target = resolveTargetRepo(args.cwd);
      const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
      if (!target.ok) return reply({ error: 'No such folder: ' + target.requested + ' - nothing was read.', repo: null });
      /* Read-only: thoughts, drafts and git are only read, nothing is written. */
      const head = { repo: target.dir };
      if (name === 'gitx_thought' && args.topic) {
        const ix = buildRankIndex(target.dir);
        const s = summaryOf(ix, String(args.topic), { full: true });
        return reply({ ...head, ...(s || { error: 'No topic "' + args.topic + '" here - one of ' + [...ix.topics.keys()].join(', ') + '.' }) });
      }
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
      /* What the agent reads before any tool is loaded: with subjects, what
       * GitX is for and the subjects there are (t-1f7b592df4: the server sent
       * nothing, and nothing pointed an agent to GitX). */
      let instructions;
      if (SUBJECTS) { try { instructions = instructionsFor(lensModel(ROOT_DIR)); } catch (_) { instructions = undefined; } }
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'gitx-mcp-server', version: '1.0.0' },
          ...(instructions ? { instructions } : {})
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
        result = lean(toolName, await handleToolCall(toolName, toolArgs));
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
