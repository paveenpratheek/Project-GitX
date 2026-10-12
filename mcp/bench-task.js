/*
 * The task half of the bench: how well can an agent come to know the 4th
 * Dimension through GitX alone?
 *
 * Each agent is told it is assigned to add "feature X" to the 5th Dimension,
 * which is built on top of the 4th - and that before any work it must know
 * the 4th. Feature X does not exist; the assignment is only the motive. The
 * agent has GitX's read tools and nothing else - no Read, Grep or git, and
 * nothing it can write - and asks as many questions and follow-ups as it
 * wants. It ends by listing the ids GitX showed it that matter for the work.
 *
 *   node mcp/bench-task.js [--arms=gitx,thermal] [--chains=2] [--agents=5]
 *        [--model=claude-sonnet-5-5] [--minutes=25] [--at=<commit>] [--base=master]
 *        [--walks-root=<dir>]
 *
 * A chain is agents one after another sharing one walk folder, so each
 * learns from the ones before it; chains and arms run side by side and
 * share nothing.
 *
 * The answer key is the 4th Dimension's own record in the frozen copy: the
 * thoughts anchored on it or settled by its commits (base..at), by kind -
 * decisions, rejected or stashed ideas, costs, open questions, findings - and
 * its commits. Every run keeps the ids GitX showed and the ids the agent
 * cited, so a different key rescores the runs without asking any agent again.
 *
 * Writes only temporary folders and <repo>/.gitx/bench/runs/task-*.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeze } from './bench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const eq = (name, dflt) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : dflt; };
const ARMS = eq('arms', 'gitx,thermal').split(',');
const CHAINS = Number(eq('chains', '2'));
const AGENTS = Number(eq('agents', '5'));
const MODEL = eq('model', 'claude-sonnet-5-5');
const MINUTES = Number(eq('minutes', '25'));
const REPO = path.join(HERE, '..');
const BASE = eq('base', 'master');
const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
const AT = git(['rev-parse', eq('at', 'HEAD')]).trim();
const WALKS_ROOT = path.resolve(eq('walks-root', fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-task-walks-'))));
const SERVER = path.join(HERE, 'server.js');

const PROMPT = (dir) => [
  'You have been assigned to add feature X to the 5th Dimension of the project in ' + dir + '.',
  'The 5th Dimension is built on top of the 4th Dimension, so before any work you need to know the 4th Dimension: ' +
  'what it is, how it works, what was decided and why, what was rejected, what it costs, and what is still open.',
  'Feature X is only a placeholder - it is not in the project and not yet specified, so do not search for it; search the 4th Dimension.',
  '',
  'Use only GitX\'s MCP tools (gitx_related and the others) - you have no other way to read the project. ' +
  'Ask as many questions and follow-up questions as you need, until you know everything you would need to start the work. ' +
  'Do not write or record anything.',
  '',
  'When you are done, reply with only the ids GitX showed you that matter for this work, grouped under: Decisions, ' +
  'Rejected / avoid, Costs & constraints, Open questions, Commits, Code (file::function) - each with a few words on what it is. ' +
  'List only ids GitX actually showed you.'
].join('\n');

/* GitX's read tools only. The writing ones and the swarm's are refused. */
const ALLOW = ['mcp__gitx__gitx_related', 'mcp__gitx__gitx_thought', 'mcp__gitx__gitx_thought_history', 'mcp__gitx__gitx_thought_catch_up',
  'mcp__gitx__gitx_find_related', 'mcp__gitx__gitx_graph_map', 'mcp__gitx__gitx_graph_area', 'mcp__gitx__gitx_graph_chain', 'mcp__gitx__gitx_graph_commit'];
const DENY = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite',
  'mcp__gitx__gitx_thought_record', 'mcp__gitx__gitx_commit_chronicle', 'mcp__gitx__gitx_create_issue_with_branch',
  'mcp__gitx__gitx_get_assigned_task', 'mcp__gitx__gitx_get_swarm_status'];

/* ---------------------------------------------------------------- the key */

