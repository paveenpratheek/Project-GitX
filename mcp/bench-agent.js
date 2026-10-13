/*
 * The agent half of the bench: a fresh Claude Code agent answers each
 * question, with no memory of this project, in one of two arms -
 *
 *   hand   files and git only: Read, Grep, Glob, git log, git show
 *   gitx   the same, plus GitX's MCP tools
 *
 *   node mcp/bench-agent.js [repo] [--set heldout] [--only id,id]
 *        [--arms=hand,gitx] [--model=sonnet] [--parallel=3] [--minutes=12]
 *
 * This is System 2 against System 1 + System 2: what an agent spends
 * finding the answer itself, against what it spends when GitX hands it one.
 * bench.js measures GitX's answer alone; this measures the agent that uses
 * it, so the same questions are scored the same way - an expected id, hash
 * or function name in the agent's final answer is a hit.
 *
 * Each run is isolated, so no run teaches another and nothing touches the
 * owner's own setup:
 *   - its own frozen copy of the repository (bench.js freeze), at the set's
 *     commit, holding only the thinking that existed then - and never the
 *     question sets, which live in .gitx/bench and are not copied;
 *   - no user settings, skills or session saved (--setting-sources
 *     project,local, --disable-slash-commands, --no-session-persistence),
 *     and a fresh folder, so no auto-memory;
 *   - no MCP server but the arm's own (--strict-mcp-config): none for hand,
 *     and for gitx a GitX server on its own empty data folder, with its
 *     broker address pointed nowhere, so its walks reach neither the owner's
 *     walk folder nor GitX Monitor, nor the next run's learning;
 *   - tools allowed by name; anything else is refused, as headless asks are.
 * Every tool call is kept, and a read outside the run's copy is flagged.
 *
 * Writes only temporary folders and <repo>/.gitx/bench/runs/agent-*.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeze, score, loadCases } from './bench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const eq = (name, dflt) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : dflt; };
const ARMS = eq('arms', 'hand,gitx').split(',');
const MODEL = eq('model', 'sonnet');
const PARALLEL = Number(eq('parallel', '3'));
const MINUTES = Number(eq('minutes', '12'));
/* Learning on: one walk folder kept across every GitX agent and round, so
 * each agent's walks teach the ones after it - the loop GitX is built for.
 * Rounds run one after another; within a round, agents still run side by
 * side. Without --walks every agent has its own empty folder: learning off. */
const WALKS = eq('walks', null) ? path.resolve(eq('walks', null)) : null;
const ROUNDS = Number(eq('rounds', '1'));
const REPO = path.resolve(argv.find((a, i) => !a.startsWith('--') && !['--set', '--only', '--at'].includes(argv[i - 1])) || path.join(HERE, '..'));
const SERVER = path.join(HERE, 'server.js');

const PROMPT = (q, arm) => [
  'Answer this question about the project in the current folder:',
  '',
  '"' + q + '"',
  '',
  'Search the project to find the answer. Its code is in the working tree, its history is in the git commit messages ' +
  '(git log, git show), and its recorded design reasoning is in .gitx/thoughts/ and .gitx/context/thoughts/ - one JSON file ' +
  'per thought; .gitx is git-ignored, so give it as a path when you search it.',
  ...(arm !== 'hand' ? ['This project also has GitX MCP tools (gitx_related and others) that search its code, commits and reasoning together.'] : []),
  '',
  'Answer in a few sentences, and cite your evidence: thought ids (t-...), commit hashes, and file::function names for code.'
].join('\n');

const TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)'];
const DENY = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