const BRANCH_COMMITS = git(['rev-list', BASE + '..' + AT]).split('\n').filter(Boolean);
const ALL_COMMITS = git(['rev-list', AT]).split('\n').filter(Boolean);

function keyOf(dir) {
  const on = new Set(BRANCH_COMMITS);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const key = { decisions: [], user_decisions: [], avoid: [], costs: [], open: [], findings: [], commits: BRANCH_COMMITS.map((h) => h.slice(0, 7)) };
  for (const sub of ['thoughts', path.join('context', 'thoughts')]) {
    const d = path.join(dir, '.gitx', sub);
    for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      let t; try { t = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (_) { continue; }
      const res = t.resulted_in && (t.resulted_in.commit || t.resulted_in), anc = t.anchor || {};
      if (!(on.has(res) || on.has(anc.commit) || /^4th_Dimension/.test(anc.branch || '') || anc.branch === branch)) continue;
      if (t.outcome === 'rejected' || t.outcome === 'stashed') key.avoid.push(t.id);
      else if (t.outcome === 'open') key.open.push(t.id);
      else if (t.kind === 'cost') key.costs.push(t.id);
      else if (t.kind === 'decision') { key.decisions.push(t.id); if (t.decided_by === 'user') key.user_decisions.push(t.id); }
      else key.findings.push(t.id);
    }
  }
  return key;
}

/* Ids in a text: thoughts, commits of this history, code as file::name. */
function idsIn(text) {
  const s = String(text);
  const thoughts = new Set(s.match(/\bt-[0-9a-f]{10}\b/g) || []);
  const commits = new Set();
  for (const h of s.match(/\b[0-9a-f]{7,40}\b/g) || []) { const full = ALL_COMMITS.find((c) => c.startsWith(h)); if (full) commits.add(full.slice(0, 7)); }
  const code = new Set((s.match(/[\w./-]+\.(?:js|mjs|cjs|ts|json|css|html|md)::[\w$.]+/g) || []).map((x) => x.replace(/^.*?([\w-]+\/)?([\w.-]+::)/, '$1$2')));
  return { thoughts: [...thoughts], commits: [...commits], code: [...code] };
}

function scoreRun(shown, cited, key) {
  const has = (list, x) => list.includes(x);
  const tiers = ['user_decisions', 'decisions', 'avoid', 'costs', 'open', 'findings', 'commits'];
  const out = {};
  for (const t of tiers) {
    const pool = key[t], from = t === 'commits' ? 'commits' : 'thoughts';
    out[t] = { key: pool.length, shown: pool.filter((x) => has(shown[from], x)).length, cited: pool.filter((x) => has(cited[from], x)).length };
  }
  const keyThoughts = new Set(tiers.filter((t) => t !== 'commits').flatMap((t) => key[t]));
  const citedAll = cited.thoughts.length + cited.commits.length;
  const onKey = cited.thoughts.filter((x) => keyThoughts.has(x)).length + cited.commits.filter((x) => key.commits.includes(x)).length;
  const ungrounded = [...cited.thoughts.filter((x) => !shown.thoughts.includes(x)), ...cited.commits.filter((x) => !shown.commits.includes(x))];
  return { tiers: out, cited: citedAll, cited_code: cited.code.length, on_key: onKey, precision: citedAll ? Math.round((onKey / citedAll) * 100) / 100 : 0, ungrounded };
}

/* --------------------------------------------------------------- one agent */

function runOne(arm, chain, n, walkDir) {
  const frozen = freeze(AT);
  const key = keyOf(frozen.dir);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-task-data-'));
  const mcp = { mcpServers: { gitx: { command: process.execPath, args: [SERVER], env: { GITX_DATA_DIR: walkDir, GITX_BROKER_URL: 'ws://127.0.0.1:9', GITX_AGENT_NAME: 'task ' + arm + chain + '.' + n, ...(arm === 'thermal' ? { GITX_THERMAL: '1' } : {}) } } } };
  const mcpFile = path.join(data, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp));
  /* The final answer's citations teach the walk folder, as in bench-agent. */
  const fwd = (p) => p.replace(/\\/g, '/');
  fs.mkdirSync(path.join(frozen.dir, '.claude'), { recursive: true });
  const hook = [{ type: 'command', command: 'node "' + fwd(path.join(HERE, 'hook.js')) + '" --data "' + fwd(walkDir) + '"', async: true }];
  fs.writeFileSync(path.join(frozen.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: hook }] } }, null, 2));
  const args = ['-p', PROMPT(frozen.dir), '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--setting-sources', 'project,local', '--disable-slash-commands', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', mcpFile, '--allowedTools', ...ALLOW, '--disallowedTools', ...DENY];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('claude', args, { cwd: frozen.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', err = '', result = null, model = null, denied = 0, learned = 0, shownText = '';
    const calls = [], gitxIds = new Set();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.type === 'system' && m.subtype === 'init') model = m.model;
        if (m.type === 'assistant') for (const b of (m.message && m.message.content) || []) if (b.type === 'tool_use') {
          calls.push({ tool: b.name, input: b.input });
          if (b.name.startsWith('mcp__gitx__')) gitxIds.add(b.id);
        }
        if (m.type === 'user') for (const b of (m.message && m.message.content) || []) {
          if (b.type !== 'tool_result') continue;
          const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          if (b.is_error && /permission|haven't granted|not allowed/i.test(t)) denied++;
          if (!gitxIds.has(b.tool_use_id)) continue;
          shownText += '\n' + t;
          if (/\\?"(learned|thermal)\\?":\s*\{\s*\\?"(from|reached)/.test(t)) learned++;
        }
        if (m.type === 'result') result = m;
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), MINUTES * 60 * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      const text = result ? String(result.result || '') : '';
      const u = (result && result.usage) || {};
      const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      const shown = idsIn(shownText), cited = idsIn(text);
      resolve({
        arm, chain, n, model, seconds: Math.round((Date.now() - t0) / 1000), tokens, output_tokens: u.output_tokens || 0,
        cost_usd: result ? result.total_cost_usd : null, turns: result ? result.num_turns : null,
        tool_calls: calls.length, gitx_calls: calls.filter((x) => x.tool.startsWith('mcp__gitx')).length,
        asked_feature_x: calls.filter((x) => x.tool.startsWith('mcp__gitx') && /feature\s*x\b/i.test(JSON.stringify(x.input))).length,
        other_calls: calls.filter((x) => !x.tool.startsWith('mcp__gitx') && x.tool !== 'ToolSearch').map((x) => x.tool),
        denied, learned_answers: learned,
        error: result ? (result.is_error ? result.subtype : null) : 'no result' + (err ? ': ' + err.slice(0, 200) : ''),
        score: scoreRun(shown, cited, key), shown, cited, key,
        answer: text, calls: calls.map((x) => x.tool.replace('mcp__gitx__', '') + ' ' + JSON.stringify(x.input).slice(0, 200))
      });
      for (const d of [frozen.dir, data]) fs.rmSync(d, { recursive: true, force: true });
    });
  });
}

/* ------------------------------------------------------------------ runs */

let refused = null;
const isRefusal = (r) => !r.tokens && /limit|resets/i.test(r.answer || '');
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');

function line(r) {
  const s = r.score, T = s.tiers;
  return `${(r.arm + r.chain + '.' + r.n).padEnd(11)} ${r.error ? 'ERR ' + r.error : ''}` +
    ` decisions ${T.decisions.cited}/${T.decisions.key} (user ${T.user_decisions.cited}/${T.user_decisions.key})  avoid ${T.avoid.cited}/${T.avoid.key}` +
    `  costs ${T.costs.cited}/${T.costs.key}  open ${T.open.cited}/${T.open.key}  commits ${T.commits.cited}/${T.commits.key}` +
    `  | cited ${s.cited}, on key ${pct(s.on_key, s.cited)}, ungrounded ${s.ungrounded.length}` +
    `  | ${r.seconds}s ${r.gitx_calls} gitx ${r.tokens} tok $${(r.cost_usd || 0).toFixed(2)}${r.denied ? '  DENIED ' + r.denied : ''}${r.other_calls.length ? '  OTHER ' + r.other_calls.join(',') : ''}`;
}