function runOne(c, arm, at) {
  const frozen = freeze(at);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-agent-data-'));
  const walkDir = WALKS || data;
  /* thermal: the same GitX with thermal vision on (4th Dimension v2). */
  const mcp = arm !== 'hand'
    ? { mcpServers: { gitx: { command: process.execPath, args: [SERVER], env: { GITX_DATA_DIR: walkDir, GITX_BROKER_URL: 'ws://127.0.0.1:9', GITX_AGENT_NAME: 'bench ' + c.id, ...(arm === 'thermal' || arm === 'lens' || arm === 'lens31' ? { GITX_THERMAL: '1' } : {}), ...(arm === 'lens' || arm === 'lens31' ? { GITX_LENS: '1' } : {}), ...(arm === 'lens31' ? { GITX_V31: '1' } : {}) } } } }
    : { mcpServers: {} };
  const mcpFile = path.join(data, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp));
  /* Learning on: hook.js tells the walk folder what the agent read with its
   * own tools - most answers are found by Read, which GitX cannot see. A
   * project hook, in this run's own copy, so nothing of the owner's is set. */
  if (arm !== 'hand' && WALKS) {
    const fwd = (p) => p.replace(/\\/g, '/');
    fs.mkdirSync(path.join(frozen.dir, '.claude'), { recursive: true });
    /* Reads, edits and the final answer's citations - the same hooks for every
     * GitX arm, so they differ only in what GitX does with them. */
    const hook = [{ type: 'command', command: 'node "' + fwd(path.join(HERE, 'hook.js')) + '" --data "' + fwd(walkDir) + '"', async: true }];
    fs.writeFileSync(path.join(frozen.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Read|Edit|Write|MultiEdit', hooks: hook }], Stop: [{ hooks: hook }] } }, null, 2));
  }
  const args = ['-p', c.prompt || PROMPT(c.q, arm), '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--setting-sources', 'project,local', '--disable-slash-commands', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', mcpFile,
    '--allowedTools', ...TOOLS, ...(arm !== 'hand' ? ['mcp__gitx'] : []),
    '--disallowedTools', ...DENY];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('claude', args, { cwd: frozen.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', err = '', result = null, model = null, learned = 0, denied = 0;
    const calls = [], related = new Set();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.type === 'system' && m.subtype === 'init') model = m.model;
        if (m.type === 'assistant') for (const b of (m.message && m.message.content) || []) if (b.type === 'tool_use') {
          calls.push({ tool: b.name, input: b.input });
          if (b.name === 'mcp__gitx__gitx_related') related.add(b.id);
        }
        /* An answer that carries "learned" is one earlier walks shaped. */
        if (m.type === 'user') for (const b of (m.message && m.message.content) || []) {
          /* A denied tool makes an arm a different test: the thermal arm once
           * ran with GitX refused and read as thermal doing badly. */
          if (b.type === 'tool_result' && b.is_error && /permission|haven't granted|not allowed/i.test(typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''))) denied++;
          if (b.type !== 'tool_result' || !related.has(b.tool_use_id)) continue;
          const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
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
      /* A read outside the run's own copy would be the agent finding something
       * this test did not give it - the labels, the live repository. An agent
       * using Git Bash writes C:\ as /c/, which is read here as the same place. */
      const win = (p) => String(p).replace(/^\/([a-z])\//i, (_, d) => d + ':/');
      const inside = (p) => !p || !path.isAbsolute(win(p)) || path.resolve(win(p)).toLowerCase().startsWith(frozen.dir.toLowerCase());
      const outside = calls.filter((x) => !inside(x.input && (x.input.file_path || x.input.path)));
      const settledBy = new Map();
      const tdir = path.join(frozen.dir, '.gitx', 'thoughts');
      for (const f of fs.existsSync(tdir) ? fs.readdirSync(tdir) : []) {
        try { const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8')); const h = t.resulted_in && (t.resulted_in.commit || t.resulted_in); if (h) settledBy.set(t.id, h); } catch (_) {}
      }
      const s = score(c, { final: text }, settledBy);
      resolve({
        id: c.id, arm, model, hit: s.hit, reach: s.reach, recall: s.recall,
        seconds: Math.round((Date.now() - t0) / 1000), tokens, output_tokens: u.output_tokens || 0,
        cost_usd: result ? result.total_cost_usd : null, turns: result ? result.num_turns : null,
        tool_calls: calls.length, gitx_calls: calls.filter((x) => x.tool.startsWith('mcp__gitx')).length, learned_answers: learned, denied,
        error: result ? (result.is_error ? result.subtype : null) : 'no result' + (err ? ': ' + err.slice(0, 200) : ''),
        outside: outside.length ? outside.map((x) => x.tool + ' ' + (x.input.file_path || x.input.path)) : undefined,
        settled_by: c.prompt ? [...settledBy] : undefined,
        answer: text, calls: calls.map((x) => x.tool + ' ' + JSON.stringify(x.input).slice(0, 160))
      });
      for (const d of [frozen.dir, data]) fs.rmSync(d, { recursive: true, force: true });
    });
  });
}

/* An agent refused for a usage limit answers in seconds with no tokens: the
 * whole first learning rerun went on asking 120 of them after the limit hit,
 * and saved rounds of nothing. The first refusal stops the run. */
let refused = null;
/* A usage limit or an expired login: no tokens, and nothing after it can run. */
const isRefusal = (r) => !r.tokens && /limit|resets|authenticate|oauth|log ?in/i.test(r.answer || '');

async function runRound(k, cases, at) {
  const jobs = [];
  for (const c of cases) for (const arm of ARMS) jobs.push({ c, arm });
  console.log(`${ROUNDS > 1 ? 'Round ' + k + ' of ' + ROUNDS + ': ' : ''}${cases.length} questions x ${ARMS.join(', ')} = ${jobs.length} fresh agents, ${MODEL}, ${PARALLEL} at a time, frozen at ${at}${WALKS ? ', learning on: ' + walkCount() + ' walks so far' : ''}\n`);
  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !refused) {
      const { c: c0, arm } = jobs[next++];
      /* Round k asks the kth wording when a case has several (qs). */
      const c = c0.qs ? { ...c0, q: c0.qs[(k - 1) % c0.qs.length] } : c0;
      const r = await runOne(c, arm, at);
      if (isRefusal(r)) { refused = r.answer; console.log(`STOPPED: ${c.id} was refused - ${r.answer}`); continue; }
      rows.push(r);
      console.log(`${c.id.padEnd(20)} ${arm.padEnd(5)} ${r.error ? 'ERR ' + r.error : r.hit ? 'HIT' : r.reach ? 'via' : ' - '}  ${String(r.seconds).padStart(4)}s  ${String(r.tokens).padStart(8)} tok  ${String(r.tool_calls).padStart(3)} calls${r.gitx_calls ? ' (' + r.gitx_calls + ' gitx)' : ''}${r.outside ? '  OUTSIDE: ' + r.outside.join('; ') : ''}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  console.log('\n' + ''.padEnd(22) + ARMS.map((a) => a.padEnd(26)).join(''));
  const sum = (arm) => {
    const r = rows.filter((x) => x.arm === arm && !x.error);
    const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    return {
      runs: r.length, hit: r.filter((x) => x.hit).length, reach: r.filter((x) => x.reach).length,
      seconds_median: med(r.map((x) => x.seconds)), tokens_median: med(r.map((x) => x.tokens)), tokens_total: r.reduce((s, x) => s + x.tokens, 0),
      learned: r.filter((x) => x.learned_answers > 0).length,
      calls_median: med(r.map((x) => x.tool_calls)), cost_usd: Math.round(r.reduce((s, x) => s + (x.cost_usd || 0), 0) * 100) / 100,
      errors: rows.filter((x) => x.arm === arm && x.error).length,
      denied: rows.filter((x) => x.arm === arm && x.denied).length
    };
  };
  const S = Object.fromEntries(ARMS.map((a) => [a, sum(a)]));
  const line = (label, f) => console.log(label.padEnd(22) + ARMS.map((a) => String(f(S[a])).padEnd(26)).join(''));
  line('answer found', (x) => `${x.hit}/${x.runs}`);
  line('found, or its commit', (x) => `${x.reach}/${x.runs}`);
  line('time, median', (x) => x.seconds_median + ' s');
  line('tokens, median', (x) => x.tokens_median);
  line('tokens, all runs', (x) => x.tokens_total);
  line('tool calls, median', (x) => x.calls_median);
  line('cost (as reported)', (x) => '$' + x.cost_usd);
  if (WALKS) line('answers learning shaped', (x) => `${x.learned}/${x.runs}`);
  line('errors', (x) => x.errors);
  line('tool denied', (x) => x.denied);

  const runs = path.join(REPO, '.gitx', 'bench', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const file = path.join(runs, 'agent-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'gitx.bench-agent/0', when: new Date().toISOString(), at, model: MODEL, arms: ARMS, round: k, rounds: ROUNDS, walks: WALKS, walks_after: WALKS ? walkCount() : undefined, summary: S, aborted: refused || undefined, runs: rows }, null, 2) + '\n');
  console.log('\nSaved ' + path.relative(REPO, file) + '\n');
  return S;
}

/* Walks recorded so far in the kept folder, every repository key. */
function walkCount() {
  const p = path.join(WALKS, 'paths');
  try { return fs.readdirSync(p).reduce((n, d) => n + fs.readdirSync(path.join(p, d)).filter((x) => x.endsWith('.json')).length, 0); } catch (_) { return 0; }
}

/* One agent per arm answers every question in one session (--one-agent):
 * how an agent really works through a list, and the only way GitX's own
 * session memory - summaries sent once, follow-ups told, nothing sent twice
 * - is exercised. Each answer is its own section and is scored on its own. */
const ONE_PROMPT = (cases, arm, k) => [
  'Answer these ' + cases.length + ' questions about the project in the current folder, one after another.',
  '',
  ...cases.map((c, i) => 'Q' + (i + 1) + '. ' + (c.qs ? c.qs[(k - 1) % c.qs.length] : c.q)),
  '',
  'Search the project to find each answer. Its code is in the working tree, its history is in the git commit messages ' +
  '(git log, git show), and its recorded design reasoning is in .gitx/thoughts/ and .gitx/context/thoughts/ - one JSON file ' +
  'per thought; .gitx is git-ignored, so give it as a path when you search it.',
  ...(arm !== 'hand' ? ['This project also has GitX MCP tools (gitx_related and others) that search its code, commits and reasoning together.'] : []),
  '',
  'Reply with one section per question, each starting with its own line "### Q<number>", answered in a few sentences, citing your evidence: thought ids (t-...), commit hashes, and file::function names for code.'
].join('\n');

/* With --rounds, a new agent per arm each round, the next wording each
 * time; a GitX arm keeps the same walk folder (--walks), so round 2's agent
 * asks the same GitX round 1's agent taught. Rounds run one after another. */
async function oneAgent(cases, at) {
  const first = Number(eq('wording', '1'));
  const all = [];
  for (let r = 0; r < ROUNDS && !refused; r++) {
    const k = first + r;
    console.log('\n=== Round ' + (r + 1) + ' of ' + ROUNDS + (WALKS ? ', walks so far: ' + walkCount() : ''));
    all.push({ round: r + 1, wording: k, out: await oneRound(cases, at, k) });
  }
  if (ROUNDS > 1) {
    console.log('\nAcross rounds' + (WALKS ? ', GitX learning carried in ' + WALKS : '') + ':');
    for (const arm of ARMS) for (const x of all) { const o = x.out.find((y) => y.arm === arm); if (o) console.log('  round ' + x.round + ' (wording ' + x.wording + ') ' + arm.padEnd(8) + ' found ' + o.hit + '/' + cases.length + ' (reach ' + o.reach + ')  ' + o.seconds + ' s  ' + o.tool_calls + ' calls (' + o.gitx_calls + ' gitx)  ' + o.tokens + ' tok  $' + (o.cost_usd || 0).toFixed(2)); }
  }
}

async function oneRound(cases, at, k) {
  console.log('One agent per arm answers all ' + cases.length + ' questions (wording ' + k + '), ' + MODEL + ', frozen at ' + at + ': ' + ARMS.join(', ') + '\n');
  const rows = await Promise.all(ARMS.map((arm) => runOne({ id: 'all-' + arm, q: '', prompt: ONE_PROMPT(cases, arm, k), expect: {} }, arm, at)));
  const out = [];
  for (const r of rows) {
    const settledBy = new Map(r.settled_by || []);
    const parts = {};
    const re = /^#{1,4}\s*Q(\d+)\b[^\n]*\n/gm;
    const marks = [...String(r.answer || '').matchAll(re)];
    marks.forEach((m, i) => { parts[Number(m[1])] = r.answer.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : undefined); });
    const per = cases.map((c, i) => { const sc = score(c, { final: parts[i + 1] || '' }, settledBy); return { id: c.id, answered: !!parts[i + 1], hit: sc.hit, reach: sc.reach, recall: sc.recall }; });
    out.push({ arm: r.arm, model: r.model, per, hit: per.filter((x) => x.hit).length, reach: per.filter((x) => x.reach).length, answered: per.filter((x) => x.answered).length,
      seconds: r.seconds, tokens: r.tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd, turns: r.turns, tool_calls: r.tool_calls, gitx_calls: r.gitx_calls, denied: r.denied, error: r.error, answer: r.answer, calls: r.calls });
    if (isRefusal(r)) refused = r.answer;
  }
  const line = (label, f) => console.log(label.padEnd(24) + out.map((x) => String(f(x)).padEnd(18)).join(''));
  console.log(''.padEnd(24) + out.map((x) => x.arm.padEnd(18)).join(''));
  line('answered', (x) => x.answered + '/' + cases.length);
  line('answer found', (x) => x.hit + '/' + cases.length);
  line('found, or its commit', (x) => x.reach + '/' + cases.length);
  line('time', (x) => x.seconds + ' s');
  line('tool calls (gitx)', (x) => x.tool_calls + ' (' + x.gitx_calls + ')');
  line('tokens', (x) => x.tokens);
  line('output tokens', (x) => x.output_tokens);
  line('cost', (x) => '$' + (x.cost_usd || 0).toFixed(2));
  line('denied / error', (x) => x.denied + ' / ' + (x.error || '-'));
  if (refused) console.log('\nStopped by a refusal - not a result: ' + refused);
  const runs = path.join(REPO, '.gitx', 'bench', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const file = path.join(runs, 'one-agent-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'gitx.bench-one-agent/0', when: new Date().toISOString(), at, model: MODEL, arms: ARMS, wording: k, aborted: refused || undefined, runs: out }, null, 2) + '\n');
  console.log('\nSaved ' + path.relative(REPO, file));
  return out;
}

async function main() {
  const { cases, at } = loadCases();
  if (argv.includes('--one-agent')) { if (WALKS) fs.mkdirSync(WALKS, { recursive: true }); return oneAgent(cases, at); }
  if (WALKS) fs.mkdirSync(WALKS, { recursive: true });
  const all = [];
  for (let k = 1; k <= ROUNDS && !refused; k++) all.push(await runRound(k, cases, at));
  if (refused) console.log('\nRun stopped early, not a result: ' + refused);
  if (ROUNDS > 1) {
    console.log('Across rounds' + (WALKS ? ', learning carried in ' + WALKS : '') + ':');
    for (const arm of ARMS) all.forEach((S, i) => { const x = S[arm]; console.log(`  round ${i + 1} ${arm.padEnd(5)} found ${x.hit}/${x.runs} (reach ${x.reach})  ${x.seconds_median} s  ${x.calls_median} calls  ${x.tokens_median} tok  ${x.cost_usd}${WALKS ? `  learned ${x.learned}/${x.runs}` : ''}`); });
  }
}

main();