async function chainRun(arm, chain) {
  const walkDir = path.join(WALKS_ROOT, arm + '-' + chain);
  fs.mkdirSync(walkDir, { recursive: true });
  const rows = [];
  for (let n = 1; n <= AGENTS && !refused; n++) {
    const r = await runOne(arm, chain, n, walkDir);
    if (isRefusal(r)) { refused = r.answer; console.log('STOPPED: ' + arm + chain + '.' + n + ' was refused - ' + r.answer); break; }
    rows.push(r);
    console.log(line(r));
  }
  return rows;
}

async function main() {
  console.log(`Task bench: know the 4th Dimension through GitX alone. ${ARMS.join(', ')} x ${CHAINS} chains x ${AGENTS} agents in turn, ${MODEL}, frozen at ${AT.slice(0, 7)} (${BASE}..: ${BRANCH_COMMITS.length} commits), walks in ${WALKS_ROOT}\n`);
  const jobs = [];
  for (const arm of ARMS) for (let c = 1; c <= CHAINS; c++) jobs.push(chainRun(arm, c));
  const rows = (await Promise.all(jobs)).flat();

  console.log('\n' + ''.padEnd(26) + ARMS.map((a) => a.padEnd(18)).join(''));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const of = (arm) => rows.filter((r) => r.arm === arm && !r.error);
  const row = (label, f) => console.log(label.padEnd(26) + ARMS.map((a) => String(f(of(a))).padEnd(18)).join(''));
  const tierPct = (t) => (rs) => rs.length ? Math.round(mean(rs.map((r) => r.score.tiers[t].cited / (r.score.tiers[t].key || 1))) * 100) + '%' : '-';
  const shownPct = (t) => (rs) => rs.length ? Math.round(mean(rs.map((r) => r.score.tiers[t].shown / (r.score.tiers[t].key || 1))) * 100) + '%' : '-';
  row('agents', (rs) => rs.length);
  row('decisions cited', tierPct('decisions'));
  row('  owner decisions cited', tierPct('user_decisions'));
  row('rejected/stashed cited', tierPct('avoid'));
  row('costs cited', tierPct('costs'));
  row('open questions cited', tierPct('open'));
  row('findings cited', tierPct('findings'));
  row('commits cited', tierPct('commits'));
  row('decisions GitX showed', shownPct('decisions'));
  row('ids cited, mean', (rs) => Math.round(mean(rs.map((r) => r.score.cited))));
  row('cited on the key', (rs) => Math.round(mean(rs.map((r) => r.score.precision)) * 100) + '%');
  row('ungrounded ids, mean', (rs) => mean(rs.map((r) => r.score.ungrounded.length)).toFixed(1));
  row('gitx calls, mean', (rs) => mean(rs.map((r) => r.gitx_calls)).toFixed(1));
  row('time, mean', (rs) => Math.round(mean(rs.map((r) => r.seconds))) + ' s');
  row('tokens, mean', (rs) => Math.round(mean(rs.map((r) => r.tokens))));
  row('cost, all', (rs) => '$' + rs.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(2));
  row('denied / errors', (rs) => rs.reduce((s, r) => s + r.denied, 0) + ' / ' + rows.filter((r) => r.arm === rs[0]?.arm && r.error).length);
  console.log('\nBy place in the chain (decisions cited, mean):');
  for (const arm of ARMS) console.log('  ' + arm.padEnd(8) + Array.from({ length: AGENTS }, (_, i) => { const rs = of(arm).filter((r) => r.n === i + 1); return '#' + (i + 1) + ' ' + tierPct('decisions')(rs); }).join('   '));
  if (refused) console.log('\nRun stopped early, not a result: ' + refused);

  const dir = path.join(REPO, '.gitx', 'bench', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'task-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'gitx.bench-task/0', when: new Date().toISOString(), at: AT, base: BASE, model: MODEL, arms: ARMS, chains: CHAINS, agents: AGENTS, walks: WALKS_ROOT, aborted: refused || undefined, prompt: PROMPT('<copy>'), runs: rows }, null, 2) + '\n');
  console.log('\nSaved ' + path.relative(REPO, file));
}

main();
